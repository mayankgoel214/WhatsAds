import { assessInputImage } from '../qa/assess.js';
import { checkOutputQuality, checkOutputWithReference } from '../qa/output-check.js';
import { preprocessImage } from './preprocess.js';
import { runKontextShot } from './kontext-shot.js';
import { runFallbackPipeline } from './fallback.js';
import { runProductShot } from './product-shot.js';
import { buildKontextPrompt, buildScenePrompt } from '../prompts/product-shot.js';
import type { InputAssessment } from '../qa/assess.js';
import type { ComparativeAssessment } from '../qa/output-check.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessImageParams {
  /** Supabase storage URL of the raw input image */
  imageUrl: string;
  /** Style ID (e.g. clean_white, festival, marble_premium) */
  style: string;
  /** Detected or declared product category */
  productCategory?: string;
  /** Parsed voice instruction text to append to scene prompt */
  voiceInstructions?: string;
  /** Maximum pipeline attempts before returning best result (default: 3) */
  maxAttempts?: number;
}

export interface ProcessImageResult {
  outputUrl: string;
  cutoutUrl?: string;
  qaScore: number;
  pipeline: 'kontext' | 'segmentation' | 'bria';
  attempts: number;
  durationMs: number;
  inputAssessment?: InputAssessment;
  rejected?: boolean;
  rejectionReason?: string;
}

// Internal structure for tracking attempt results
interface AttemptRecord {
  outputUrl: string;
  cutoutUrl?: string;
  qaScore: number;
  pipeline: 'kontext' | 'segmentation' | 'bria';
  assessment: ComparativeAssessment;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Comparative QA pass: score >= 70 AND fidelity >= 25 */
const QA_PASS_SCORE = 70;
const QA_FIDELITY_MIN = 25;

/** Lower threshold for "acceptable" results when all pipelines tried */
const QA_ACCEPTABLE_SCORE = 55;

const DEFAULT_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function downloadBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Failed to download image: ${resp.status} ${resp.statusText} — ${url}`
    );
  }
  return Buffer.from(await resp.arrayBuffer());
}

function isPassingQA(assessment: ComparativeAssessment): boolean {
  return (
    assessment.score >= QA_PASS_SCORE &&
    assessment.productFidelityScore >= QA_FIDELITY_MIN
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Orchestrate the full product image processing pipeline.
 *
 * This is the main entry point called by the background worker.
 *
 * New pipeline order (optimized for product fidelity):
 * 1. Download + preprocess (sharp)
 * 2. Assess input quality (Gemini) — reject if unusable
 * 3. Attempt 1: Flux Kontext Pro — preserves product via image editing
 * 4. Attempt 2: Segmentation pipeline — BiRefNet + Flux Pro + IC-Light
 * 5. Attempt 3: Bria Product Shot — last resort
 * 6. Return best result by comparative QA score
 *
 * All attempts use COMPARATIVE QA (input vs output) to catch product distortion.
 */
export async function processProductImage(
  params: ProcessImageParams
): Promise<ProcessImageResult> {
  const totalStart = Date.now();
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const productCategory = params.productCategory ?? 'other';
  const attempts: AttemptRecord[] = [];

  const stageTiming: Record<string, number> = {};

  // -------------------------------------------------------------------------
  // Stage 1: Download + preprocess
  // -------------------------------------------------------------------------

  const dlStart = Date.now();
  let rawBuffer: Buffer;
  try {
    rawBuffer = await downloadBuffer(params.imageUrl);
  } catch (err) {
    throw new Error(
      `Cannot download input image: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const { buffer: processedBuffer } = await preprocessImage(rawBuffer);
  stageTiming['preprocess'] = Date.now() - dlStart;

  console.info(
    JSON.stringify({
      event: 'orchestrator_preprocessed',
      style: params.style,
      productCategory,
      durationMs: stageTiming['preprocess'],
    })
  );

  // -------------------------------------------------------------------------
  // Stage 2: Input quality assessment
  // -------------------------------------------------------------------------

  const qaInStart = Date.now();
  const inputAssessment = await assessInputImage(processedBuffer);
  stageTiming['input_assessment'] = Date.now() - qaInStart;

  if (!inputAssessment.usable) {
    console.warn(
      JSON.stringify({
        event: 'orchestrator_input_rejected',
        reason: inputAssessment.rejectionReason,
        durationMs: Date.now() - totalStart,
      })
    );

    return {
      outputUrl: '',
      qaScore: 0,
      pipeline: 'kontext',
      attempts: 0,
      durationMs: Date.now() - totalStart,
      inputAssessment,
      rejected: true,
      rejectionReason: inputAssessment.rejectionReason ?? 'Image quality too low',
    };
  }

  // Use Gemini-detected category if caller didn't specify
  const resolvedCategory =
    params.productCategory ?? inputAssessment.productCategory ?? 'other';

  // Keep the preprocessed input buffer for comparative QA
  const inputBufferForQA = processedBuffer;

  // -------------------------------------------------------------------------
  // Stage 3: Attempt 1 — Flux Kontext Pro (primary)
  // -------------------------------------------------------------------------

  if (maxAttempts >= 1) {
    const attemptStart = Date.now();
    try {
      const kontextPrompt = buildKontextPrompt(
        params.style,
        resolvedCategory,
        params.voiceInstructions
      );

      const { outputUrl } = await runKontextShot({
        imageUrl: params.imageUrl,
        prompt: kontextPrompt,
      });

      const outputBuffer = await downloadBuffer(outputUrl);
      const qa = await checkOutputWithReference(inputBufferForQA, outputBuffer);

      stageTiming['attempt_1_kontext'] = Date.now() - attemptStart;

      console.info(
        JSON.stringify({
          event: 'orchestrator_attempt_1_kontext',
          qaScore: qa.score,
          fidelity: qa.productFidelity,
          fidelityScore: qa.productFidelityScore,
          pass: isPassingQA(qa),
          durationMs: stageTiming['attempt_1_kontext'],
        })
      );

      attempts.push({
        outputUrl,
        qaScore: qa.score,
        pipeline: 'kontext',
        assessment: qa,
      });

      if (isPassingQA(qa)) {
        return {
          outputUrl,
          qaScore: qa.score,
          pipeline: 'kontext',
          attempts: 1,
          durationMs: Date.now() - totalStart,
          inputAssessment,
        };
      }
    } catch (err) {
      stageTiming['attempt_1_kontext'] = Date.now() - attemptStart;
      console.error(
        JSON.stringify({
          event: 'orchestrator_attempt_1_kontext_error',
          error: err instanceof Error ? err.message : String(err),
          durationMs: stageTiming['attempt_1_kontext'],
        })
      );
    }
  }

  // -------------------------------------------------------------------------
  // Stage 4: Attempt 2 — Segmentation pipeline (BiRefNet + Flux Pro)
  // -------------------------------------------------------------------------

  if (maxAttempts >= 2) {
    const attemptStart = Date.now();
    try {
      const { outputUrl, cutoutUrl } = await runFallbackPipeline({
        imageUrl: params.imageUrl,
        style: params.style,
        productCategory: resolvedCategory,
      });

      const outputBuffer = await downloadBuffer(outputUrl);
      const qa = await checkOutputWithReference(inputBufferForQA, outputBuffer);

      stageTiming['attempt_2_segmentation'] = Date.now() - attemptStart;

      console.info(
        JSON.stringify({
          event: 'orchestrator_attempt_2_segmentation',
          qaScore: qa.score,
          fidelity: qa.productFidelity,
          fidelityScore: qa.productFidelityScore,
          pass: isPassingQA(qa),
          durationMs: stageTiming['attempt_2_segmentation'],
        })
      );

      attempts.push({
        outputUrl,
        cutoutUrl,
        qaScore: qa.score,
        pipeline: 'segmentation',
        assessment: qa,
      });

      if (isPassingQA(qa)) {
        return {
          outputUrl,
          cutoutUrl,
          qaScore: qa.score,
          pipeline: 'segmentation',
          attempts: 2,
          durationMs: Date.now() - totalStart,
          inputAssessment,
        };
      }
    } catch (err) {
      stageTiming['attempt_2_segmentation'] = Date.now() - attemptStart;
      console.error(
        JSON.stringify({
          event: 'orchestrator_attempt_2_segmentation_error',
          error: err instanceof Error ? err.message : String(err),
          durationMs: stageTiming['attempt_2_segmentation'],
        })
      );
    }
  }

  // -------------------------------------------------------------------------
  // Stage 5: Attempt 3 — Bria Product Shot (last resort)
  // -------------------------------------------------------------------------

  if (maxAttempts >= 3) {
    const attemptStart = Date.now();
    try {
      const scenePrompt = buildScenePrompt(
        params.style,
        resolvedCategory,
        params.voiceInstructions
      );

      const { outputUrl } = await runProductShot({
        imageUrl: params.imageUrl,
        scenePrompt,
      });

      const outputBuffer = await downloadBuffer(outputUrl);
      const qa = await checkOutputWithReference(inputBufferForQA, outputBuffer);

      stageTiming['attempt_3_bria'] = Date.now() - attemptStart;

      console.info(
        JSON.stringify({
          event: 'orchestrator_attempt_3_bria',
          qaScore: qa.score,
          fidelity: qa.productFidelity,
          fidelityScore: qa.productFidelityScore,
          pass: isPassingQA(qa),
          durationMs: stageTiming['attempt_3_bria'],
        })
      );

      attempts.push({
        outputUrl,
        qaScore: qa.score,
        pipeline: 'bria',
        assessment: qa,
      });

      // Return Bria regardless — it's our last option
      return {
        outputUrl,
        qaScore: qa.score,
        pipeline: 'bria',
        attempts: 3,
        durationMs: Date.now() - totalStart,
        inputAssessment,
      };
    } catch (err) {
      stageTiming['attempt_3_bria'] = Date.now() - attemptStart;
      console.error(
        JSON.stringify({
          event: 'orchestrator_attempt_3_bria_error',
          error: err instanceof Error ? err.message : String(err),
          durationMs: stageTiming['attempt_3_bria'],
        })
      );
    }
  }

  // -------------------------------------------------------------------------
  // All attempts exhausted — return the best scoring attempt
  // -------------------------------------------------------------------------

  if (attempts.length === 0) {
    throw new Error('All pipeline attempts failed with no successful output');
  }

  // Pick the best by composite score, with fidelity as tiebreaker
  const best = attempts.reduce((prev, curr) => {
    if (curr.qaScore > prev.qaScore) return curr;
    if (
      curr.qaScore === prev.qaScore &&
      curr.assessment.productFidelityScore > prev.assessment.productFidelityScore
    ) {
      return curr;
    }
    return prev;
  });

  console.warn(
    JSON.stringify({
      event: 'orchestrator_returning_best_attempt',
      bestScore: best.qaScore,
      bestPipeline: best.pipeline,
      bestFidelity: best.assessment.productFidelity,
      totalAttempts: attempts.length,
      durationMs: Date.now() - totalStart,
    })
  );

  return {
    outputUrl: best.outputUrl,
    cutoutUrl: best.cutoutUrl,
    qaScore: best.qaScore,
    pipeline: best.pipeline,
    attempts: attempts.length,
    durationMs: Date.now() - totalStart,
    inputAssessment,
  };
}
