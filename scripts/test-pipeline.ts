/**
 * Test script: run the full AI pipeline (Kontext Pro → Segmentation → Bria)
 * against a sample product image with comparative QA.
 *
 * Run:
 *   cd /Users/lending/WhatsAds && npx tsx scripts/test-pipeline.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env with override so we get fresh values
function loadEnv(envPath: string): void {
  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf-8');
  } catch {
    console.error(`Could not read ${envPath}`);
    return;
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) process.env[key] = value; // always override
  }
}

loadEnv(resolve('/Users/lending/WhatsAds/.env'));

import { processProductImage } from '../packages/ai/dist/index.js';

// ---------------------------------------------------------------------------
// Test config — public product image
// ---------------------------------------------------------------------------

const TEST_IMAGE_URL =
  'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=800&q=80';
const TEST_STYLE = 'clean_white';
const TEST_CATEGORY = 'bag';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log('Clickkar Pipeline Test — Full Orchestrator');
  console.log('='.repeat(60));
  console.log('Image URL:', TEST_IMAGE_URL);
  console.log('Style:', TEST_STYLE);
  console.log('Category:', TEST_CATEGORY);
  console.log('FAL_KEY:', (process.env['FAL_KEY'] ?? '').slice(0, 12) + '...');
  console.log('GOOGLE_GENAI_API_KEY:', (process.env['GOOGLE_GENAI_API_KEY'] ?? '').slice(0, 12) + '...');
  console.log();

  const startMs = Date.now();

  try {
    const result = await processProductImage({
      imageUrl: TEST_IMAGE_URL,
      style: TEST_STYLE,
      productCategory: TEST_CATEGORY,
      maxAttempts: 3,
    });

    console.log('\n' + '='.repeat(60));
    console.log('PIPELINE RESULT');
    console.log('='.repeat(60));
    console.log('Pipeline used:', result.pipeline);
    console.log('QA Score:', result.qaScore);
    console.log('Attempts:', result.attempts);
    console.log('Duration:', result.durationMs, 'ms');
    console.log('Output URL:', result.outputUrl);
    if (result.cutoutUrl) {
      console.log('Cutout URL:', result.cutoutUrl);
    }
    if (result.rejected) {
      console.log('REJECTED:', result.rejectionReason);
    }
    if (result.inputAssessment) {
      console.log('Input assessment:', JSON.stringify({
        usable: result.inputAssessment.usable,
        productCategory: result.inputAssessment.productCategory,
      }));
    }

    console.log('\nSUCCESS — Total time:', Date.now() - startMs, 'ms');
    console.log('\nOpen the Output URL in your browser to inspect the result.');
  } catch (err) {
    console.error('\nPIPELINE FAILED:', err);
    process.exit(1);
  }
}

main().then(() => process.exit(0));
