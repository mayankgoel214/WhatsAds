/**
 * Comprehensive pipeline test — multiple products, styles, and edge cases.
 * Validates the full refinement pipeline: Kontext + CodeFormer + ESRGAN + QA.
 *
 * Run: cd /Users/lending/Clickkar && npx tsx scripts/test-pipeline-comprehensive.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load env before any imports that need it
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

// Test cases covering different product types, styles, and edge cases
const TESTS = [
  // --- With Model (highest risk for errors) ---
  {
    name: 'dumbbells-with-model',
    url: 'https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?w=800&q=80',
    style: 'style_with_model',
    description: 'Fitness dumbbells — Indian man using them in gym',
  },
  // --- Branded product (Track A — must preserve logo) ---
  {
    name: 'headphones-branded-studio',
    url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80',
    style: 'style_studio',
    description: 'Branded headphones — Track A, logo must survive',
  },
  // --- Unbranded product (Track B) ---
  {
    name: 'candle-lifestyle',
    url: 'https://images.unsplash.com/photo-1603006905003-be475563bc59?w=800&q=80',
    style: 'style_lifestyle',
    description: 'Unbranded candle — warm lifestyle scene',
  },
  // --- Food product (tricky category) ---
  {
    name: 'coffee-dramatic',
    url: 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=800&q=80',
    style: 'style_gradient',
    description: 'Coffee beans/cup — dramatic dark style',
  },
];

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'ERROR';
  qaScore: number;
  durationSec: number;
  outputUrl: string;
  pipeline: string;
  attempts: number;
  rejected: boolean;
  error?: string;
}

async function runTest(test: typeof TESTS[0]): Promise<TestResult> {
  const startMs = Date.now();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`TEST: ${test.name}`);
  console.log(`Style: ${test.style} | Expected: ${test.description}`);
  console.log(`${'='.repeat(70)}`);

  try {
    const result = await processProductImage({
      imageUrl: test.url,
      style: test.style,
      maxAttempts: 2,
    });

    const durationSec = Math.round((Date.now() - startMs) / 1000);

    console.log(`  Status: ${result.rejected ? 'REJECTED' : 'SUCCESS'}`);
    console.log(`  QA Score: ${result.qaScore}`);
    console.log(`  Time: ${durationSec}s`);
    console.log(`  Attempts: ${result.attempts}`);
    console.log(`  Product: ${result.productAnalysis?.productName ?? 'unknown'}`);
    console.log(`  Category: ${result.productAnalysis?.category ?? 'unknown'}`);
    console.log(`  Prompt: ${result.adPrompt?.slice(0, 120) ?? 'N/A'}...`);
    console.log(`  Output: ${result.outputUrl}`);
    if (result.cutoutUrl) console.log(`  Cutout: ${result.cutoutUrl}`);
    if (result.studioShotUrl) console.log(`  Studio: ${result.studioShotUrl}`);

    if (result.rejected) {
      console.log(`  Rejection: ${result.rejectionReason}`);
    }

    return {
      name: test.name,
      status: result.rejected ? 'FAIL' : (result.qaScore >= 65 ? 'PASS' : 'FAIL'),
      qaScore: result.qaScore,
      durationSec,
      outputUrl: result.outputUrl,
      pipeline: result.pipeline,
      attempts: result.attempts,
      rejected: result.rejected ?? false,
    };
  } catch (err) {
    const durationSec = Math.round((Date.now() - startMs) / 1000);
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`  ERROR: ${errorMsg}`);
    return {
      name: test.name,
      status: 'ERROR',
      qaScore: 0,
      durationSec,
      outputUrl: '',
      pipeline: 'error',
      attempts: 0,
      rejected: false,
      error: errorMsg,
    };
  }
}

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('COMPREHENSIVE PIPELINE TEST');
  console.log(`Tests: ${TESTS.length} | Date: ${new Date().toISOString()}`);
  console.log('='.repeat(70));

  const results: TestResult[] = [];

  // Run tests sequentially to avoid overwhelming fal.ai
  for (const test of TESTS) {
    const result = await runTest(test);
    results.push(result);
  }

  // Summary
  console.log('\n\n' + '='.repeat(70));
  console.log('TEST SUMMARY');
  console.log('='.repeat(70));
  console.log('');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const errors = results.filter(r => r.status === 'ERROR').length;

  for (const r of results) {
    const icon = r.status === 'PASS' ? 'OK' : r.status === 'FAIL' ? 'FAIL' : 'ERR';
    console.log(`  [${icon}] ${r.name.padEnd(30)} QA: ${String(r.qaScore).padEnd(4)} Time: ${r.durationSec}s  Attempts: ${r.attempts}`);
    if (r.error) console.log(`        Error: ${r.error.slice(0, 80)}`);
    if (r.outputUrl) console.log(`        URL: ${r.outputUrl}`);
  }

  console.log('');
  console.log(`PASSED: ${passed}/${TESTS.length} | FAILED: ${failed} | ERRORS: ${errors}`);
  console.log(`Total time: ${results.reduce((s, r) => s + r.durationSec, 0)}s`);
  console.log('='.repeat(70));

  // Exit with error code if any test failed
  if (failed > 0 || errors > 0) {
    process.exit(1);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
