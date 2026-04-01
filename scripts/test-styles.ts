/**
 * Test all styles with the same product image.
 * Run: cd /Users/lending/WhatsAds && npx tsx scripts/test-styles.ts
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
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

loadEnv(resolve('/Users/lending/WhatsAds/.env'));

import { processProductImage } from '../packages/ai/dist/index.js';

const TEST_IMAGE = 'https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=800&q=80';

const STYLES = ['style_with_model'];

async function main() {
  console.log('='.repeat(60));
  console.log('STYLE COMPARISON TEST — Same product, different styles');
  console.log('='.repeat(60));

  const results: Array<{ style: string; url: string; qaScore: number; durationMs: number }> = [];

  for (const style of STYLES) {
    console.log(`\n--- Testing: ${style} ---`);
    const start = Date.now();

    try {
      const result = await processProductImage({
        imageUrl: TEST_IMAGE,
        style,
        maxAttempts: 2,
      });

      const duration = Date.now() - start;
      results.push({ style, url: result.outputUrl, qaScore: result.qaScore, durationMs: duration });
      console.log(`  QA: ${result.qaScore}, Time: ${duration}ms`);
      console.log(`  URL: ${result.outputUrl}`);
      console.log(`  Prompt: ${result.adPrompt?.slice(0, 100)}...`);
    } catch (err) {
      console.error(`  FAILED: ${err}`);
      results.push({ style, url: 'FAILED', qaScore: 0, durationMs: Date.now() - start });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`${r.style.padEnd(25)} QA:${r.qaScore} Time:${Math.round(r.durationMs / 1000)}s  ${r.url}`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
