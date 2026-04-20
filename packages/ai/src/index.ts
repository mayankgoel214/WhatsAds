/**
 * @autmn/ai — Core AI pipeline package.
 *
 * Processes product photos into professional images for Indian SMB sellers
 * using a smart AI-driven approach:
 *   - Product Analysis: Gemini 2.5 Flash deep product understanding
 *   - Ad Prompt: Gemini generates tailored scene descriptions
 *   - Pipeline: BiRefNet cutout → Flux Pro background → sharp compositing
 *   - Product pixels are NEVER regenerated — only the background is AI-generated
 *   - QA: Gemini comparative check (input vs output fidelity)
 *   - Transcription: Groq Whisper Turbo with Sarvam AI fallback
 *   - Instruction parsing: Gemini 2.5 Flash Lite
 */

// ---------------------------------------------------------------------------
// Pipeline — main entry point
// ---------------------------------------------------------------------------

export {
  processProductImage,
  type ProcessImageParams,
  type ProcessImageResult,
} from './pipeline/orchestrator.js';

// V2 Pipeline — Gemini-first approach
export {
  processProductImageV2,
} from './pipeline/gemini-pipeline.js';

// V3 Pipeline — World-class creative ads (story-first, dynamic elements)
export {
  processProductImageV3,
} from './pipeline/gemini-pipeline-v3.js';

// V4 Pipeline — Multi-reference, unified QA, BiRefNet safety-net
export {
  processProductImageV4,
  type ProcessImageV4Params,
  generateCreativeDirection,
} from './pipeline/gemini-pipeline-v4.js';

// V5 Pipeline — LightAnalyze + Gemini COMPOSITE/DIRECT, 3 min budget
export {
  processProductImageV5,
  type ProcessImageV5Params,
} from './pipeline/gemini-pipeline-v5.js';

// Never-fail pipeline — production entry point
export {
  processImageNeverFail,
  type NeverFailResult,
  type NeverFailParams,
} from './pipeline/never-fail-pipeline.js';

// Fallback tiers (for testing/direct use)
export {
  createStyledStudioShot,
  createCleanStudioShot,
  createEnhancedOriginal,
} from './pipeline/styled-studio.js';

// Story format (9:16) generation + ad text overlay
export {
  generateStoryFormat,
  addAdOverlay,
  downloadBuffer,
} from './pipeline/fallback.js';

// ---------------------------------------------------------------------------
// Product Analysis
// ---------------------------------------------------------------------------

export {
  analyzeAndPlan,
  analyzeProduct,
  generateAdPrompt,
  type ProductAnalysis,
  type AnalyzeAndPlanResult,
} from './pipeline/product-analyzer.js';

// Multi-angle product analyzer (1-5 photos → unified ProductProfile)
export {
  analyzeMultiAngleProduct,
  type MultiAngleProductProfile,
} from './pipeline/multi-angle-analyzer.js';

// V3 product analyzer (used as fallback when V4 times out)
export { analyzeAndPlanV3 } from './pipeline/product-analyzer-v3.js';

// V4 product analyzer — single Gemini call, all photos, full creative + multi-angle output
export {
  analyzeProductV4,
  type ProductProfileV4,
  ProductProfileV4Schema,
} from './pipeline/product-analyzer-v4.js';

// ---------------------------------------------------------------------------
// QA
// ---------------------------------------------------------------------------

export {
  combinedQualityCheck,
  type CombinedQAResult,
} from './qa/combined-qa.js';

export {
  runDeterministicChecks,
  type DeterministicResult,
} from './qa/deterministic-checks.js';

export {
  runFocusedChecks,
  type FocusedCheckResult,
} from './qa/focused-checks.js';

export {
  unifiedQualityCheck,
  type UnifiedQAResult,
  type UnifiedQAOptions,
} from './qa/unified-qa.js';

export {
  rescueWithBiRefNet,
  type BiRefNetRescueOptions,
} from './pipeline/birefnet-safety-net.js';

// V5 support modules
export {
  lightAnalyze,
  type LightAnalysis,
} from './pipeline/light-analyzer.js';

export {
  simpleQA,
  type SimpleQAResult,
} from './pipeline/simple-qa.js';

export {
  getStylePromptV5,
} from './pipeline/style-prompts-v5.js';

export {
  compositeProductOntoBackground,
  type CompositeOptions,
} from './pipeline/composite-engine.js';

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

export {
  transcribeVoiceNote,
  transcribeWithGroq,
  transcribeWithSarvam,
  type TranscriptionResult,
} from './transcription/index.js';

// ---------------------------------------------------------------------------
// Instruction parsing
// ---------------------------------------------------------------------------

export {
  parseEditInstructions,
  type EditCommand,
} from './parsing/instructions.js';

export {
  parsePerPhotoInstructions,
  type InstructionParseResult,
} from './instructions/parse-per-photo.js';

export {
  parsePerStyleInstructions,
  type PerStyleInstructionResult,
} from './instructions/parse-per-style.js';

// ---------------------------------------------------------------------------
// Scene prompt builder
// ---------------------------------------------------------------------------

export {
  buildScenePrompt,
  buildKontextPrompt,
  type StyleId,
  type ProductCategory,
} from './prompts/product-shot.js';

// ---------------------------------------------------------------------------
// Pre-processing
// ---------------------------------------------------------------------------

export {
  preprocessImage,
  type ImageMetadata,
} from './pipeline/preprocess.js';

// ---------------------------------------------------------------------------
// Video generation
// ---------------------------------------------------------------------------

// generateMultiShotVideo still needed by worker's style_video_shoot path.
export {
  generateMultiShotVideo,
  type MultiShotVideoOptions,
  type MultiShotVideoResult,
} from './video/multi-shot-video.js';

// Remaining video exports kept but not actively used — commenting out for now
// to reduce surface area while image quality work continues.
// export { generateKenBurnsVideo } from './video/ken-burns.js';
// export { generateCinematicVideo } from './video/cinematic-video.js';
// export { generateCTAFrame } from './video/cta-frame.js';
// export { getMusicCategory, generateSilentTrack } from './video/music.js';
// export { generateVeoVideo } from './video/veo-video.js';
// export { generateLyriaMusic, getLyriaPrompt } from './video/lyria-music.js';
