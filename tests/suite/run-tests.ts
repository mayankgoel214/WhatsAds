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
import { generateViaAdminApi, generateVideoViaAdminApi } from './lib/admin-client.js';
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

    const mediaType = product.mediaType ?? 'image';

    if (mediaType === 'video') {
      // Video products: one combination per videoStyle × instructionCase × run
      const videoStyles = product.videoStyles ?? ['video_cinematic'];
      for (const videoStyle of videoStyles) {
        if (opts.style && videoStyle !== opts.style) continue;
        for (const instructionCase of product.instructions) {
          for (let run = 1; run <= runsPerCombo; run++) {
            combos.push({
              productSlug: product.slug,
              // Encode as a single-element "triplet" for compatibility with
              // the existing loop structure; runSingleTest detects mediaType
              stylesTriplet: [videoStyle],
              instructionCase,
              runNumber: run,
            });
          }
        }
      }
    } else {
      // Image products (existing behaviour)
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
  }
  return combos;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

const RESULTS_CSV_HEADERS = [
  'product', 'style', 'instructionCase', 'runNumber', 'timestamp',
  'mediaType',
  'qaScore', 'tier', 'pipeline', 'durationMs',
  'outputLocalPath', 'outputUrl',
  'videoUrl', 'videoLocalPath', 'videoModelId', 'videoAspectRatio', 'videoDurationSec', 'voiceoverText',
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
    r.mediaType ?? 'image',
    r.qaScore,
    r.tier,
    r.pipeline,
    r.durationMs,
    r.outputLocalPath,
    r.outputUrl,
    r.videoUrl ?? '',
    r.videoLocalPath ?? '',
    r.videoModelId ?? '',
    r.videoAspectRatio ?? '',
    r.videoDurationSec ?? '',
    r.voiceoverText ?? '',
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
// File downloader (images and videos)
// ---------------------------------------------------------------------------

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download file: ${resp.status} ${url}`);
  if (!resp.body) throw new Error('No response body for file download');
  const writer = createWriteStream(destPath);
  await pipeline(Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]), writer);
}

// Keep old name as alias for backwards compat within this file
const downloadImage = downloadToFile;

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

  const mediaType = product.mediaType ?? 'image';

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
        mediaType,
        styles: combo.stylesTriplet,
        instructionCase: combo.instructionCase.case,
        runNumber: combo.runNumber,
        attempt: attempts,
      });

      // ── VIDEO PATH ──────────────────────────────────────────────────────
      if (mediaType === 'video') {
        const videoStyle = combo.stylesTriplet[0]!;
        const apiResult = await generateVideoViaAdminApi({
          adminUrl: config.adminUrl,
          adminKey: config.adminKey,
          photoPaths,
          videoStyle,
          videoDuration: product.videoDuration ?? 5,
          aspectRatio: product.videoAspectRatio ?? '9:16',
          voiceoverText: product.voiceoverText,
          instructions: combo.instructionCase.text,
          timeoutMs: 300_000, // 5 min
        });

        const timestamp = new Date().toISOString();
        const safeStyle = videoStyle.replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeInstr = combo.instructionCase.case.replace(/[^a-zA-Z0-9_-]/g, '_');
        const videoFilename = `${combo.productSlug}_${safeStyle}_${safeInstr}_run${combo.runNumber}.mp4`;
        const destPath = join(outputsDir, videoFilename);

        let videoLocalPath: string | null = null;
        if (apiResult.video.videoUrl && !apiResult.video.error) {
          try {
            await downloadToFile(apiResult.video.videoUrl, destPath);
            videoLocalPath = join('outputs', videoFilename);
          } catch (dlErr) {
            await logger.warn('video_download_failed', {
              style: videoStyle,
              url: apiResult.video.videoUrl,
              error: dlErr instanceof Error ? dlErr.message : String(dlErr),
            });
          }
        }

        const result: TestResult = {
          product: combo.productSlug,
          style: videoStyle,
          instructionCase: combo.instructionCase.case,
          runNumber: combo.runNumber,
          timestamp,
          mediaType: 'video',
          // Image fields unused for video
          qaScore: null,
          tier: null,
          pipeline: null,
          durationMs: apiResult.video.durationMs ?? null,
          outputLocalPath: null,
          outputUrl: null,
          prompt: apiResult.video.prompt ?? null,
          analysis: apiResult.analysis ?? null,
          error: apiResult.video.error ?? null,
          errorAttempts: attempt,
          // Video-specific
          videoUrl: apiResult.video.videoUrl ?? null,
          videoLocalPath,
          videoModelId: apiResult.video.modelId ?? null,
          videoAspectRatio: apiResult.video.aspectRatio ?? null,
          videoDurationSec: apiResult.video.durationSec ?? null,
          voiceoverText: apiResult.video.voiceoverText ?? null,
        };

        await logger.info('test_video_done', {
          product: combo.productSlug,
          style: videoStyle,
          videoUrl: result.videoUrl,
          durationMs: result.durationMs,
          error: result.error,
        });

        return [result];
      }

      // ── IMAGE PATH (existing) ───────────────────────────────────────────
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
          mediaType: 'image',
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
        mediaType,
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
    mediaType,
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
