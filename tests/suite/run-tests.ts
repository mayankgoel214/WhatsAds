/**
 * Autmn Test Suite — Main Runner
 * Usage: pnpm test [-- --manifest=path] [-- --product=slug] [-- --style=id] [-- --runs=N] [-- --dry-run]
 */

import { readFile, writeFile, appendFile, mkdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Manifest, Product, TestCombination, TestResult, GradeEntry } from './lib/types.js';
import { generateViaAdminApi } from './lib/admin-client.js';
import { RunLogger } from './lib/logger.js';
import { parallelExecute } from './lib/concurrency.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): {
  manifest: string;
  product: string | null;
  style: string | null;
  runsOverride: number | null;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let manifest = 'manifest.json';
  let product: string | null = null;
  let style: string | null = null;
  let runsOverride: number | null = null;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--manifest=')) manifest = arg.slice('--manifest='.length);
    else if (arg.startsWith('--product=')) product = arg.slice('--product='.length);
    else if (arg.startsWith('--style=')) style = arg.slice('--style='.length);
    else if (arg.startsWith('--runs=')) runsOverride = parseInt(arg.slice('--runs='.length), 10);
    else if (arg === '--dry-run') dryRun = true;
  }

  return { manifest, product, style, runsOverride, dryRun };
}

// ---------------------------------------------------------------------------
// Combination builder
// ---------------------------------------------------------------------------

function buildCombinations(
  manifest: Manifest,
  opts: { product: string | null; style: string | null; runsOverride: number | null },
): TestCombination[] {
  const combos: TestCombination[] = [];
  const runsPerCombo = opts.runsOverride ?? manifest.config.runsPerCombo;

  for (const product of manifest.products) {
    // Product filter
    if (opts.product && product.slug !== opts.product) continue;

    for (const triplet of product.styleTriplets) {
      if (triplet.length !== 3) {
        console.warn(`[WARN] Product "${product.slug}" has a triplet with ${triplet.length} styles (expected 3). Skipping.`);
        continue;
      }

      // Style filter — include triplet only if it contains the requested style
      if (opts.style && !triplet.includes(opts.style)) continue;

      for (const instructionCase of product.instructions) {
        for (let run = 1; run <= runsPerCombo; run++) {
          combos.push({
            productSlug: product.slug,
            stylesTriplet: triplet,
            instructionCase,
            runNumber: run,
          });
        }
      }
    }
  }
  return combos;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

const RESULTS_CSV_HEADERS = [
  'product', 'style', 'instructionCase', 'runNumber', 'timestamp',
  'qaScore', 'tier', 'pipeline', 'durationMs',
  'outputLocalPath', 'outputUrl',
  'productName', 'productCategory', 'itemCount', 'setDescription', 'analyzerFellBack',
  'error', 'errorAttempts',
].join(',');

const GRADES_CSV_HEADERS = [
  'product', 'style', 'instructionCase', 'runNumber',
  'productAccuracy', 'brandPreservation', 'styleMatch', 'adQuality', 'creativity',
  'weightedTotal', 'letterGrade', 'failureModes', 'observations',
].join(',');

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Wrap in quotes if contains comma, newline, or quote
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function resultsToCsvRow(r: TestResult): string {
  return [
    r.product,
    r.style,
    r.instructionCase,
    r.runNumber,
    r.timestamp,
    r.qaScore,
    r.tier,
    r.pipeline,
    r.durationMs,
    r.outputLocalPath,
    r.outputUrl,
    r.analysis?.productName ?? '',
    r.analysis?.productCategory ?? '',
    r.analysis?.itemCount ?? '',
    r.analysis?.setDescription ?? '',
    r.analysis?.analyzerFellBack ?? '',
    r.error,
    r.errorAttempts,
  ].map(escapeCsv).join(',');
}

function gradeTemplateCsvRow(r: TestResult): string {
  return [
    r.product,
    r.style,
    r.instructionCase,
    r.runNumber,
    '', // productAccuracy
    '', // brandPreservation
    '', // styleMatch
    '', // adQuality
    '', // creativity
    '', // weightedTotal (computed by report generator)
    '', // letterGrade (computed by report generator)
    '', // failureModes
    '', // observations
  ].map(escapeCsv).join(',');
}

// ---------------------------------------------------------------------------
// Image downloader
// ---------------------------------------------------------------------------

async function downloadImage(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download image: ${resp.status} ${url}`);
  if (!resp.body) throw new Error('No response body for image download');
  const writer = createWriteStream(destPath);
  await pipeline(Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]), writer);
}

// ---------------------------------------------------------------------------
// Single test executor
// ---------------------------------------------------------------------------

async function runSingleTest(params: {
  combo: TestCombination;
  product: Product;
  manifest: Manifest;
  runDir: string;
  outputsDir: string;
  logger: RunLogger;
  retries: number;
}): Promise<TestResult[]> {
  const { combo, product, manifest, runDir, outputsDir, logger, retries } = params;
  const { config } = manifest;

  const photoPaths = product.photos.map(
    f => resolve(__dirname, product.photoDir, f),
  );

  let lastError: string | null = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts = attempt + 1;
    try {
      await logger.info('test_attempt_start', {
        product: combo.productSlug,
        styles: combo.stylesTriplet,
        instructionCase: combo.instructionCase.case,
        runNumber: combo.runNumber,
        attempt: attempts,
      });

      const apiResult = await generateViaAdminApi({
        adminUrl: config.adminUrl,
        adminKey: config.adminKey,
        photoPaths,
        styles: combo.stylesTriplet,
        instructions: combo.instructionCase.text,
        timeoutMs: 300_000, // 5 min to be safe
      });

      const timestamp = new Date().toISOString();
      const results: TestResult[] = [];

      for (const styleResult of apiResult.results) {
        const safeStyle = styleResult.style.replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeInstr = combo.instructionCase.case.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `${combo.productSlug}_${safeStyle}_${safeInstr}_run${combo.runNumber}.jpg`;
        const destPath = join(outputsDir, filename);

        let outputLocalPath: string | null = null;
        if (styleResult.outputUrl && !styleResult.error) {
          try {
            await downloadImage(styleResult.outputUrl, destPath);
            outputLocalPath = join('outputs', filename); // relative to runDir
          } catch (dlErr) {
            await logger.warn('image_download_failed', {
              style: styleResult.style,
              url: styleResult.outputUrl,
              error: dlErr instanceof Error ? dlErr.message : String(dlErr),
            });
          }
        }

        const result: TestResult = {
          product: combo.productSlug,
          style: styleResult.style,
          instructionCase: combo.instructionCase.case,
          runNumber: combo.runNumber,
          timestamp,
          qaScore: styleResult.qaScore ?? null,
          tier: styleResult.tier ?? null,
          pipeline: styleResult.pipeline ?? null,
          durationMs: styleResult.durationMs ?? null,
          outputLocalPath,
          outputUrl: styleResult.outputUrl ?? null,
          prompt: styleResult.prompt ?? null,
          analysis: apiResult.analysis ?? null,
          error: styleResult.error ?? null,
          errorAttempts: attempt,
        };

        results.push(result);

        await logger.info('test_style_done', {
          product: combo.productSlug,
          style: styleResult.style,
          qaScore: result.qaScore,
          tier: result.tier,
          durationMs: result.durationMs,
          error: result.error,
        });
      }

      return results;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await logger.warn('test_attempt_failed', {
        product: combo.productSlug,
        styles: combo.stylesTriplet,
        attempt: attempts,
        error: lastError,
        willRetry: attempt < retries,
      });
      if (attempt < retries) {
        // Brief backoff before retry
        await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
      }
    }
  }

  // All attempts exhausted — return error rows for each style in the triplet
  const timestamp = new Date().toISOString();
  return combo.stylesTriplet.map(style => ({
    product: combo.productSlug,
    style,
    instructionCase: combo.instructionCase.case,
    runNumber: combo.runNumber,
    timestamp,
    qaScore: null,
    tier: null,
    pipeline: null,
    durationMs: null,
    outputLocalPath: null,
    outputUrl: null,
    prompt: null,
    analysis: null,
    error: lastError,
    errorAttempts: attempts,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  // Load manifest
  const manifestPath = resolve(__dirname, opts.manifest);
  let manifest: Manifest;
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(raw) as Manifest;
  } catch (err) {
    console.error(`Failed to load manifest at ${manifestPath}:`, err);
    process.exit(1);
  }

  // Build product lookup map
  const productMap = new Map<string, Product>(
    manifest.products.map(p => [p.slug, p]),
  );

  // Build combinations
  const combos = buildCombinations(manifest, {
    product: opts.product,
    style: opts.style,
    runsOverride: opts.runsOverride,
  });

  if (combos.length === 0) {
    console.log('No test combinations matched the given filters. Nothing to run.');
    process.exit(0);
  }

  // Expand for dry-run display: enumerate all styles that would be tested
  const expandedStyleTests: Array<{ product: string; style: string; instr: string; run: number }> = [];
  for (const combo of combos) {
    for (const style of combo.stylesTriplet) {
      expandedStyleTests.push({
        product: combo.productSlug,
        style,
        instr: combo.instructionCase.case,
        run: combo.runNumber,
      });
    }
  }

  console.log(`\nPlanned execution:`);
  console.log(`  Combinations (API calls): ${combos.length}`);
  console.log(`  Total style results:      ${expandedStyleTests.length}`);
  console.log(`  Parallelism:              ${manifest.config.parallelism}`);
  console.log(`  Retries:                  ${manifest.config.retries}`);
  console.log('');

  for (const t of expandedStyleTests) {
    console.log(`  [${t.product}] ${t.style}  instr="${t.instr}"  run=${t.run}`);
  }
  console.log('');

  if (opts.dryRun) {
    console.log('Dry run mode — exiting without executing.');
    return;
  }

  // Create timestamped run directory
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const runDir = resolve(__dirname, 'runs', runTimestamp);
  const outputsDir = join(runDir, 'outputs');
  await mkdir(outputsDir, { recursive: true });

  const logPath = join(runDir, 'run.log');
  const logger = new RunLogger(logPath);

  await logger.info('run_start', {
    runTimestamp,
    totalCombos: combos.length,
    totalStyleResults: expandedStyleTests.length,
    parallelism: manifest.config.parallelism,
    retries: manifest.config.retries,
    dryRun: false,
  });

  // Write CSV headers
  const resultsCsvPath = join(runDir, 'results.csv');
  const gradesCsvPath = join(runDir, 'grades.csv');
  await writeFile(resultsCsvPath, RESULTS_CSV_HEADERS + '\n');
  await writeFile(gradesCsvPath, GRADES_CSV_HEADERS + '\n');

  // Accumulate all results in memory for results.json
  const allResults: TestResult[] = [];
  let successCount = 0;
  let failureCount = 0;

  // Execute with bounded concurrency
  await parallelExecute(
    combos,
    manifest.config.parallelism,
    async (combo) => {
      const product = productMap.get(combo.productSlug);
      if (!product) {
        await logger.error('product_not_found', { slug: combo.productSlug });
        return;
      }

      const results = await runSingleTest({
        combo,
        product,
        manifest,
        runDir,
        outputsDir,
        logger,
        retries: manifest.config.retries,
      });

      for (const result of results) {
        allResults.push(result);

        // Append to CSV immediately so partial runs are recoverable
        await appendFile(resultsCsvPath, resultsToCsvRow(result) + '\n');

        if (!result.error) {
          successCount++;
          // Append grade template row for successful results
          await appendFile(gradesCsvPath, gradeTemplateCsvRow(result) + '\n');
        } else {
          failureCount++;
        }
      }
    },
  );

  // Write full results.json keyed by test ID
  const resultsById: Record<string, TestResult> = {};
  for (const r of allResults) {
    const id = `${r.product}__${r.style}__${r.instructionCase}__run${r.runNumber}`;
    resultsById[id] = r;
  }
  const resultsJsonPath = join(runDir, 'results.json');
  await writeFile(resultsJsonPath, JSON.stringify({ runTimestamp, results: resultsById }, null, 2));

  await logger.info('run_complete', {
    totalCombos: combos.length,
    totalStyleResults: allResults.length,
    successCount,
    failureCount,
    runDir,
  });

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Run complete');
  console.log(`  Total API calls:    ${combos.length}`);
  console.log(`  Total style results: ${allResults.length}`);
  console.log(`  Successes:          ${successCount}`);
  console.log(`  Failures:           ${failureCount}`);
  console.log(`  Run directory:      ${runDir}`);
  console.log('');

  // Breakdown by product
  const byProduct = new Map<string, { success: number; fail: number }>();
  for (const r of allResults) {
    const entry = byProduct.get(r.product) ?? { success: 0, fail: 0 };
    if (r.error) entry.fail++;
    else entry.success++;
    byProduct.set(r.product, entry);
  }
  console.log('  By product:');
  for (const [prod, counts] of byProduct) {
    console.log(`    ${prod}: ${counts.success} ok, ${counts.fail} failed`);
  }

  // Breakdown by style
  const byStyle = new Map<string, { success: number; fail: number; totalQa: number; qaCount: number }>();
  for (const r of allResults) {
    const entry = byStyle.get(r.style) ?? { success: 0, fail: 0, totalQa: 0, qaCount: 0 };
    if (r.error) entry.fail++;
    else {
      entry.success++;
      if (r.qaScore !== null) { entry.totalQa += r.qaScore; entry.qaCount++; }
    }
    byStyle.set(r.style, entry);
  }
  console.log('\n  By style:');
  for (const [style, counts] of byStyle) {
    const avgQa = counts.qaCount > 0 ? (counts.totalQa / counts.qaCount).toFixed(1) : 'n/a';
    console.log(`    ${style}: ${counts.success} ok, ${counts.fail} failed, avg QA=${avgQa}`);
  }
  console.log('');
  console.log(`  results.csv  → ${resultsCsvPath}`);
  console.log(`  results.json → ${resultsJsonPath}`);
  console.log(`  grades.csv   → ${gradesCsvPath} (fill in manually)`);
  console.log(`  run.log      → ${logPath}`);
  console.log('='.repeat(60) + '\n');
}

main().catch(err => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
