/**
 * Never-fail pipeline — guarantees a result for every paying customer.
 *
 * Tier 1: V5 Creative (LightAnalyze + Gemini, 3 min budget) — best quality
 * Tier 2: Styled Studio (BiRefNet + sharp, 90s budget) — good quality
 * Tier 3: Clean Studio (pure sharp, 2s budget) — acceptable
 * Tier 4: Enhanced Original (pure sharp, 500ms) — always works
 *
 * V4 types kept for backward compatibility with worker result shape.
 */

import { processProductImageV5, type ProcessImageV5Params } from './gemini-pipeline-v5.js';
import type { ProcessImageParams, ProcessImageResult } from './orchestrator.js';
import { downloadBuffer, uploadToStorage, postProcessFinal, addAILabel } from './fallback.js';
import { createStyledStudioShot, createCleanStudioShot, createEnhancedOriginal } from './styled-studio.js';
import type { ProductProfileV4 } from './product-analyzer-v4.js';

// ---------------------------------------------------------------------------
// Extended params for never-fail (V4 extras flow through)
// ---------------------------------------------------------------------------

export interface NeverFailParams extends ProcessImageParams {
  /** Pre-downloaded reference image buffers for multi-angle orders. */
  referenceImageBuffers?: Buffer[];
  /** Pre-computed product profile from analyzeProductV4() — kept for backward compat, not used by V5. */
  profileV4?: ProductProfileV4;
}

export interface NeverFailResult {
  outputUrl: string;
  /** Always undefined in V4 — video/story generation removed. Kept for worker compatibility. */
  storyUrl?: string;
  /** Always undefined in V4 — video/story generation removed. Kept for worker compatibility. */
  videoUrl?: string;
  cutoutUrl?: string;
  qaScore: number;
  pipeline: string;
  attempts: number;
  durationMs: number;
  tier: 1 | 2 | 3 | 4;
  tierReason?: string;
  // Fields from ProcessImageResult
  outputBuffer?: Buffer;
  inputAssessment?: any;
  rejected?: boolean;
  rejectionReason?: string;
  /** The creative direction actually used during Tier 1 (V4) generation.
   *  Passed through from ProcessImageResult so the worker can cache it per-style. */
  usedCreativeDirection?: {
    heroMoment: string;
    creativeBrief: string;
    scenePrompt: string;
    dynamicElements: string[];
    emotionalTrigger: string;
    storyScene: string;
    backgroundOnlyPrompt: string;
  };
}

export async function processImageNeverFail(
  params: NeverFailParams,
): Promise<NeverFailResult> {
  const totalStart = Date.now();
  const style = params.style ?? 'style_lifestyle';
  const category = params.productCategory ?? 'other';

  // Pre-download the raw image buffer once — reused across all tiers
  let rawBuffer: Buffer;
  try {
    rawBuffer = await downloadBuffer(params.imageUrl);
  } catch (err) {
    throw new Error(`Cannot download input image: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Tier 1: V5 Creative Pipeline (3 min budget) ──────────────────
  {
    console.info(JSON.stringify({ event: 'never_fail_tier1_start', pipeline: 'v5' }));

    const TIER1_TIMEOUT = 3 * 60 * 1000;
    let tier1Timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const v5Params: ProcessImageV5Params = {
        ...params,
        referenceImageBuffers: params.referenceImageBuffers,
      };

      const result = await Promise.race([
        processProductImageV5(v5Params),
        new Promise<never>((_, reject) => {
          tier1Timer = setTimeout(
            () => reject(new Error('Tier 1 (V5 Creative) timed out after 3 minutes')),
            TIER1_TIMEOUT,
          );
        }),
      ]);

      clearTimeout(tier1Timer!);

      console.info(JSON.stringify({
        event: 'never_fail_tier1_success',
        pipeline: 'v5',
        qaScore: result.qaScore,
        durationMs: Date.now() - totalStart,
      }));

      return {
        outputUrl: result.outputUrl,
        outputBuffer: result.outputBuffer,
        cutoutUrl: result.cutoutUrl,
        qaScore: result.qaScore,
        pipeline: result.pipeline,
        attempts: result.attempts,
        durationMs: Date.now() - totalStart,
        tier: 1,
        inputAssessment: result.inputAssessment,
        rejected: result.rejected,
        rejectionReason: result.rejectionReason,
        usedCreativeDirection: result.usedCreativeDirection,
      };
    } catch (err) {
      clearTimeout(tier1Timer!);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(JSON.stringify({
        event: 'never_fail_tier1_failed',
        reason: reason.slice(0, 200),
        durationMs: Date.now() - totalStart,
      }));
    }
  }

  // ── Tier 2: Styled Studio Shot (90s budget) ───────────────────────
  {
    console.info(JSON.stringify({ event: 'never_fail_tier2_start' }));

    const TIER2_TIMEOUT = 90_000;
    let tier2Timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const styledBuffer = await Promise.race([
        createStyledStudioShot(rawBuffer, params.imageUrl, style, category),
        new Promise<never>((_, reject) => {
          tier2Timer = setTimeout(
            () => reject(new Error('Tier 2 (Styled Studio) timed out after 90s')),
            TIER2_TIMEOUT,
          );
        }),
      ]);

      clearTimeout(tier2Timer!);

      const outputUrl = await uploadToStorage(styledBuffer, `output_tier2_${Date.now()}.jpg`);

      console.info(JSON.stringify({ event: 'never_fail_tier2_success', durationMs: Date.now() - totalStart }));
      return {
        outputUrl,
        outputBuffer: styledBuffer,
        qaScore: 50,
        pipeline: 'styled-studio',
        attempts: 0,
        durationMs: Date.now() - totalStart,
        tier: 2,
        tierReason: 'V5 creative failed, styled studio succeeded',
      };
    } catch (err) {
      clearTimeout(tier2Timer!);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(JSON.stringify({
        event: 'never_fail_tier2_failed',
        reason: reason.slice(0, 200),
        durationMs: Date.now() - totalStart,
      }));
    }
  }

  // ── Tier 3: Clean Studio Shot (2s budget, zero API calls) ─────────
  try {
    console.info(JSON.stringify({ event: 'never_fail_tier3_start' }));

    const cleanBuffer = await createCleanStudioShot(rawBuffer, style);
    const outputUrl = await uploadToStorage(cleanBuffer, `output_tier3_${Date.now()}.jpg`);

    console.info(JSON.stringify({ event: 'never_fail_tier3_success', durationMs: Date.now() - totalStart }));
    return {
      outputUrl,
      outputBuffer: cleanBuffer,
      qaScore: 30,
      pipeline: 'clean-studio',
      attempts: 0,
      durationMs: Date.now() - totalStart,
      tier: 3,
      tierReason: 'V5 creative + styled studio failed',
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({
      event: 'never_fail_tier3_failed',
      reason: reason.slice(0, 200),
      durationMs: Date.now() - totalStart,
    }));
  }

  // ── Tier 4: Enhanced Original (always works) ──────────────────────
  console.info(JSON.stringify({ event: 'never_fail_tier4_start' }));

  try {
    const enhancedBuffer = await createEnhancedOriginal(rawBuffer, style);
    const outputUrl = await uploadToStorage(enhancedBuffer, `output_tier4_${Date.now()}.jpg`);

    console.info(JSON.stringify({ event: 'never_fail_tier4_success', durationMs: Date.now() - totalStart }));
    return {
      outputUrl,
      outputBuffer: enhancedBuffer,
      qaScore: 10,
      pipeline: 'enhanced-original',
      attempts: 0,
      durationMs: Date.now() - totalStart,
      tier: 4,
      tierReason: 'All processing tiers failed — delivering enhanced original',
    };
  } catch (tier4Err) {
    console.error(JSON.stringify({
      event: 'tier4_failed',
      error: tier4Err instanceof Error ? tier4Err.message : String(tier4Err),
      durationMs: Date.now() - totalStart,
    }));

    // Absolute last resort: upload raw input buffer as-is
    try {
      const outputUrl = await uploadToStorage(rawBuffer, `output_raw_${Date.now()}.jpg`);
      console.info(JSON.stringify({ event: 'never_fail_raw_upload_success', durationMs: Date.now() - totalStart }));
      return {
        outputUrl,
        qaScore: 5,
        pipeline: 'raw-input',
        attempts: 0,
        durationMs: Date.now() - totalStart,
        tier: 4,
        tierReason: 'All processing tiers including enhanced-original failed — delivering raw input',
      };
    } catch (rawErr) {
      throw new Error(
        `All pipeline tiers including raw upload failed: ${rawErr instanceof Error ? rawErr.message : String(rawErr)}`,
      );
    }
  }
}
