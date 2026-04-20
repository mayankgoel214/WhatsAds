/**
 * V5 pipeline — Streamlined Gemini-first creative ad generation.
 *
 * Key differences from V4:
 *   - Light analysis: 7-field LightAnalyze replaces 42-field ProductProfileV4
 *   - Two clean tracks: COMPOSITE (branding) or DIRECT (no branding / with model)
 *   - COMPOSITE: BiRefNet + Gemini background run IN PARALLEL → sharp compositing
 *   - DIRECT: Gemini generates full ad from product image
 *   - clean_white / studio on COMPOSITE: styled studio shot instead of Gemini BG call
 *   - Simple 3-question QA instead of 20-field scoring
 *   - One retry on QA failure, then deliver whatever comes back
 *   - No Kontext, no ESRGAN, no CodeFormer, no Bria
 */

import { preprocessImage } from './preprocess.js';
import { lightAnalyze, type LightAnalysis } from './light-analyzer.js';
import { getStylePromptV5 } from './style-prompts-v5.js';
import { geminiGenerateImage } from './gemini-generate.js';
import { compositeProductOntoBackground } from './composite-engine.js';
import { simpleQA } from './simple-qa.js';
import {
  postProcessFinal,
  addAILabel,
  uploadToStorage,
  downloadBuffer,
  removeBackground,
} from './fallback.js';
import { runDeterministicChecks } from '../qa/deterministic-checks.js';
import type { ProcessImageParams, ProcessImageResult } from './orchestrator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessImageV5Params extends ProcessImageParams {
  /** Pre-downloaded reference image buffers for multi-angle orders. */
  referenceImageBuffers?: Buffer[];
}

type Track = 'COMPOSITE' | 'DIRECT';

// ---------------------------------------------------------------------------
// Helpers — Border detection (minimal inline version)
// ---------------------------------------------------------------------------

async function detectAndCropBorder(buffer: Buffer): Promise<Buffer> {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(buffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;

    if (w < 200 || h < 200) return buffer;

    const raw = await sharp(buffer).raw().toBuffer();
    const channels = meta.channels ?? 3;

    const stripW = Math.max(4, Math.round(w * 0.03));
    const stripH = Math.max(4, Math.round(h * 0.03));

    function getStripVariance(pixels: number[]): number {
      if (pixels.length === 0) return 999;
      const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;
      return pixels.reduce((sum, v) => sum + (v - mean) ** 2, 0) / pixels.length;
    }

    function sampleEdge(edge: 'top' | 'bottom' | 'left' | 'right'): number[] {
      const values: number[] = [];
      const step = 3;
      if (edge === 'top') {
        for (let y = 0; y < stripH; y += step)
          for (let x = 0; x < w; x += step) {
            const idx = (y * w + x) * channels;
            values.push(raw[idx]!, raw[idx + 1]!, raw[idx + 2]!);
          }
      } else if (edge === 'bottom') {
        for (let y = h - stripH; y < h; y += step)
          for (let x = 0; x < w; x += step) {
            const idx = (y * w + x) * channels;
            values.push(raw[idx]!, raw[idx + 1]!, raw[idx + 2]!);
          }
      } else if (edge === 'left') {
        for (let y = 0; y < h; y += step)
          for (let x = 0; x < stripW; x += step) {
            const idx = (y * w + x) * channels;
            values.push(raw[idx]!, raw[idx + 1]!, raw[idx + 2]!);
          }
      } else {
        for (let y = 0; y < h; y += step)
          for (let x = w - stripW; x < w; x += step) {
            const idx = (y * w + x) * channels;
            values.push(raw[idx]!, raw[idx + 1]!, raw[idx + 2]!);
          }
      }
      return values;
    }

    const variances = {
      top:    getStripVariance(sampleEdge('top')),
      bottom: getStripVariance(sampleEdge('bottom')),
      left:   getStripVariance(sampleEdge('left')),
      right:  getStripVariance(sampleEdge('right')),
    };

    const THRESHOLD = 150;
    const borderCount =
      (variances.top    < THRESHOLD ? 1 : 0) +
      (variances.bottom < THRESHOLD ? 1 : 0) +
      (variances.left   < THRESHOLD ? 1 : 0) +
      (variances.right  < THRESHOLD ? 1 : 0);

    if (borderCount < 2) return buffer;

    const cropTop    = variances.top    < THRESHOLD ? stripH + Math.round(h * 0.01) : 0;
    const cropBottom = variances.bottom < THRESHOLD ? stripH + Math.round(h * 0.01) : 0;
    const cropLeft   = variances.left   < THRESHOLD ? stripW + Math.round(w * 0.01) : 0;
    const cropRight  = variances.right  < THRESHOLD ? stripW + Math.round(w * 0.01) : 0;

    const newW = w - cropLeft - cropRight;
    const newH = h - cropTop - cropBottom;

    if (newW < w * 0.8 || newH < h * 0.8) return buffer;

    const cropped = await sharp(buffer)
      .extract({ left: cropLeft, top: cropTop, width: newW, height: newH })
      .resize(Math.max(newW, newH), Math.max(newW, newH), { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .jpeg({ quality: 92 })
      .toBuffer();

    console.info(JSON.stringify({
      event: 'v5_border_detected_and_cropped',
      borderCount,
      originalSize: `${w}x${h}`,
      newSize: `${newW}x${newH}`,
    }));

    return cropped;
  } catch {
    return buffer;
  }
}

// ---------------------------------------------------------------------------
// Candidate selector — deterministic, no API cost
// ---------------------------------------------------------------------------

async function selectBestCandidate(inputBuffer: Buffer, candidates: Buffer[]): Promise<Buffer> {
  if (candidates.length === 1) return candidates[0]!;

  const checks = await Promise.all(candidates.map(c => runDeterministicChecks(inputBuffer, c)));

  let bestIdx = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const check = checks[i]!;
    let score = 0;
    if (check.pass) score += 100;
    score += (check.estimatedFillPct ?? 0);
    score -= (check.quadrantSymmetry ?? 0) * 50;
    if (check.sceneNCC < 0.8) score += 20;
    if (!check.failReason?.includes('blurry')) score += 10;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  console.info(JSON.stringify({
    event: 'v5_candidate_selected',
    winner: bestIdx,
    totalCandidates: candidates.length,
    scores: checks.map((c, i) => ({ idx: i, pass: c.pass, fill: c.estimatedFillPct })),
  }));

  return candidates[bestIdx]!;
}

// ---------------------------------------------------------------------------
// Neutral canvas for COMPOSITE background generation
// ---------------------------------------------------------------------------

async function getNeutralCanvas(): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Track COMPOSITE — BiRefNet + Gemini BG run in parallel
// ---------------------------------------------------------------------------

interface CompositeTrackResult {
  compositedBuffer: Buffer;
  cutoutBuffer: Buffer | null;
}

async function runCompositeTrack(
  processedBuffer: Buffer,
  imageUrl: string,
  style: string,
  analysis: LightAnalysis,
  voiceInstructions: string | undefined,
  referenceBuffers: Buffer[] | undefined,
): Promise<CompositeTrackResult> {
  console.warn(JSON.stringify({ event: 'v5_composite_track_called_unexpectedly', style }));
  const prompt = getStylePromptV5(style, 'COMPOSITE', analysis, voiceInstructions);

  // All styles — including style_clean_white and style_studio — go through the full
  // BiRefNet + Gemini background path for proper studio-quality compositing.
  // Run BiRefNet + Gemini background generation IN PARALLEL
  const [birefnetResult, geminiResult] = await Promise.allSettled([
    // BiRefNet: background removal → cutout URL → download buffer
    removeBackground(imageUrl).then(cutoutUrl => downloadBuffer(cutoutUrl)),
    // Gemini: generate background-only scene using a neutral canvas (no product conditioning)
    getNeutralCanvas().then(neutralCanvas =>
      geminiGenerateImage({
        inputImageBuffer: neutralCanvas,
        prompt,
        temperature: 0.5,
        referenceImageBuffers: referenceBuffers,
      }).then(r => r.imageBuffer),
    ),
  ]);

  if (birefnetResult.status === 'rejected') {
    throw new Error(`BiRefNet failed: ${birefnetResult.reason instanceof Error ? birefnetResult.reason.message : String(birefnetResult.reason)}`);
  }
  if (geminiResult.status === 'rejected') {
    throw new Error(`Gemini BG generation failed: ${geminiResult.reason instanceof Error ? geminiResult.reason.message : String(geminiResult.reason)}`);
  }

  const cutoutBuffer = birefnetResult.value;
  const backgroundBuffer = geminiResult.value;

  const composited = await compositeProductOntoBackground({
    cutoutBuffer,
    backgroundBuffer,
    physicalSize: analysis.physicalSize,
    style,
  });

  return { compositedBuffer: composited, cutoutBuffer };
}

// ---------------------------------------------------------------------------
// Track DIRECT — Gemini generates full ad from product image
// ---------------------------------------------------------------------------

async function runDirectTrack(
  processedBuffer: Buffer,
  style: string,
  analysis: LightAnalysis,
  voiceInstructions: string | undefined,
  referenceBuffers: Buffer[] | undefined,
  temperatures: number[],
): Promise<Buffer> {
  const prompt = getStylePromptV5(style, 'DIRECT', analysis, voiceInstructions);

  if (temperatures.length === 1) {
    const result = await geminiGenerateImage({
      inputImageBuffer: processedBuffer,
      prompt,
      temperature: temperatures[0],
      referenceImageBuffers: referenceBuffers,
    });
    return result.imageBuffer;
  }

  // Generate multiple candidates in parallel, pick best deterministically
  const settled = await Promise.allSettled(
    temperatures.map(temp =>
      geminiGenerateImage({
        inputImageBuffer: processedBuffer,
        prompt,
        temperature: temp,
        referenceImageBuffers: referenceBuffers,
      }).then(r => r.imageBuffer),
    ),
  );

  const successful = settled
    .filter((r): r is PromiseFulfilledResult<Buffer> => r.status === 'fulfilled')
    .map(r => r.value);

  if (successful.length === 0) {
    throw new Error('All parallel Gemini generations failed');
  }

  return selectBestCandidate(processedBuffer, successful);
}

// ---------------------------------------------------------------------------
// Apply post-processing pipeline
// ---------------------------------------------------------------------------

async function applyPostProcessing(buffer: Buffer, style: string): Promise<Buffer> {
  let result = await postProcessFinal(buffer, style);
  result = await addAILabel(result);
  return result;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * V5 creative ad pipeline.
 *
 * COMPOSITE track (branded products, not with_model):
 *   BiRefNet cutout + Gemini background scene → sharp compositing
 *   For clean_white/studio: styled studio shot instead of Gemini BG
 *
 * DIRECT track (unbranded or with_model):
 *   2 parallel Gemini full-ad generations → deterministic candidate selection
 *
 * QA: 3 binary questions → one retry on failure → deliver whatever comes back
 */
export async function processProductImageV5(
  params: ProcessImageV5Params,
): Promise<ProcessImageResult> {
  const totalStart = Date.now();
  const style = params.style ?? 'style_lifestyle';
  const voiceInstructions = params.voiceInstructions;

  console.info(JSON.stringify({
    event: 'v5_pipeline_start',
    style,
    hasVoiceInstructions: !!voiceInstructions,
    hasReferences: !!(params.referenceImageBuffers?.length),
  }));

  // ── Stage 1: Download + preprocess ────────────────────────────────────────

  let rawBuffer: Buffer;
  try {
    rawBuffer = await downloadBuffer(params.imageUrl);
  } catch (err) {
    throw new Error(`v5: Cannot download input image: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { buffer: processedBuffer } = await preprocessImage(rawBuffer);
  const croppedBuffer = await detectAndCropBorder(processedBuffer);

  // ── Stage 2: Light analysis ────────────────────────────────────────────────

  let analysis: LightAnalysis;
  try {
    const allBuffersForAnalysis = [croppedBuffer, ...(params.referenceImageBuffers ?? [])];
    analysis = await lightAnalyze(allBuffersForAnalysis);
  } catch (err) {
    console.warn(JSON.stringify({
      event: 'v5_light_analysis_error',
      error: err instanceof Error ? err.message : String(err),
      fallback: 'conservative defaults',
    }));
    analysis = {
      productName: 'product',
      productCategory: params.productCategory ?? 'other',
      hasBranding: true,
      physicalSize: 'medium',
      dominantColors: ['neutral'],
      typicalSetting: 'tabletop',
      usable: true,
      itemCount: 1,
      items: ['product'],
      setDescription: null,
    };
  }

  // ── Stage 2b: Usability gate ───────────────────────────────────────────────

  if (!analysis.usable) {
    console.info(JSON.stringify({ event: 'v5_input_rejected', reason: 'lightAnalyze usable=false' }));
    // Return early — never-fail will catch us and run Tier 2
    throw new Error('v5: Input image not usable for advertising (blurry, no product, or screenshot)');
  }

  // ── Stage 3: Route to track ────────────────────────────────────────────────

  const isWithModel = style === 'style_with_model';

  // Categories where visual detail fidelity is critical — kept for documentation.
  // COMPOSITE track is currently disabled due to consistent compositing artifacts
  // (transparent ghost products, crosshatch patterns, pixelated outputs).
  // May be revisited once a proper inpainting model (e.g. Flux Pro Fill) is integrated.
  const fidelityCriticalCategories = ['jewellery', 'handicraft', 'electronics', 'candle', 'bag', 'home_goods'];

  // COMPOSITE track has been disabled due to consistent compositing artifacts.
  // DIRECT track produces more reliable results — slight product drift is acceptable.
  const track: Track = 'DIRECT';

  console.info(JSON.stringify({
    event: 'v5_track_selected',
    track,
    style,
    productName: analysis.productName,
    physicalSize: analysis.physicalSize,
    productCategory: analysis.productCategory,
    hasBranding: analysis.hasBranding,
    reason: 'DIRECT only — COMPOSITE disabled',
  }));

  // ── Stage 4: Generation loop (attempt 1, then 1 retry) ────────────────────

  let outputBuffer: Buffer | null = null;
  let cutoutBuffer: Buffer | null = null;
  let qaPass = false;
  let attempts = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    const isRetry = attempt > 1;

    console.info(JSON.stringify({ event: 'v5_generation_attempt', attempt, track }));

    let candidateBuffer: Buffer | null = null;

    try {
      // COMPOSITE track is disabled — always run DIRECT.
      // attempt 1 uses 2 parallel temps, retry uses single call
      const temperatures = isRetry ? [0.5] : [0.5, 0.7];
      candidateBuffer = await runDirectTrack(
        croppedBuffer,
        style,
        analysis,
        voiceInstructions,
        params.referenceImageBuffers,
        temperatures,
      );
    } catch (genErr) {
      console.error(JSON.stringify({
        event: 'v5_generation_error',
        attempt,
        track,
        error: genErr instanceof Error ? genErr.message : String(genErr),
      }));
      // If this was the first attempt, try once more. If retry also failed, propagate.
      if (isRetry) throw genErr;
      continue;
    }

    // Post-process — wrap in try/catch so a post-processing error doesn't discard a good image
    let postProcessed: Buffer;
    try {
      postProcessed = await applyPostProcessing(candidateBuffer, style);
    } catch (ppErr) {
      console.warn(JSON.stringify({
        event: 'v5_post_processing_error',
        attempt,
        error: ppErr instanceof Error ? ppErr.message : String(ppErr),
        fallback: 'using_unprocessed_buffer',
      }));
      postProcessed = candidateBuffer;
    }

    // QA check
    const qa = await simpleQA(croppedBuffer, postProcessed);
    console.info(JSON.stringify({
      event: 'v5_qa_result',
      attempt,
      pass: qa.pass,
      distorted: qa.distorted,
      randomText: qa.randomText,
      badAnatomy: qa.badAnatomy,
    }));

    outputBuffer = postProcessed;

    if (qa.pass) {
      qaPass = true;
      break; // QA passed — no retry needed
    }

    if (isRetry) {
      // Deliver retry result regardless — better than falling to Tier 2
      console.info(JSON.stringify({ event: 'v5_qa_failed_delivering_retry', attempt }));
    } else {
      console.info(JSON.stringify({ event: 'v5_qa_failed_retrying', attempt }));
    }
  }

  if (!outputBuffer) {
    throw new Error('v5: Generation produced no output after all attempts');
  }

  // ── Stage 5: Upload output + cutout, then return ──────────────────────────

  const outputUrl = await uploadToStorage(outputBuffer, `output_v5_${Date.now()}.jpg`);

  // COMPOSITE track is disabled — no cutout to upload (DIRECT track does not produce one)
  const cutoutUrl: string | undefined = undefined;

  const durationMs = Date.now() - totalStart;
  console.info(JSON.stringify({
    event: 'v5_pipeline_complete',
    track,
    style,
    attempts,
    qaPass,
    durationMs,
  }));

  return {
    outputUrl,
    outputBuffer,
    cutoutUrl,
    qaScore: qaPass ? 75 : 55, // Binary: pass = good score, fail-but-delivered = acceptable
    pipeline: 'primary',
    attempts,
    durationMs,
    inputAssessment: {
      usable: true,
      productCategory: analysis.productCategory,
    },
  };
}
