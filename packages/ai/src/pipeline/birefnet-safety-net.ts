/**
 * BiRefNet Safety Net — Last-resort branding rescue.
 *
 * Fires only when unified QA detects brandingAccurate: false after all retries.
 * Strategy: keep the AI's beautiful SCENE, replace only the PRODUCT with real pixels
 * from the original photo (via BiRefNet cutout).
 *
 * The key insight: bad branding on an otherwise excellent scene is better served by
 * compositing the real product in than by re-generating from scratch.
 */

import { removeBackground, enhanceCutout, uploadToStorage } from './fallback.js';

export interface BiRefNetRescueOptions {
  style?: string;
  /** Target product scale relative to the generated product bounding box (0.8–1.2). Default 1.0. */
  productScale?: number;
}

/**
 * Rescue an AI-generated ad image by replacing the AI-rendered product with
 * the real product cutout (via BiRefNet) composited onto the generated background.
 *
 * @param originalBuffer  - Original product photo buffer (source of truth for branding)
 * @param generatedBuffer - AI-generated ad (good scene, but branding may be wrong)
 * @param options         - Style and scale options
 * @returns               - Composited buffer (real product on AI scene)
 */
export async function rescueWithBiRefNet(
  originalBuffer: Buffer,
  generatedBuffer: Buffer,
  options: BiRefNetRescueOptions = {},
): Promise<Buffer> {
  const { productScale = 1.0 } = options;
  const startMs = Date.now();

  console.info(JSON.stringify({ event: 'birefnet_rescue_start' }));

  let cutoutBuffer: Buffer;
  try {
    // Upload original to get a URL BiRefNet can access
    const tempUrl = await uploadToStorage(originalBuffer, `rescue_input_${Date.now()}.jpg`);

    // Run BiRefNet on the original photo
    const cutoutUrl = await removeBackground(tempUrl);
    const { downloadBuffer } = await import('./fallback.js');
    const rawCutout = await downloadBuffer(cutoutUrl);

    // Enhance the cutout (saturation, sharpening)
    cutoutBuffer = await enhanceCutout(rawCutout, 'other');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({ event: 'birefnet_rescue_birefnet_failed', error: msg }));
    // Non-fatal: return generated buffer as-is
    return generatedBuffer;
  }

  try {
    const sharp = (await import('sharp')).default;

    // Analyse generated image dimensions
    const genMeta = await sharp(generatedBuffer).metadata();
    const genW = genMeta.width ?? 1024;
    const genH = genMeta.height ?? 1024;

    // Estimate where the product is in the generated image.
    // Strategy: convert the generated image to grayscale, find the approximate bounding box
    // of non-background content (centre 60% region, avoid scene edges which are background).
    // We use a simple heuristic — detect the largest cluster of non-white, non-black pixels
    // in the central region. This is fast (~10ms) and zero API cost.
    const productRegion = await estimateProductRegion(generatedBuffer, genW, genH);

    // Scale the cutout to match the estimated product region size
    const cutMeta = await sharp(cutoutBuffer).metadata();
    const cutW = cutMeta.width ?? 512;
    const cutH = cutMeta.height ?? 512;

    const targetW = Math.round(productRegion.w * productScale);
    const targetH = Math.round(productRegion.h * productScale);

    // Preserve aspect ratio of the original cutout
    const scaleX = targetW / cutW;
    const scaleY = targetH / cutH;
    const scale = Math.min(scaleX, scaleY);
    const scaledW = Math.max(50, Math.round(cutW * scale));
    const scaledH = Math.max(50, Math.round(cutH * scale));

    // Resize cutout
    const resizedCutout = await sharp(cutoutBuffer)
      .resize(scaledW, scaledH, { kernel: 'lanczos3' })
      .png()
      .toBuffer();

    // Apply subtle alpha feathering (3px blur on edge of alpha channel) for natural blend
    const featheredCutout = await applyEdgeFeather(resizedCutout, 3);

    // Calculate composite position — center on estimated product region
    const compositeLeft = Math.max(0, Math.min(genW - scaledW, Math.round(productRegion.cx - scaledW / 2)));
    const compositeTop = Math.max(0, Math.min(genH - scaledH, Math.round(productRegion.cy - scaledH / 2)));

    // Composite real cutout onto the generated background
    const composited = await sharp(generatedBuffer)
      .composite([{
        input: featheredCutout,
        left: compositeLeft,
        top: compositeTop,
        blend: 'over',
      }])
      .jpeg({ quality: 93 })
      .toBuffer();

    const durationMs = Date.now() - startMs;
    console.info(JSON.stringify({
      event: 'birefnet_rescue_complete',
      durationMs,
      productRegion,
      scaledSize: `${scaledW}x${scaledH}`,
      compositePos: `${compositeLeft},${compositeTop}`,
    }));

    return composited;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({ event: 'birefnet_rescue_composite_failed', error: msg }));
    // Non-fatal: return generated buffer as-is
    return generatedBuffer;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ProductRegion {
  cx: number; // centre X
  cy: number; // centre Y
  w: number;  // estimated width
  h: number;  // estimated height
}

/**
 * Heuristically estimates the product bounding box in the generated ad.
 * Uses raw pixel analysis — no API cost (~10ms).
 *
 * Strategy: scan the central 70% of the image for non-background pixels
 * (not near-white, not near-black for dark themes). The bounding box of those
 * pixels approximates where the product was placed.
 */
async function estimateProductRegion(
  buffer: Buffer,
  w: number,
  h: number,
): Promise<ProductRegion> {
  try {
    const sharp = (await import('sharp')).default;

    // Downsample for speed — work at 256px max
    const thumbSize = 256;
    const scale = thumbSize / Math.max(w, h);
    const thumbW = Math.round(w * scale);
    const thumbH = Math.round(h * scale);

    const raw = await sharp(buffer)
      .resize(thumbW, thumbH, { kernel: 'nearest' })
      .removeAlpha()
      .raw()
      .toBuffer();

    // Restrict search to central 70% of the image
    const marginX = Math.round(thumbW * 0.15);
    const marginY = Math.round(thumbH * 0.15);

    let minX = thumbW, maxX = 0, minY = thumbH, maxY = 0;
    let found = false;

    for (let y = marginY; y < thumbH - marginY; y++) {
      for (let x = marginX; x < thumbW - marginX; x++) {
        const idx = (y * thumbW + x) * 3;
        const r = raw[idx]!;
        const g = raw[idx + 1]!;
        const b = raw[idx + 2]!;

        // Skip near-white (background) and near-black (dark backgrounds like gradient style)
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const isBackground = luma > 240 || luma < 15;

        // Also skip low-saturation greys (surface/floor in studio shots)
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;
        const isGrey = saturation < 0.08 && luma > 80 && luma < 220;

        if (!isBackground && !isGrey) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }

    if (!found || maxX <= minX || maxY <= minY) {
      // Fallback: assume product in centre third
      return {
        cx: w / 2,
        cy: h / 2,
        w: Math.round(w * 0.5),
        h: Math.round(h * 0.5),
      };
    }

    // Scale back to original resolution
    return {
      cx: Math.round(((minX + maxX) / 2) / scale),
      cy: Math.round(((minY + maxY) / 2) / scale),
      w: Math.round((maxX - minX) / scale),
      h: Math.round((maxY - minY) / scale),
    };
  } catch {
    // Fallback on any error
    return { cx: w / 2, cy: h / 2, w: Math.round(w * 0.5), h: Math.round(h * 0.5) };
  }
}

/**
 * Applies a soft alpha feather to the edges of a PNG buffer.
 * Blurs the alpha channel slightly to avoid hard cutout edges.
 */
async function applyEdgeFeather(pngBuffer: Buffer, featherPx: number): Promise<Buffer> {
  try {
    const sharp = (await import('sharp')).default;

    // Extract the alpha channel, blur it, then re-apply
    const meta = await sharp(pngBuffer).metadata();
    if (!meta.hasAlpha) return pngBuffer;

    const channels = await sharp(pngBuffer).toColorspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const { data, info } = channels;
    const { width, height } = info;

    // Blur only the alpha channel (every 4th byte in RGBA)
    // Simple box blur for speed
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      alpha[i] = data[i * 4 + 3]!;
    }

    const blurredAlpha = boxBlurAlpha(alpha, width, height, featherPx);

    // Write blurred alpha back
    const outData = Buffer.from(data);
    for (let i = 0; i < width * height; i++) {
      outData[i * 4 + 3] = blurredAlpha[i]!;
    }

    return sharp(outData, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
  } catch {
    return pngBuffer;
  }
}

function boxBlurAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const out = new Uint8Array(alpha.length);
  const r = Math.max(1, radius);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            sum += alpha[ny * width + nx]!;
            count++;
          }
        }
      }
      out[y * width + x] = Math.round(sum / count);
    }
  }

  return out;
}
