/**
 * Thorough "With Model" test across different product categories.
 * Run: cd /Users/lending/Clickkar && npx tsx scripts/test-with-model.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

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

loadEnv(resolve('/Users/lending/Clickkar/.env'));

import { processProductImage } from '../packages/ai/dist/index.js';

// Different product categories to test
const TESTS = [
  {
    name: 'headphones-v3',
    url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80',
    description: 'Headphones — clothed Indian man wearing them, clean background',
  },
  {
    name: 'watch',
    url: 'https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=800&q=80',
    description: 'Watch — Indian person wearing it on wrist',
  },
];

async function main() {
  console.log('='.repeat(70));
  console.log('"WITH MODEL" COMPREHENSIVE TEST — 3 product categories');
  console.log('='.repeat(70));

  for (const test of TESTS) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`PRODUCT: ${test.name}`);
    console.log(`Expected: ${test.description}`);
    console.log(`${'─'.repeat(70)}`);

    const startMs = Date.now();

    try {
      const result = await processProductImage({
        imageUrl: test.url,
        style: 'style_with_model',
        maxAttempts: 2,
      });

      const duration = Math.round((Date.now() - startMs) / 1000);

      console.log(`  Status: ${result.rejected ? 'REJECTED' : 'SUCCESS'}`);
      console.log(`  QA Score: ${result.qaScore}`);
      console.log(`  Time: ${duration}s`);
      console.log(`  Product: ${result.productAnalysis?.productName ?? 'unknown'}`);
      console.log(`  Category: ${result.productAnalysis?.category ?? 'unknown'}`);
      console.log(`  Prompt: ${result.adPrompt?.slice(0, 120)}...`);
      console.log(`  Output: ${result.outputUrl}`);

      if (result.rejected) {
        console.log(`  Rejection: ${result.rejectionReason}`);
      }
    } catch (err) {
      console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('TEST COMPLETE — Open each Output URL in browser to inspect');
  console.log('='.repeat(70));
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
