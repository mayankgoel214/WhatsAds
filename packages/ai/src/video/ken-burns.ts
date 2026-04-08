import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, readFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KenBurnsEffect =
  | 'zoom_in'       // Slow zoom into center
  | 'zoom_out'      // Start zoomed, pull out
  | 'pan_right'     // Slow pan left to right
  | 'pan_left'      // Slow pan right to left
  | 'zoom_in_top'   // Zoom into top third (good for products with detail at top)
  | 'zoom_in_bottom'; // Zoom into bottom third

export interface KenBurnsOptions {
  effect?: KenBurnsEffect;
  durationSec?: number;   // default 5
  fps?: number;           // default 24
  outputSize?: number;    // default 720 (720x720 square)
}

export interface KenBurnsResult {
  videoBuffer: Buffer;
  durationMs: number;
  effect: KenBurnsEffect;
}

// ---------------------------------------------------------------------------
// Effect definitions — zoompan filter expressions
// ---------------------------------------------------------------------------

function getZoompanFilter(
  effect: KenBurnsEffect,
  durationSec: number,
  fps: number,
  outputSize: number,
): string {
  const totalFrames = durationSec * fps;

  // zoompan filter: z=zoom level, x/y=pan position, d=frames per input image, s=output size
  // zoom starts at 1.0 (or higher) and changes per frame
  // 'on' means number of frames this input image is shown

  switch (effect) {
    case 'zoom_in':
      // Slow zoom from 1.0x to 1.3x, centered
      return `zoompan=z='1+0.3*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outputSize}x${outputSize}:fps=${fps}`;

    case 'zoom_out':
      // Start at 1.3x, zoom out to 1.0x
      return `zoompan=z='1.3-0.3*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outputSize}x${outputSize}:fps=${fps}`;

    case 'pan_right':
      // Zoom 1.2x, pan from left to right
      return `zoompan=z='1.2':x='(iw/zoom-iw)*on/${totalFrames}+iw/2-iw/zoom/2-((iw/zoom-iw)/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outputSize}x${outputSize}:fps=${fps}`;

    case 'pan_left':
      // Zoom 1.2x, pan from right to left
      return `zoompan=z='1.2':x='(iw-iw/zoom)*(1-on/${totalFrames})+iw/2-iw/zoom/2-((iw-iw/zoom)/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outputSize}x${outputSize}:fps=${fps}`;

    case 'zoom_in_top':
      // Zoom into top-center (product cap/lid area)
      return `zoompan=z='1+0.4*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih*0.25-(ih/zoom/2)+ih*0.25*on/${totalFrames}':d=${totalFrames}:s=${outputSize}x${outputSize}:fps=${fps}`;

    case 'zoom_in_bottom':
      // Zoom into bottom-center
      return `zoompan=z='1+0.4*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih*0.6-(ih/zoom/2)':d=${totalFrames}:s=${outputSize}x${outputSize}:fps=${fps}`;

    default:
      return `zoompan=z='1+0.3*on/${totalFrames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${outputSize}x${outputSize}:fps=${fps}`;
  }
}

// ---------------------------------------------------------------------------
// Pick best effect based on product type
// ---------------------------------------------------------------------------

function pickEffect(productCategory?: string): KenBurnsEffect {
  // Vary the effect based on category for diversity
  switch (productCategory) {
    case 'jewellery':
    case 'skincare':
      return 'zoom_in'; // Zoom to show detail
    case 'garment':
    case 'bag':
      return 'zoom_out'; // Reveal full product
    case 'food':
    case 'electronics':
      return 'zoom_in_bottom'; // Focus on branding area
    default:
      // Random between zoom_in and zoom_out for variety
      return Math.random() > 0.5 ? 'zoom_in' : 'zoom_out';
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a Ken Burns video from a static ad image.
 * Uses FFmpeg zoompan filter — zero AI cost, ~1-2s generation time.
 *
 * Input: The finished ad image buffer (JPEG)
 * Output: MP4 video buffer (H.264, AAC silent, 720x720)
 */
export async function generateKenBurnsVideo(
  imageBuffer: Buffer,
  options: KenBurnsOptions & { productCategory?: string } = {},
): Promise<KenBurnsResult> {
  const startMs = Date.now();

  const effect = options.effect ?? pickEffect(options.productCategory);
  const durationSec = options.durationSec ?? 5;
  const fps = options.fps ?? 24;
  const outputSize = options.outputSize ?? 720;

  // Prepare input: ensure image is large enough for zoompan (2x output for smooth zoom)
  const inputSize = outputSize * 2;
  const preparedImage = await sharp(imageBuffer)
    .resize(inputSize, inputSize, { fit: 'cover' })
    .jpeg({ quality: 95 })
    .toBuffer();

  // Write to temp files (FFmpeg needs file paths)
  const id = randomUUID().slice(0, 8);
  const tmpInput = join(tmpdir(), `kb_in_${id}.jpg`);
  const tmpOutput = join(tmpdir(), `kb_out_${id}.mp4`);

  await writeFile(tmpInput, preparedImage);

  const zoompanFilter = getZoompanFilter(effect, durationSec, fps, outputSize);

  // Run FFmpeg
  await new Promise<void>((resolve, reject) => {
    ffmpeg(tmpInput)
      .inputOptions(['-loop', '1']) // Loop single image
      .videoFilter(zoompanFilter)
      .outputOptions([
        '-c:v', 'libx264',
        '-t', String(durationSec),
        '-pix_fmt', 'yuv420p',
        '-preset', 'fast',
        '-crf', '23',
        '-movflags', '+faststart', // Streaming-friendly
        '-an', // No audio
      ])
      .output(tmpOutput)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
      .run();
  });

  // Read output and clean up
  const videoBuffer = await readFile(tmpOutput);

  // Clean up temp files (non-blocking)
  unlink(tmpInput).catch(() => {});
  unlink(tmpOutput).catch(() => {});

  const durationMs = Date.now() - startMs;
  console.info(JSON.stringify({
    event: 'ken_burns_complete',
    effect,
    durationSec,
    fps,
    outputSize,
    videoSizeBytes: videoBuffer.length,
    generationMs: durationMs,
  }));

  return { videoBuffer, durationMs, effect };
}
