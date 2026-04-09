/**
 * Fallback tiers for the never-fail pipeline.
 *
 * Tier 2: Styled studio shot — BiRefNet cutout + colored/gradient background via sharp
 * Tier 3: Clean studio shot — pure sharp, product centered on white canvas, zero API calls
 * Tier 4: Enhanced original — preprocessed original with AI label, always works
 */

import sharp from 'sharp';
import { preprocessImage } from './preprocess.js';
import {
  postProcessFinal,
  addAILabel,
  removeBackground,
  enhanceCutout,
  downloadBuffer,
} from './fallback.js';

// ---------------------------------------------------------------------------
// Style → Background Color Mapping
// ---------------------------------------------------------------------------

interface BackgroundConfig {
  r: number;
  g: number;
  b: number;
  /** Optional gradient end color for vignette effect */
  vignetteR?: number;
  vignetteG?: number;
  vignetteB?: number;
}

const STYLE_BACKGROUNDS: Record<string, BackgroundConfig> = {
  style_gradient:    { r: 20,  g: 20,  b: 25,  vignetteR: 40,  vignetteG: 35,  vignetteB: 45  },
  style_lifestyle:   { r: 245, g: 238, b: 228, vignetteR: 220, vignetteG: 210, vignetteB: 195 },
  style_outdoor:     { r: 200, g: 210, b: 190, vignetteR: 170, vignetteG: 180, vignetteB: 160 },
  style_festive:     { r: 90,  g: 20,  b: 20,  vignetteR: 60,  vignetteG: 10,  vignetteB: 15  },
  style_studio:      { r: 240, g: 240, b: 240, vignetteR: 200, vignetteG: 200, vignetteB: 200 },
  style_clean_white: { r: 255, g: 255, b: 255 },
  style_minimal:     { r: 245, g: 245, b: 240, vignetteR: 225, vignetteG: 225, vignetteB: 220 },
  style_model:       { r: 235, g: 230, b: 225, vignetteR: 200, vignetteG: 195, vignetteB: 185 },
};

function getBackgroundConfig(style: string): BackgroundConfig {
  return STYLE_BACKGROUNDS[style] ?? { r: 240, g: 240, b: 240 };
}

// ---------------------------------------------------------------------------
// Tier 2: Styled Studio Shot
// ---------------------------------------------------------------------------

/**
 * Creates a styled studio shot using BiRefNet cutout + solid/gradient background.
 * Only external dependency: fal.ai BiRefNet (for background removal).
 * Background is generated purely via sharp — no Gemini calls.
 *
 * @param rawBuffer - Raw image buffer (already downloaded)
 * @param imageUrl - Public URL for BiRefNet (fal.ai requires a public URL)
 * @param style - Style ID for background color selection
 * @param productCategory - Product category for cutout enhancement
 * @returns Processed image buffer ready for upload
 */
export async function createStyledStudioShot(
  rawBuffer: Buffer,
  imageUrl: string,
  style: string,
  productCategory: string,
): Promise<Buffer> {
  const SIZE = 1024;

  console.info(JSON.stringify({ event: 'tier2_start', style }));
  const startMs = Date.now();

  // Step 1: Remove background via BiRefNet (needs public URL)
  const cutoutUrl = await removeBackground(imageUrl);

  // Step 2: Download cutout — use native fetch, same pattern as downloadBuffer in fallback.ts
  const cutoutBuffer = await downloadBuffer(cutoutUrl);

  // Step 3: Enhance cutout edges
  const enhancedCutout = await enhanceCutout(cutoutBuffer, productCategory);

  // Step 4: Resize cutout to fit within canvas (65% fill)
  const FILL_RATIO = 0.65;
  const maxProductSize = Math.round(SIZE * FILL_RATIO);
  const resizedProduct = await sharp(enhancedCutout)
    .resize(maxProductSize, maxProductSize, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  // Step 5: Create styled background
  const bg = getBackgroundConfig(style);
  let backgroundBuffer = await sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 3,
      background: { r: bg.r, g: bg.g, b: bg.b },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();

  // Step 6: Add subtle vignette if gradient colors are defined
  if (bg.vignetteR !== undefined) {
    const vignetteOverlay = await sharp(
      Buffer.from(
        `<svg width="${SIZE}" height="${SIZE}">
          <defs>
            <radialGradient id="v" cx="50%" cy="50%" r="70%">
              <stop offset="0%" stop-color="black" stop-opacity="0"/>
              <stop offset="100%" stop-color="black" stop-opacity="0.3"/>
            </radialGradient>
          </defs>
          <rect width="${SIZE}" height="${SIZE}" fill="url(#v)"/>
        </svg>`
      )
    )
      .png()
      .toBuffer();

    backgroundBuffer = await sharp(backgroundBuffer)
      .composite([{ input: vignetteOverlay, blend: 'multiply' }])
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  // Step 7: Composite product centered on background
  const productMeta = await sharp(resizedProduct).metadata();
  const pW = productMeta.width ?? maxProductSize;
  const pH = productMeta.height ?? maxProductSize;
  const left = Math.round((SIZE - pW) / 2);
  const top = Math.round((SIZE - pH) / 2);

  let result = await sharp(backgroundBuffer)
    .composite([{ input: resizedProduct, left, top }])
    .jpeg({ quality: 92 })
    .toBuffer();

  // Step 8: Post-process + AI label
  result = await postProcessFinal(result, style);
  result = await addAILabel(result);

  console.info(JSON.stringify({ event: 'tier2_complete', durationMs: Date.now() - startMs }));
  return result;
}

// ---------------------------------------------------------------------------
// Tier 3: Clean Studio Shot (pure sharp, zero API calls)
// ---------------------------------------------------------------------------

/**
 * Creates a clean product shot on white background.
 * Zero external API calls — pure sharp image processing.
 * Takes the preprocessed image and centers it on a white canvas.
 *
 * @param rawBuffer - Raw image buffer
 * @param style - Style ID for post-processing color grading
 * @returns Processed image buffer ready for upload
 */
export async function createCleanStudioShot(
  rawBuffer: Buffer,
  style: string,
): Promise<Buffer> {
  const SIZE = 1024;

  console.info(JSON.stringify({ event: 'tier3_start' }));
  const startMs = Date.now();

  // Step 1: Preprocess (normalize, auto-rotate, resize)
  const { buffer: processedBuffer } = await preprocessImage(rawBuffer);

  // Step 2: Resize to fit within canvas (80% fill, preserve aspect ratio)
  const resized = await sharp(processedBuffer)
    .resize(Math.round(SIZE * 0.8), Math.round(SIZE * 0.8), {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .jpeg({ quality: 95 })
    .toBuffer();

  // Step 3: Create white background canvas and composite centered
  const meta = await sharp(resized).metadata();
  const pW = meta.width ?? SIZE;
  const pH = meta.height ?? SIZE;
  const left = Math.round((SIZE - pW) / 2);
  const top = Math.round((SIZE - pH) / 2);

  const whiteCanvas = await sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();

  let result = await sharp(whiteCanvas)
    .composite([{ input: resized, left, top }])
    .jpeg({ quality: 92 })
    .toBuffer();

  // Step 4: Post-process + AI label
  result = await postProcessFinal(result, style);
  result = await addAILabel(result);

  console.info(JSON.stringify({ event: 'tier3_complete', durationMs: Date.now() - startMs }));
  return result;
}

// ---------------------------------------------------------------------------
// Tier 4: Enhanced Original (absolute floor, always works)
// ---------------------------------------------------------------------------

/**
 * Returns the original photo with preprocessing, post-processing, and AI label.
 * Zero external API calls. Cannot fail if the buffer is valid.
 * This is the absolute last resort — the user always gets something.
 *
 * @param rawBuffer - Raw image buffer
 * @param style - Style ID for post-processing color grading
 * @returns Processed image buffer ready for upload
 */
export async function createEnhancedOriginal(
  rawBuffer: Buffer,
  style: string,
): Promise<Buffer> {
  const SIZE = 1024;

  console.info(JSON.stringify({ event: 'tier4_start' }));
  const startMs = Date.now();

  // Step 1: Preprocess (normalize, auto-rotate, resize)
  const { buffer: processedBuffer } = await preprocessImage(rawBuffer);

  // Step 2: Resize to square canvas, flatten transparency to white
  let result = await sharp(processedBuffer)
    .resize(SIZE, SIZE, {
      fit: 'inside',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 92 })
    .toBuffer();

  // Step 3: Post-process (subtle enhancement) + AI label
  result = await postProcessFinal(result, style);
  result = await addAILabel(result);

  console.info(JSON.stringify({ event: 'tier4_complete', durationMs: Date.now() - startMs }));
  return result;
}
