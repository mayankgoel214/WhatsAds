/**
 * Video generation barrel — Seedance 2.0 (beta)
 *
 * Usage:
 *   import { generateProductVideo, getVideoPrompt, VIDEO_STYLES } from '@autmn/ai/video'
 *   // or via the main package index:
 *   import { generateProductVideo, getVideoPrompt } from '@autmn/ai'
 */

export {
  generateProductVideo,
  type SeedanceVideoParams,
  type SeedanceVideoResult,
} from './seedance.js';

export {
  getVideoPrompt,
  VIDEO_STYLES,
  type VideoStyle,
  type VideoPromptParams,
  type VideoPromptResult,
} from './video-style-prompts.js';
