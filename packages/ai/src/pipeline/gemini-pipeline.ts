import { preprocessImage } from './preprocess.js';
import { analyzeAndPlan, type AnalyzeAndPlanResult } from './product-analyzer.js';
import { geminiGenerateImage, geminiEditImage, geminiGenerateParallel } from './gemini-generate.js';
import { verifyAndFixBranding } from './gemini-branding-fix.js';
import { postProcessFinal, addAILabel, uploadToStorage, downloadBuffer, createStudioShot } from './fallback.js';
import { combinedQualityCheck } from '../qa/combined-qa.js';
import { runDeterministicChecks } from '../qa/deterministic-checks.js';
import { runFocusedChecks } from '../qa/focused-checks.js';
import { generateKenBurnsVideo } from '../video/ken-burns.js';
import type { ProcessImageParams, ProcessImageResult } from './orchestrator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_GENERATION_ATTEMPTS = 4; // 2 parallel + up to 2 retries

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * V2 pipeline — Gemini-first creative ad generation.
 *
 * Replaces the multi-tool V1 pipeline with a single Gemini generation
 * loop followed by iterative Gemini-based refinement for QA failures.
 *
 * Flow:
 *   Stage 1: Download + Preprocess
 *   Stage 2: Gemini Analysis (analyzeAndPlan — returns creativeBrief)
 *   Stage 3: Gemini Creative Generation (up to 2 attempts)
 *   Stage 4: Branding Fix (conditional on hasBranding)
 *   Stage 5: Light Post-processing + AI label
 *   Stage 6: QA + Iterative Refinement (up to 2 loops)
 *   Stage 7: Upload + return result
 *   Fallback: V1 pipeline (Bria/Seedream) if Gemini generation fails completely
 */
export async function processProductImageV2(
  params: ProcessImageParams,
): Promise<ProcessImageResult> {
  const totalStart = Date.now();
  let totalAttempts = 0;

  console.info(JSON.stringify({ event: 'v2_pipeline_start', style: params.style, hasVoice: !!params.voiceInstructions }));

  // -------------------------------------------------------------------------
  // Stage 1: Download + Preprocess
  // -------------------------------------------------------------------------

  console.info(JSON.stringify({ event: 'v2_stage1_start' }));

  let rawBuffer: Buffer;
  try {
    rawBuffer = await downloadBuffer(params.imageUrl);
  } catch (err) {
    throw new Error(`Cannot download input image: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { buffer: processedBuffer, enhancedBuffer } = await preprocessImage(rawBuffer);
  // Use enhanced buffer for generation (better exposure), original for QA fidelity checks
  const baseGenBuffer = enhancedBuffer ?? processedBuffer;

  // Force square input for Gemini — prevents it from generating portrait/landscape outputs
  const sharp = (await import('sharp')).default;
  const genMeta = await sharp(baseGenBuffer).metadata();
  const genW = genMeta.width ?? 1024;
  const genH = genMeta.height ?? 1024;
  let generationBuffer = baseGenBuffer;
  if (Math.abs(genW - genH) / Math.max(genW, genH) > 0.05) {
    // Pad to square (don't crop — preserve full product)
    const maxDim = Math.max(genW, genH);
    generationBuffer = await sharp(baseGenBuffer)
      .resize(maxDim, maxDim, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .jpeg({ quality: 92 })
      .toBuffer();
    console.info(JSON.stringify({ event: 'v2_squared_input', from: `${genW}x${genH}`, to: `${maxDim}x${maxDim}` }));
  }

  console.info(JSON.stringify({ event: 'v2_stage1_complete' }));

  // -------------------------------------------------------------------------
  // Stage 2: Analysis
  // -------------------------------------------------------------------------

  console.info(JSON.stringify({ event: 'v2_stage2_start' }));

  const plan = await analyzeAndPlan(processedBuffer, params.voiceInstructions, params.style).catch(
    (err): AnalyzeAndPlanResult | null => {
      console.error(JSON.stringify({
        event: 'v2_analyze_and_plan_error',
        error: err instanceof Error ? err.message : String(err),
      }));
      return null;
    },
  );

  console.info(JSON.stringify({ event: 'v2_stage2_complete', usable: plan?.usable ?? false }));

  if (!plan || !plan.usable) {
    const reason = plan?.rejectionReason ?? 'Analysis failed — image may not contain a usable product';
    console.info(JSON.stringify({ event: 'v2_input_rejected', reason }));

    const studio = await createStudioShot(params.imageUrl, params.productCategory ?? 'other');
    let output = await postProcessFinal(studio.studioBuffer, params.style);
    output = await addAILabel(output);
    const outputUrl = await uploadToStorage(output, `output_${Date.now()}.jpg`);

    return {
      outputUrl,
      qaScore: 0,
      pipeline: 'composite',
      attempts: 0,
      durationMs: Date.now() - totalStart,
      inputAssessment: { usable: false, productCategory: params.productCategory ?? 'other' },
      rejected: true,
      rejectionReason: reason,
    };
  }

  // -------------------------------------------------------------------------
  // Stage 3+4+5+6: Generate → Verify → Retry loop
  // -------------------------------------------------------------------------

  // TypeScript: plan is guaranteed non-null after the early return above
  const validPlan = plan;
  const fillPct = Math.round((validPlan.recommendedCanvasFill ?? 0.6) * 100);
  const isSmall = validPlan.productPhysicalSize === 'tiny' || validPlan.productPhysicalSize === 'small';
  const productName = validPlan.analysis.productName;

  // Build the base generation prompt — narrative framing for photorealism
  function buildGenerationPrompt(warnings?: string[]): string {
    const warningBlock = warnings?.length
      ? `\nCRITICAL CORRECTIONS FROM PREVIOUS ATTEMPT:\n${warnings.map(w => `- ${w}`).join('\n')}\n`
      : '';

    // Pick camera spec based on style
    const style = params.style ?? 'style_lifestyle';
    const cameraSpec = style === 'style_gradient'
      ? 'Shot on Sony A7 IV with 50mm f/1.2 GM lens, ISO 400, available light'
      : style === 'style_clean_white' || style === 'style_studio'
        ? 'Shot on Hasselblad X2D 100C with 90mm f/3.2 lens, ISO 64, studio strobes'
        : style === 'style_outdoor'
          ? 'Shot on Fujifilm X-T5 with 56mm f/1.2 lens, Fujifilm Classic Chrome film simulation'
          : 'Shot on Canon EOS R5 with 85mm f/1.4L IS USM lens, ISO 100';

    return `Study this product photo carefully — note the exact shape, colors, branding text, logos, and material texture. Use it ONLY as visual reference for the product's appearance.

You are an elite commercial photographer. Create a single stunning advertisement photograph of this exact product in a completely new setting. The output must be indistinguishable from a real photograph.
${warningBlock}
${validPlan.creativeBrief}

THE PHOTOGRAPH:
This is a real photograph, not a rendering or illustration. ${cameraSpec}. The image has natural depth of field with gentle bokeh in the background. Subtle film grain is visible at full resolution. Lighting has natural falloff — brighter near the key light source, gradually dimming into shadows with a 3:1 ratio. Surfaces show real-world micro-texture: visible material grain, subtle manufacturing marks, natural wear. No surface is perfectly smooth or plastic-looking. Props show authentic aging: the wood has grain variation and minor scratches, fabric has natural creases and drape.

Natural photographic imperfections are present: slight vignetting toward frame edges, dust motes visible where backlight catches the air, the faintest chromatic aberration at high-contrast edges. This looks like it was taken by a real camera in a real setting, not generated by AI.

The product fills approximately ${fillPct}% of the frame.${isSmall ? ' Tight macro-style crop — the small product dominates the entire frame.' : ''} Square 1:1 format.

Exactly one instance of this product — never duplicated or cloned. The product obeys gravity naturally — rests on a surface, leans against something, or stands on its base. The scene is completely different from the input photo. No text overlays, watermarks, or added words. No decorative objects (geometric shapes, cubes, pedestals) that don't naturally belong.${style === 'style_with_model' ? ' If a person is present: exactly 5 fingers per hand, natural anatomy, one person only.' : ''}

Before finalizing: verify no surface looks plastic or unnaturally smooth, shadows have natural gradient falloff, and the image could pass as a photograph from a professional camera.`;
  }

  let adBuffer: Buffer | null = null;
  let qaResult: Awaited<ReturnType<typeof combinedQualityCheck>> | null = null;
  let lastDeterministic: Awaited<ReturnType<typeof runDeterministicChecks>> | null = null;
  let lastFocused: Awaited<ReturnType<typeof runFocusedChecks>> | null = null;

  // Track warnings from failed attempts to feed back into prompt
  const retryWarnings: string[] = [];

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const isFirstAttempt = attempt === 0;

    console.info(JSON.stringify({
      event: 'v2_generation_attempt',
      attempt: attempt + 1,
      maxAttempts: MAX_GENERATION_ATTEMPTS,
      retryWarnings,
      productName,
    }));

    // ------- GENERATE -------
    const prompt = buildGenerationPrompt(retryWarnings.length > 0 ? retryWarnings : undefined);
    totalAttempts++;

    try {
      if (isFirstAttempt) {
        // First attempt: parallel generation (2 candidates)
        totalAttempts++; // parallel = 2
        const result = await geminiGenerateParallel({
          inputImageBuffer: generationBuffer,
          prompt,
        });
        adBuffer = result.imageBuffer;
      } else {
        // Retry: single generation
        const result = await geminiGenerateImage({
          inputImageBuffer: generationBuffer,
          prompt,
        });
        adBuffer = result.imageBuffer;
      }
      console.info(JSON.stringify({ event: 'v2_generation_success', attempt: attempt + 1 }));

      // Auto-crop to square if Gemini returned non-square output
      const outMeta = await sharp(adBuffer).metadata();
      const outW = outMeta.width ?? 0;
      const outH = outMeta.height ?? 0;
      if (outW > 0 && outH > 0 && Math.abs(outW - outH) / Math.max(outW, outH) > 0.05) {
        const minDim = Math.min(outW, outH);
        const cropLeft = Math.round((outW - minDim) / 2);
        const cropTop = Math.round((outH - minDim) / 2);
        adBuffer = await sharp(adBuffer)
          .extract({ left: cropLeft, top: cropTop, width: minDim, height: minDim })
          .jpeg({ quality: 92 })
          .toBuffer();
        console.info(JSON.stringify({ event: 'v2_auto_cropped_square', from: `${outW}x${outH}`, to: `${minDim}x${minDim}` }));
      }
    } catch (err) {
      console.warn(JSON.stringify({
        event: 'v2_generation_failed',
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      }));
      continue; // Try next attempt
    }

    // ------- LAYER 0: Deterministic Gates (<100ms) -------
    console.info(JSON.stringify({ event: 'v2_layer0_start', attempt: attempt + 1 }));

    lastDeterministic = await runDeterministicChecks(processedBuffer, adBuffer);

    console.info(JSON.stringify({
      event: 'v2_layer0_complete',
      pass: lastDeterministic.pass,
      failReason: lastDeterministic.failReason,
      sceneNCC: Math.round(lastDeterministic.sceneNCC * 1000) / 1000,
      estimatedFillPct: lastDeterministic.estimatedFillPct,
      laplacianVariance: Math.round(lastDeterministic.laplacianVariance),
      quadrantSymmetry: Math.round(lastDeterministic.quadrantSymmetry * 1000) / 1000,
      colorDistance: Math.round(lastDeterministic.colorDistance * 100) / 100,
      edgeDensityRatio: Math.round(lastDeterministic.edgeDensityRatio * 100) / 100,
      warnings: lastDeterministic.warnings,
    }));

    if (!lastDeterministic.pass) {
      // Structural failure — build specific warning for next attempt
      const fr = lastDeterministic.failReason ?? '';
      if (fr.startsWith('no_scene_change')) {
        retryWarnings.push('Previous attempt was IDENTICAL to the input photo. You MUST create a COMPLETELY DIFFERENT scene with new background, surface, and lighting.');
      } else if (fr.startsWith('product_too_small')) {
        retryWarnings.push(`Previous attempt had the product way too small (${lastDeterministic.estimatedFillPct}% fill). ZOOM IN dramatically. The product must FILL the frame.`);
      } else if (fr.startsWith('output_is_blank')) {
        retryWarnings.push('Previous attempt produced a blank/empty image. Generate a detailed scene.');
      } else if (fr.startsWith('output_blurry')) {
        retryWarnings.push('Previous attempt was blurry/smeared. Generate a SHARP, high-detail image with crisp textures.');
      } else if (fr.startsWith('likely_duplication')) {
        retryWarnings.push('Previous attempt DUPLICATED the product in a mirrored arrangement. Generate EXACTLY ONE product instance.');
      }
      adBuffer = null;
      continue; // Full regeneration
    }

    // Feed non-fatal warnings into retry context (color shift, smoothness, etc.)
    if (lastDeterministic.warnings.length > 0) {
      retryWarnings.push(...lastDeterministic.warnings);
    }

    // ------- BRANDING FIX (conditional) -------
    console.info(JSON.stringify({ event: 'v2_branding_start', attempt: attempt + 1 }));

    const preBrandingBuffer = adBuffer; // keep reference for NCC check
    const brandingResult = await verifyAndFixBranding({
      originalProductBuffer: processedBuffer,
      generatedAdBuffer: adBuffer,
      brandElements: validPlan.brandElements,
      hasBranding: validPlan.hasBranding,
      brandingConfidence: validPlan.brandingConfidence,
    });
    adBuffer = brandingResult.imageBuffer;

    // Re-check: did branding fix change the scene entirely?
    if (brandingResult.brandingFixed) {
      const brandingNCC = await runDeterministicChecks(preBrandingBuffer, adBuffer);
      if (brandingNCC.sceneNCC < 0.5) {
        // Branding fix replaced the entire scene — revert to pre-fix version
        console.warn(JSON.stringify({ event: 'v2_branding_fix_reverted', reason: 'scene_changed', ncc: brandingNCC.sceneNCC }));
        adBuffer = preBrandingBuffer;
      }
    }

    console.info(JSON.stringify({ event: 'v2_branding_complete', brandingFixed: brandingResult.brandingFixed }));

    // ------- POST-PROCESS + AI LABEL -------
    adBuffer = await postProcessFinal(adBuffer, params.style);
    adBuffer = await addAILabel(adBuffer);

    // ------- LAYER 1: Focused AI Binary Checks (~2s) -------
    console.info(JSON.stringify({ event: 'v2_layer1_start', attempt: attempt + 1 }));

    lastFocused = await runFocusedChecks(processedBuffer, adBuffer, productName);

    console.info(JSON.stringify({
      event: 'v2_layer1_complete',
      pass: lastFocused.pass,
      productCount: lastFocused.productCount,
      hasFundamentalDefect: lastFocused.hasFundamentalDefect,
      hasRandomTextOrSketch: lastFocused.hasRandomTextOrSketch,
      failReasons: lastFocused.failReasons,
    }));

    if (!lastFocused.pass) {
      // Structural failure from AI checks — build warnings for retry
      for (const reason of lastFocused.failReasons) {
        if (reason.startsWith('product_duplicated')) {
          retryWarnings.push('Previous attempt DUPLICATED the product (showed multiple copies). Generate EXACTLY ONE instance of the product. Do NOT add any second, miniature, or alternate version.');
        } else if (reason === 'product_missing') {
          retryWarnings.push('Previous attempt had the product MISSING or barely visible. The product MUST be the dominant subject.');
        } else if (reason.startsWith('fundamental_defect')) {
          retryWarnings.push(`Previous attempt had a critical defect: ${lastFocused.defectDescription ?? 'rendering artifact'}. Avoid this.`);
        } else if (reason === 'random_text_or_sketch') {
          retryWarnings.push('Previous attempt had random text or sketch elements. Output must be PURELY photorealistic with ZERO text in the scene.');
        }
      }
      adBuffer = null;
      continue; // Full regeneration
    }

    // ------- LAYER 2: AI Quality Scoring (only if Layers 0+1 passed) -------
    console.info(JSON.stringify({ event: 'v2_layer2_start', attempt: attempt + 1 }));

    qaResult = await combinedQualityCheck(processedBuffer, adBuffer, {
      checkFidelity: true, // always check fidelity — even unbranded products need color/shape match
    });

    console.info(JSON.stringify({
      event: 'v2_layer2_complete',
      pass: qaResult.pass,
      score: qaResult.score,
      issues: qaResult.issues,
    }));

    if (qaResult.pass && qaResult.score >= 65) {
      // Passed all layers — we're good!
      console.info(JSON.stringify({ event: 'v2_all_layers_passed', attempt: attempt + 1, score: qaResult.score }));
      break;
    }

    // QA score too low — try ONE surgical edit before regenerating
    if (qaResult.issues.length > 0 && attempt < MAX_GENERATION_ATTEMPTS - 1) {
      const issueText = qaResult.issues[0] ?? 'Improve overall quality';
      const fixPrompt = `You are given two images:
Image 1: The ORIGINAL product photo (reference)
Image 2: The current advertisement that needs ONE specific fix

THE SINGLE MOST IMPORTANT FIX:
${issueText}

Make ONLY this fix. Do not change the overall scene, composition, lighting, or style. Do not alter parts of the image that are already good. The product must still match Image 1 exactly. Generate the corrected image.`;

      try {
        const preEditBuffer = adBuffer; // keep for fallback
        const fixed = await geminiEditImage({
          originalImageBuffer: processedBuffer,
          generatedImageBuffer: adBuffer,
          prompt: fixPrompt,
        });
        adBuffer = await postProcessFinal(fixed.imageBuffer, params.style);
        adBuffer = await addAILabel(adBuffer);

        // Re-run Layer 0 on fixed image to make sure edit didn't break things
        const recheck = await runDeterministicChecks(processedBuffer, adBuffer);
        if (!recheck.pass) {
          console.warn(JSON.stringify({ event: 'v2_edit_broke_deterministic', failReason: recheck.failReason }));
          adBuffer = preEditBuffer; // revert to pre-edit version
          break;
        }

        // Re-run Layer 1 on fixed image
        const recheckFocused = await runFocusedChecks(processedBuffer, adBuffer, productName);
        if (!recheckFocused.pass) {
          console.warn(JSON.stringify({ event: 'v2_edit_broke_focused', failReasons: recheckFocused.failReasons }));
          adBuffer = preEditBuffer; // revert to pre-edit version
          break;
        }

        console.info(JSON.stringify({ event: 'v2_surgical_edit_applied', issue: issueText }));
        break;
      } catch {
        console.warn(JSON.stringify({ event: 'v2_surgical_edit_failed' }));
        // Accept current buffer as-is if edit fails
        break;
      }
    }

    // Score was low but no issues to fix — accept what we have
    break;
  }

  // -------------------------------------------------------------------------
  // All attempts exhausted — use gradient fallback if no valid buffer
  // -------------------------------------------------------------------------

  if (!adBuffer) {
    console.warn(JSON.stringify({ event: 'v2_all_attempts_exhausted', totalAttempts }));

    // Better fallback: studio shot with clean shadow (not the garbage V1)
    try {
      const studio = await createStudioShot(params.imageUrl, validPlan.productCategory, validPlan.recommendedCanvasFill);
      adBuffer = await postProcessFinal(studio.studioBuffer, params.style);
      adBuffer = await addAILabel(adBuffer);
      console.info(JSON.stringify({ event: 'v2_fallback_studio_shot' }));
    } catch (err) {
      console.error(JSON.stringify({ event: 'v2_fallback_failed', error: err instanceof Error ? err.message : String(err) }));
      // Last resort: return processed input
      adBuffer = await addAILabel(processedBuffer);
    }
  }

  // -------------------------------------------------------------------------
  // Stage 7: Upload and return
  // -------------------------------------------------------------------------

  console.info(JSON.stringify({ event: 'v2_stage7_start' }));

  const outputUrl = await uploadToStorage(adBuffer, `output_${Date.now()}.jpg`);

  // -------------------------------------------------------------------------
  // Stage 8: Ken Burns Video (free, ~1-2s, non-blocking on failure)
  // -------------------------------------------------------------------------

  let videoUrl: string | undefined;
  try {
    console.info(JSON.stringify({ event: 'v2_video_start' }));
    const videoResult = await generateKenBurnsVideo(adBuffer, {
      productCategory: validPlan.productCategory,
      durationSec: 5,
    });
    videoUrl = await uploadToStorage(videoResult.videoBuffer, `video_${Date.now()}.mp4`, 'video/mp4');
    console.info(JSON.stringify({
      event: 'v2_video_complete',
      effect: videoResult.effect,
      videoSizeBytes: videoResult.videoBuffer.length,
      durationMs: videoResult.durationMs,
    }));
  } catch (err) {
    // Non-fatal — image delivery works without video
    console.warn(JSON.stringify({
      event: 'v2_video_failed',
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  console.info(JSON.stringify({
    event: 'v2_pipeline_complete',
    totalAttempts,
    durationMs: Date.now() - totalStart,
    qaScore: qaResult?.score ?? 50,
    hasVideo: !!videoUrl,
    deterministicNCC: lastDeterministic?.sceneNCC ?? -1,
    deterministicFill: lastDeterministic?.estimatedFillPct ?? -1,
    laplacianVariance: lastDeterministic?.laplacianVariance ?? -1,
    quadrantSymmetry: lastDeterministic?.quadrantSymmetry ?? -1,
    colorDistance: lastDeterministic?.colorDistance ?? -1,
    edgeDensityRatio: lastDeterministic?.edgeDensityRatio ?? -1,
    focusedProductCount: lastFocused?.productCount ?? -1,
  }));

  return {
    outputUrl,
    videoUrl,
    cutoutUrl: undefined,
    qaScore: qaResult?.score ?? 50,
    pipeline: 'composite' as const,
    attempts: totalAttempts,
    durationMs: Date.now() - totalStart,
    inputAssessment: { usable: true, productCategory: validPlan.productCategory },
    productAnalysis: validPlan.analysis,
    adPrompt: validPlan.creativeBrief,
  };
}
