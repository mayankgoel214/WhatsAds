/**
 * Head-to-head model comparison test.
 * Runs the same product images through 5 different models and saves results.
 *
 * Run: cd /Users/lending/WhatsAds && npx tsx scripts/test-model-comparison.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

// Load env
function loadEnv(envPath: string): void {
  let contents: string;
  try { contents = readFileSync(envPath, 'utf-8'); } catch { return; }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    process.env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
  }
}
loadEnv(resolve('/Users/lending/WhatsAds/.env'));

// Import fal from the AI package's node_modules (pnpm hoisting)
const { fal } = await import('/Users/lending/WhatsAds/packages/ai/node_modules/@fal-ai/client/src/index.js') as { fal: any }; // eslint-disable-line

fal.config({ credentials: process.env['FAL_KEY'] ?? '' });

// ---------------------------------------------------------------------------
// Test images — different product types
// ---------------------------------------------------------------------------

const TEST_IMAGES = [
  {
    name: 'leather-bag',
    url: 'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=800&q=80',
    category: 'bag',
    scene: 'Polished black marble surface with scattered gold dust and a single burgundy rose petal, dramatic warm spotlight with golden rim light, deep dark bokeh background, luxurious exclusive mood, professional handbag advertisement photograph',
  },
  {
    name: 'gummy-bears',
    url: 'https://images.unsplash.com/photo-1582058091505-f87a2e55a40f?w=800&q=80',
    category: 'food',
    scene: 'Bright pastel blue matte surface with scattered rainbow sprinkles and loose gummy bears on the surface, playful warm studio lighting with soft pink accents, dreamy pastel bokeh background, joyful fun mood, professional candy advertisement photograph',
  },
];

// ---------------------------------------------------------------------------
// Model runners
// ---------------------------------------------------------------------------

type ModelResult = { name: string; url: string | null; durationMs: number; error?: string; cost: string };

async function runFluxProFill(imageUrl: string, scene: string): Promise<ModelResult> {
  const start = Date.now();
  try {
    // First remove background with BiRefNet
    const bgResult = await fal.subscribe('fal-ai/birefnet/v2' as string, {
      input: { image_url: imageUrl },
      logs: false,
    }) as { data: { image?: { url: string } } };
    const cutoutUrl = bgResult.data?.image?.url;
    if (!cutoutUrl) throw new Error('No cutout URL');

    // Download cutout, create canvas + mask
    const cutoutResp = await fetch(cutoutUrl);
    const cutoutBuffer = Buffer.from(await cutoutResp.arrayBuffer());

    const sharp = (await import('sharp')).default;
    const CANVAS = 1024;
    const meta = await sharp(cutoutBuffer).metadata();
    const w = meta.width ?? 500, h = meta.height ?? 500;
    const maxDim = Math.round(CANVAS * 0.55);
    const scale = Math.min(maxDim / w, maxDim / h);
    const sw = Math.round(w * scale), sh = Math.round(h * scale);
    const resized = await sharp(cutoutBuffer).resize(sw, sh).png().toBuffer();
    const left = Math.round((CANVAS - sw) / 2);
    const top = Math.round(CANVAS * 0.5 - sh / 2);

    const canvas = await sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } } })
      .composite([{ input: resized, left, top, blend: 'over' }]).png().toBuffer();

    const alpha = await sharp(resized).ensureAlpha().extractChannel(3).blur(4).threshold(20).png().toBuffer();
    const productMask = await sharp(alpha).negate().png().toBuffer();
    const mask = await sharp({ create: { width: CANVAS, height: CANVAS, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: productMask, left, top, blend: 'multiply' }]).png().toBuffer();

    // Upload to fal storage
    const [canvasUrl, maskUrl] = await Promise.all([
      fal.storage.upload(new Blob([canvas], { type: 'image/png' })),
      fal.storage.upload(new Blob([mask], { type: 'image/png' })),
    ]);

    const safePrompt = `${scene}, photorealistic, no text, no words, no letters, no numbers, no watermarks, clean photographic image`;

    const result = await fal.subscribe('fal-ai/flux-pro/v1/fill' as string, {
      input: {
        image_url: canvasUrl,
        mask_url: maskUrl,
        prompt: safePrompt,
        image_size: 'square_hd',
        num_inference_steps: 28,
        guidance_scale: 3.5,
        strength: 0.85,
      },
      logs: false,
    }) as { data: { images?: Array<{ url: string }> } };

    const outputUrl = result.data?.images?.[0]?.url ?? null;

    // Re-composite original product on top
    if (outputUrl) {
      const outResp = await fetch(outputUrl);
      const outBuf = Buffer.from(await outResp.arrayBuffer());
      const final = await sharp(outBuf).resize(CANVAS, CANVAS, { fit: 'fill' })
        .composite([{ input: resized, left, top, blend: 'over' }])
        .jpeg({ quality: 95 }).toBuffer();
      const finalUrl = await fal.storage.upload(new Blob([final], { type: 'image/jpeg' }));
      return { name: 'Flux Pro Fill (inpaint)', url: finalUrl, durationMs: Date.now() - start, cost: '~$0.05' };
    }

    return { name: 'Flux Pro Fill (inpaint)', url: outputUrl, durationMs: Date.now() - start, cost: '~$0.05' };
  } catch (err) {
    return { name: 'Flux Pro Fill (inpaint)', url: null, durationMs: Date.now() - start, error: String(err), cost: '~$0.05' };
  }
}

async function runBriaProductShot(imageUrl: string, scene: string): Promise<ModelResult> {
  const start = Date.now();
  try {
    const result = await fal.subscribe('fal-ai/bria/product-shot' as string, {
      input: {
        image_url: imageUrl,
        scene_description: scene,
        optimize_description: true,
        num_results: 1,
        fast: true,
        placement_type: 'manual_placement',
        manual_placement_selection: 'bottom_center',
        shot_size: [1024, 1024],
      },
      logs: false,
    }) as { data: { images?: Array<{ url: string }> } };
    return { name: 'Bria Product Shot', url: result.data?.images?.[0]?.url ?? null, durationMs: Date.now() - start, cost: '~$0.04' };
  } catch (err) {
    return { name: 'Bria Product Shot', url: null, durationMs: Date.now() - start, error: String(err), cost: '~$0.04' };
  }
}

async function runFalProductPhotography(imageUrl: string): Promise<ModelResult> {
  const start = Date.now();
  try {
    const result = await fal.subscribe('fal-ai/image-apps-v2/product-photography' as string, {
      input: {
        product_image_url: imageUrl,
        aspect_ratio: { ratio: '1:1' },
      },
      logs: false,
    }) as { data: { images?: Array<{ url: string }> } };
    return { name: 'fal Product Photography', url: result.data?.images?.[0]?.url ?? null, durationMs: Date.now() - start, cost: '~$0.04' };
  } catch (err) {
    return { name: 'fal Product Photography', url: null, durationMs: Date.now() - start, error: String(err), cost: '~$0.04' };
  }
}

async function runSeedreamEdit(imageUrl: string, scene: string): Promise<ModelResult> {
  const start = Date.now();
  try {
    const prompt = `Professional product advertisement: ${scene}. Photorealistic, no text, no words, no watermarks.`;
    const result = await fal.subscribe('fal-ai/bytedance/seedream/v4.5/edit' as string, {
      input: {
        prompt,
        image_urls: [imageUrl],
        image_size: 'square_hd',
        num_images: 1,
      },
      logs: false,
    }) as { data: { images?: Array<{ url: string }> } };
    return { name: 'Seedream v4.5 Edit', url: result.data?.images?.[0]?.url ?? null, durationMs: Date.now() - start, cost: '~$0.04' };
  } catch (err) {
    return { name: 'Seedream v4.5 Edit', url: null, durationMs: Date.now() - start, error: String(err), cost: '~$0.04' };
  }
}

async function runRecraftV3(imageUrl: string, scene: string): Promise<ModelResult> {
  const start = Date.now();
  try {
    const result = await fal.subscribe('fal-ai/recraft/v3/image-to-image' as string, {
      input: {
        prompt: `${scene}. Professional product advertisement, photorealistic`,
        image_url: imageUrl,
        strength: 0.55,
        style: 'realistic_image',
        negative_prompt: 'blurry, distorted, watermark, low quality, text, words, letters',
      },
      logs: false,
    }) as { data: { images?: Array<{ url: string }> } };
    return { name: 'Recraft V3', url: result.data?.images?.[0]?.url ?? null, durationMs: Date.now() - start, cost: '~$0.04' };
  } catch (err) {
    return { name: 'Recraft V3', url: null, durationMs: Date.now() - start, error: String(err), cost: '~$0.04' };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70));
  console.log('MODEL COMPARISON TEST — 5 models × 2 product types');
  console.log('='.repeat(70));
  console.log();

  const allResults: Record<string, ModelResult[]> = {};

  for (const img of TEST_IMAGES) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`PRODUCT: ${img.name} (${img.category})`);
    console.log(`${'─'.repeat(70)}`);

    // Run all 5 models in parallel
    const results = await Promise.all([
      runFluxProFill(img.url, img.scene),
      runBriaProductShot(img.url, img.scene),
      runFalProductPhotography(img.url),
      runSeedreamEdit(img.url, img.scene),
      runRecraftV3(img.url, img.scene),
    ]);

    allResults[img.name] = results;

    for (const r of results) {
      const status = r.url ? 'OK' : 'FAILED';
      console.log(`  ${status.padEnd(7)} ${r.name.padEnd(30)} ${(r.durationMs / 1000).toFixed(1)}s  ${r.cost}  ${r.error ?? ''}`);
      if (r.url) console.log(`         ${r.url}`);
    }
  }

  // Save results summary
  console.log(`\n${'='.repeat(70)}`);
  console.log('SUMMARY — Open each URL in browser to compare quality');
  console.log('='.repeat(70));

  for (const [product, results] of Object.entries(allResults)) {
    console.log(`\n${product}:`);
    for (const r of results) {
      if (r.url) {
        console.log(`  ${r.name}: ${r.url}`);
      } else {
        console.log(`  ${r.name}: FAILED — ${r.error}`);
      }
    }
  }

  // Save to file for easy reference
  const summary = Object.entries(allResults).map(([product, results]) => ({
    product,
    results: results.map(r => ({ model: r.name, url: r.url, durationMs: r.durationMs, cost: r.cost, error: r.error })),
  }));

  mkdirSync('/Users/lending/WhatsAds/scripts/results', { recursive: true });
  writeFileSync(
    '/Users/lending/WhatsAds/scripts/results/model-comparison.json',
    JSON.stringify(summary, null, 2),
  );
  console.log('\nResults saved to scripts/results/model-comparison.json');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
