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
  style_gradient:    { r: 20,  g: 20,  b: 25,  vignetteR: 10,  vignetteG: 10,  vignetteB: 15  },
  style_lifestyle:   { r: 245, g: 238, b: 228, vignetteR: 220, vignetteG: 210, vignetteB: 195 },
  style_outdoor:     { r: 185, g: 200, b: 170, vignetteR: 150, vignetteG: 170, vignetteB: 140 },
  style_festive:     { r: 120, g: 25,  b: 25,  vignetteR: 80,  vignetteG: 15,  vignetteB: 15  },
  style_clean_white: { r: 255, g: 255, b: 255 },
  style_minimal:     { r: 250, g: 248, b: 245, vignetteR: 230, vignetteG: 228, vignetteB: 225 },
  style_model:            { r: 235, g: 230, b: 225, vignetteR: 200, vignetteG: 195, vignetteB: 185 },
  style_autmn_special: { r: 30,  g: 30,  b: 30 },
  style_video_shoot:      { r: 20,  g: 20,  b: 30 },
};

// Festive gets RANDOMIZED rich colors — deep Indian festive palette
const FESTIVE_COLOR_POOL: BackgroundConfig[] = [
  { r: 120, g: 25,  b: 25,  vignetteR: 80,  vignetteG: 15,  vignetteB: 15  },  // Deep maroon
  { r: 180, g: 120, b: 20,  vignetteR: 140, vignetteG: 90,  vignetteB: 10  },  // Saffron gold
  { r: 20,  g: 80,  b: 45,  vignetteR: 10,  vignetteG: 55,  vignetteB: 30  },  // Emerald green
  { r: 100, g: 20,  b: 60,  vignetteR: 70,  vignetteG: 10,  vignetteB: 40  },  // Royal magenta
  { r: 30,  g: 30,  b: 90,  vignetteR: 15,  vignetteG: 15,  vignetteB: 65  },  // Royal blue
];

// Studio gets RANDOMIZED bold colors — never the same boring grey
const STUDIO_COLOR_POOL: BackgroundConfig[] = [
  { r: 0,   g: 120, b: 130, vignetteR: 0,   vignetteG: 90,  vignetteB: 100 },  // Deep teal
  { r: 200, g: 100, b: 80,  vignetteR: 170, vignetteG: 75,  vignetteB: 60  },  // Warm terracotta
  { r: 180, g: 140, b: 155, vignetteR: 150, vignetteG: 110, vignetteB: 125 },  // Dusty rose
  { r: 25,  g: 40,  b: 80,  vignetteR: 15,  vignetteG: 25,  vignetteB: 60  },  // Deep navy
  { r: 80,  g: 110, b: 80,  vignetteR: 55,  vignetteG: 85,  vignetteB: 55  },  // Forest/sage green
  { r: 100, g: 45,  b: 55,  vignetteR: 70,  vignetteG: 30,  vignetteB: 40  },  // Rich burgundy
  { r: 195, g: 165, b: 110, vignetteR: 165, vignetteG: 135, vignetteB: 85  },  // Warm sand/mustard
  { r: 60,  g: 50,  b: 80,  vignetteR: 40,  vignetteG: 35,  vignetteB: 60  },  // Royal purple
];

function getBackgroundConfig(style: string): BackgroundConfig {
  if (style === 'style_studio' || style === 'style_autmn_special') {
    // Random selection from the color pool
    const idx = Math.floor(Math.random() * STUDIO_COLOR_POOL.length);
    return STUDIO_COLOR_POOL[idx]!;
  }
  if (style === 'style_festive') {
    // Random selection from the festive color pool
    const idx = Math.floor(Math.random() * FESTIVE_COLOR_POOL.length);
    return FESTIVE_COLOR_POOL[idx]!;
  }
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

  // Step 4: Resize cutout to fit within canvas (78% fill — large enough to look intentional)
  const FILL_RATIO = 0.78;
  const maxProductSize = Math.round(SIZE * FILL_RATIO);
  const resizedProduct = await sharp(enhancedCutout)
    .resize(maxProductSize, maxProductSize, { fit: 'inside' })
    .png()
    .toBuffer();

  // Step 5: Create styled background — use style-appropriate color
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

  // Step 6: Add vignette — stronger for dark styles (gradient), subtler for light styles
  const isGradientStyle = style === 'style_gradient' || style === 'style_autmn_special' || style === 'style_video_shoot';
  const vignetteOpacity = isGradientStyle ? 0.55 : (bg.vignetteR !== undefined ? 0.3 : 0.15);
  {
    const vignetteOverlay = await sharp(
      Buffer.from(
        `<svg width="${SIZE}" height="${SIZE}">
          <defs>
            <radialGradient id="v" cx="50%" cy="45%" r="65%">
              <stop offset="0%" stop-color="black" stop-opacity="0"/>
              <stop offset="60%" stop-color="black" stop-opacity="0"/>
              <stop offset="100%" stop-color="black" stop-opacity="${vignetteOpacity}"/>
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

  // Step 6b: For dark luxury (gradient) style — add a soft spotlight glow in the center
  if (isGradientStyle) {
    const spotlightOverlay = await sharp(
      Buffer.from(
        `<svg width="${SIZE}" height="${SIZE}">
          <defs>
            <radialGradient id="spot" cx="50%" cy="42%" r="45%">
              <stop offset="0%" stop-color="white" stop-opacity="0.10"/>
              <stop offset="50%" stop-color="white" stop-opacity="0.04"/>
              <stop offset="100%" stop-color="white" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <rect width="${SIZE}" height="${SIZE}" fill="url(#spot)"/>
        </svg>`
      )
    )
      .png()
      .toBuffer();

    backgroundBuffer = await sharp(backgroundBuffer)
      .composite([{ input: spotlightOverlay, blend: 'screen' }])
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  // Step 7: Add horizontal surface line — top half is "wall", bottom half is "surface"
  const surfaceLineY = Math.round(SIZE * 0.62); // Surface starts at 62% height
  const surfaceSvg = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}">
      <defs>
        <linearGradient id="surface" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="black" stop-opacity="0"/>
          <stop offset="${Math.round((surfaceLineY / SIZE) * 100)}%" stop-color="black" stop-opacity="0"/>
          <stop offset="${Math.round((surfaceLineY / SIZE) * 100) + 1}%" stop-color="black" stop-opacity="0.04"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.10"/>
        </linearGradient>
      </defs>
      <rect width="${SIZE}" height="${SIZE}" fill="url(#surface)"/>
    </svg>`
  );
  const surfaceOverlay = await sharp(surfaceSvg).png().toBuffer();
  backgroundBuffer = await sharp(backgroundBuffer)
    .composite([{ input: surfaceOverlay, blend: 'multiply' }])
    .jpeg({ quality: 95 })
    .toBuffer();

  // Step 8: Composite product centered on background (shifted slightly up for surface illusion)
  const productMeta = await sharp(resizedProduct).metadata();
  const pW = productMeta.width ?? maxProductSize;
  const pH = productMeta.height ?? maxProductSize;
  const left = Math.round((SIZE - pW) / 2);
  // Place product so its bottom edge sits just above the surface line
  const top = Math.round(surfaceLineY - pH * 0.85);

  // Step 8b: Add a soft drop shadow beneath the product cutout for all styles.
  // The shadow is a blurred dark ellipse composited UNDER the product.
  const shadowW = Math.round(pW * 0.85);
  const shadowH = Math.round(Math.min(pH * 0.12, 48));
  const shadowLeft = left + Math.round((pW - shadowW) / 2);
  const shadowTop = top + pH - Math.round(shadowH * 0.5);
  const shadowOpacity = isGradientStyle ? 0.65 : 0.40;
  const shadowBuffer = await sharp(
    Buffer.from(
      `<svg width="${shadowW}" height="${shadowH}">
        <defs>
          <radialGradient id="sh" cx="50%" cy="50%" rx="50%" ry="50%">
            <stop offset="0%" stop-color="black" stop-opacity="${shadowOpacity}"/>
            <stop offset="100%" stop-color="black" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <ellipse cx="${Math.round(shadowW / 2)}" cy="${Math.round(shadowH / 2)}" rx="${Math.round(shadowW / 2)}" ry="${Math.round(shadowH / 2)}" fill="url(#sh)"/>
      </svg>`
    )
  )
    .png()
    .blur(6)
    .toBuffer();

  const composites: { input: Buffer; left: number; top: number; blend?: string }[] = [
    { input: shadowBuffer, left: shadowLeft, top: shadowTop },
    { input: resizedProduct, left, top },
  ];

  let result = await sharp(backgroundBuffer)
    .composite(composites.map(c => ({ input: c.input, left: c.left, top: c.top, blend: 'over' as const })))
    .jpeg({ quality: 92 })
    .toBuffer();

  // Step 9: Post-process + AI label
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
