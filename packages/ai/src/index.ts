/**
 * @autmn/ai — Core AI pipeline package.
 *
 * Processes product photos into professional images for Indian SMB sellers
 * using a smart AI-driven approach:
 *   - Product Analysis: Gemini 2.5 Flash deep product understanding
 *   - Pipeline: V5 Gemini image generation with QA gate
 *   - Never-fail orchestrator: NB2 → OpenAI fallback chain
 *   - QA: Gemini comparative check (input vs output fidelity)
 *   - Transcription: Groq Whisper Turbo with Sarvam AI fallback
 *   - Instruction parsing: Gemini 2.5 Flash Lite
 */

// ---------------------------------------------------------------------------
// Pipeline — main entry point (production)
// ---------------------------------------------------------------------------

// Never-fail pipeline — production entry point
export {
  processImageNeverFail,
  type NeverFailResult,
  type NeverFailParams,
} from './pipeline/never-fail-pipeline.js';

// Shared pipeline types (extracted from orchestrator.ts V1)
export type { ProcessImageParams, ProcessImageResult } from './pipeline/_common/types.js';

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

// V5 support modules
export {
  lightAnalyze,
  type LightAnalysis,
} from './pipeline/light-analyzer.js';

export {
  getStylePromptV5,
  buildSkinnyPrompt,
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
// Pre-processing
// ---------------------------------------------------------------------------

export {
  preprocessImage,
  type ImageMetadata,
} from './pipeline/preprocess.js';

// ---------------------------------------------------------------------------
// Shared image I/O helpers (used by worker)
// ---------------------------------------------------------------------------

export {
  downloadBuffer,
} from './pipeline/fallback.js';
