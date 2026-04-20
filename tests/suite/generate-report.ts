/**
 * Autmn Test Suite — Report Generator
 * Usage: pnpm report [-- --run=<timestamp>]
 * Reads results.csv + grades.csv from runs/<timestamp>/ and writes report.html
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestResult, GradeEntry } from './lib/types.js';
import { computeWeightedTotal, scoreToLetter } from './lib/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { run: string | null } {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('--run=')) return { run: arg.slice('--run='.length) };
  }
  return { run: null };
}

// ---------------------------------------------------------------------------
// CSV parser (minimal, handles quoted fields)
// ---------------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv<T>(
  raw: string,
  mapper: (headers: string[], row: string[]) => T | null,
): T[] {
  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const results: T[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    const mapped = mapper(headers, row);
    if (mapped !== null) results.push(mapped);
  }
  return results;
}

function getField(headers: string[], row: string[], name: string): string {
  const idx = headers.indexOf(name);
  return idx >= 0 ? (row[idx] ?? '') : '';
}

function parseNum(s: string): number | null {
  if (!s || s.trim() === '') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadResults(csv: string): TestResult[] {
  return parseCsv(csv, (headers, row) => {
    const product = getField(headers, row, 'product');
    if (!product) return null;
    return {
      product,
      style: getField(headers, row, 'style'),
      instructionCase: getField(headers, row, 'instructionCase'),
      runNumber: parseInt(getField(headers, row, 'runNumber'), 10) || 1,
      timestamp: getField(headers, row, 'timestamp'),
      qaScore: parseNum(getField(headers, row, 'qaScore')),
      tier: parseNum(getField(headers, row, 'tier')),
      pipeline: getField(headers, row, 'pipeline') || null,
      durationMs: parseNum(getField(headers, row, 'durationMs')),
      outputLocalPath: getField(headers, row, 'outputLocalPath') || null,
      outputUrl: getField(headers, row, 'outputUrl') || null,
      prompt: null, // not stored in CSV
      analysis: {
        productName: getField(headers, row, 'productName'),
        productCategory: getField(headers, row, 'productCategory'),
        hasBranding: false,
        physicalSize: '',
        dominantColors: [],
        typicalSetting: '',
        usable: true,
        itemCount: parseInt(getField(headers, row, 'itemCount'), 10) || 0,
        items: [],
        setDescription: getField(headers, row, 'setDescription') || null,
        analyzerFellBack: getField(headers, row, 'analyzerFellBack') === 'true',
      },
      error: getField(headers, row, 'error') || null,
      errorAttempts: parseInt(getField(headers, row, 'errorAttempts'), 10) || 0,
    } satisfies TestResult;
  });
}

function loadGrades(csv: string): GradeEntry[] {
  return parseCsv(csv, (headers, row) => {
    const product = getField(headers, row, 'product');
    if (!product) return null;
    const productAccuracy = parseNum(getField(headers, row, 'productAccuracy'));
    const brandPreservation = parseNum(getField(headers, row, 'brandPreservation'));
    const styleMatch = parseNum(getField(headers, row, 'styleMatch'));
    const adQuality = parseNum(getField(headers, row, 'adQuality'));
    const creativity = parseNum(getField(headers, row, 'creativity'));

    const entry: GradeEntry = {
      product,
      style: getField(headers, row, 'style'),
      instructionCase: getField(headers, row, 'instructionCase'),
      runNumber: parseInt(getField(headers, row, 'runNumber'), 10) || 1,
      productAccuracy,
      brandPreservation,
      styleMatch,
      adQuality,
      creativity,
      weightedTotal: null,
      letterGrade: null,
      failureModes: getField(headers, row, 'failureModes'),
      observations: getField(headers, row, 'observations'),
    };

    // Compute weighted total and letter grade
    const style = entry.style;
    const wt = computeWeightedTotal(entry, style);
    entry.weightedTotal = wt !== null ? Math.round(wt * 10) / 10 : null;
    entry.letterGrade = wt !== null ? scoreToLetter(wt) : null;

    return entry;
  });
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function escHtml(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateReport(params: {
  runTimestamp: string;
  results: TestResult[];
  grades: GradeEntry[];
  runDir: string;
}): string {
  const { runTimestamp, results, grades } = params;

  // Build grade lookup
  const gradeMap = new Map<string, GradeEntry>();
  for (const g of grades) {
    const key = `${g.product}__${g.style}__${g.instructionCase}__run${g.runNumber}`;
    gradeMap.set(key, g);
  }

  const getGrade = (r: TestResult) =>
    gradeMap.get(`${r.product}__${r.style}__${r.instructionCase}__run${r.runNumber}`) ?? null;

  const successResults = results.filter(r => !r.error);
  const failedResults = results.filter(r => r.error);
  const gradedResults = results.filter(r => getGrade(r)?.weightedTotal !== null && getGrade(r) !== null);

  // Per-product groups
  const byProduct = new Map<string, TestResult[]>();
  for (const r of results) {
    const arr = byProduct.get(r.product) ?? [];
    arr.push(r);
    byProduct.set(r.product, arr);
  }

  // Per-style aggregates
  const styleAggMap = new Map<string, { qaScores: number[]; durations: number[]; weightedTotals: number[]; failCount: number }>();
  for (const r of results) {
    const agg = styleAggMap.get(r.style) ?? { qaScores: [], durations: [], weightedTotals: [], failCount: 0 };
    if (r.qaScore !== null) agg.qaScores.push(r.qaScore);
    if (r.durationMs !== null) agg.durations.push(r.durationMs);
    const g = getGrade(r);
    if (g?.weightedTotal !== null && g?.weightedTotal !== undefined) agg.weightedTotals.push(g.weightedTotal);
    if (r.error) agg.failCount++;
    styleAggMap.set(r.style, agg);
  }

  // Failure mode frequency
  const failureModeFreq = new Map<string, number>();
  for (const g of grades) {
    if (!g.failureModes) continue;
    for (const mode of g.failureModes.split(',').map(s => s.trim()).filter(Boolean)) {
      failureModeFreq.set(mode, (failureModeFreq.get(mode) ?? 0) + 1);
    }
  }
  const sortedFailureModes = [...failureModeFreq.entries()].sort((a, b) => b[1] - a[1]);

  // Grade distribution
  const gradeDistribution = new Map<string, number>();
  for (const g of grades) {
    if (!g.letterGrade) continue;
    gradeDistribution.set(g.letterGrade, (gradeDistribution.get(g.letterGrade) ?? 0) + 1);
  }

  const tierBadge = (tier: number | null) => {
    if (tier === null) return '<span class="badge badge-gray">?</span>';
    const colors = ['', 'badge-green', 'badge-yellow', 'badge-orange', 'badge-red'];
    return `<span class="badge ${colors[tier] ?? 'badge-gray'}">T${tier}</span>`;
  };

  const gradeBadge = (letter: string | null) => {
    if (!letter) return '';
    const cls = letter.startsWith('A') ? 'badge-green'
               : letter.startsWith('B') ? 'badge-yellow'
               : letter.startsWith('C') ? 'badge-orange'
               : 'badge-red';
    return `<span class="badge ${cls}">${letter}</span>`;
  };

  const productCards = [...byProduct.entries()].map(([productSlug, productResults]) => {
    const inputPhotos = productResults[0]?.analysis?.productName
      ? `<div class="analysis-info"><strong>${escHtml(productResults[0].analysis?.productName)}</strong> — ${escHtml(productResults[0].analysis?.productCategory)}</div>`
      : '';

    const styleRows = productResults.map(r => {
      const g = getGrade(r);
      const imgTag = r.outputLocalPath
        ? `<a href="${escHtml(r.outputLocalPath)}" target="_blank"><img src="${escHtml(r.outputLocalPath)}" class="output-thumb" loading="lazy" /></a>`
        : r.error
          ? `<div class="error-box">${escHtml(r.error)}</div>`
          : '<div class="no-output">No output</div>';

      const qaCell = r.qaScore !== null
        ? `<span class="${r.qaScore >= 65 ? 'score-pass' : 'score-fail'}">${r.qaScore}</span>`
        : '—';

      const durationCell = r.durationMs !== null
        ? `${(r.durationMs / 1000).toFixed(1)}s`
        : '—';

      return `
        <div class="result-card ${r.error ? 'result-card-error' : ''}">
          <div class="result-card-header">
            <span class="style-label">${escHtml(r.style.replace('style_', '').replace(/_/g, ' '))}</span>
            ${tierBadge(r.tier)}
            ${g ? gradeBadge(g.letterGrade) : ''}
            <span class="pipeline-label">${escHtml(r.pipeline ?? '')}</span>
          </div>
          ${imgTag}
          <div class="result-meta">
            <span>QA: ${qaCell}</span>
            <span>${durationCell}</span>
            <span class="instr-label">${escHtml(r.instructionCase)}</span>
          </div>
          ${g && g.weightedTotal !== null ? `
          <div class="grade-details">
            <table class="grade-table">
              <tr><td>Product</td><td>${g.productAccuracy ?? '—'}</td></tr>
              <tr><td>Brand</td><td>${g.brandPreservation ?? '—'}</td></tr>
              <tr><td>Style</td><td>${g.styleMatch ?? '—'}</td></tr>
              <tr><td>Ad Quality</td><td>${g.adQuality ?? '—'}</td></tr>
              <tr><td>Creativity</td><td>${g.creativity ?? '—'}</td></tr>
              <tr class="grade-total"><td>Weighted</td><td>${g.weightedTotal}</td></tr>
            </table>
            ${g.failureModes ? `<div class="failure-modes">${escHtml(g.failureModes)}</div>` : ''}
            ${g.observations ? `<div class="observations">${escHtml(g.observations)}</div>` : ''}
          </div>` : ''}
        </div>`;
    }).join('');

    return `
    <section class="product-section">
      <h2 class="product-title">${escHtml(productSlug)}</h2>
      ${inputPhotos}
      <div class="result-grid">
        ${styleRows}
      </div>
    </section>`;
  }).join('');

  const styleTableRows = [...styleAggMap.entries()].map(([style, agg]) => {
    const avgQa = avg(agg.qaScores);
    const avgDur = avg(agg.durations);
    const avgWt = avg(agg.weightedTotals);
    return `<tr>
      <td>${escHtml(style)}</td>
      <td>${agg.qaScores.length + agg.failCount}</td>
      <td>${agg.failCount}</td>
      <td>${avgQa !== null ? avgQa.toFixed(1) : '—'}</td>
      <td>${avgDur !== null ? (avgDur / 1000).toFixed(1) + 's' : '—'}</td>
      <td>${avgWt !== null ? avgWt.toFixed(1) : '—'}</td>
      <td>${avgWt !== null ? gradeBadge(scoreToLetter(avgWt)) : '—'}</td>
    </tr>`;
  }).join('');

  const failureModeRows = sortedFailureModes.map(([mode, count]) =>
    `<tr><td>${escHtml(mode)}</td><td>${count}</td><td>${pct(count, gradedResults.length)}</td></tr>`,
  ).join('');

  const rawTableRows = results.map(r => {
    const g = getGrade(r);
    return `<tr class="${r.error ? 'row-error' : ''}">
      <td>${escHtml(r.product)}</td>
      <td>${escHtml(r.style)}</td>
      <td>${escHtml(r.instructionCase)}</td>
      <td>${r.runNumber}</td>
      <td>${r.qaScore ?? '—'}</td>
      <td>${tierBadge(r.tier)}</td>
      <td>${escHtml(r.pipeline ?? '')}</td>
      <td>${r.durationMs !== null ? (r.durationMs / 1000).toFixed(1) + 's' : '—'}</td>
      <td>${g?.weightedTotal ?? '—'}</td>
      <td>${g ? gradeBadge(g.letterGrade) : '—'}</td>
      <td>${escHtml(r.error ?? '')}</td>
    </tr>`;
  }).join('');

  const avgQaAll = avg(successResults.map(r => r.qaScore).filter((n): n is number => n !== null));
  const avgDurAll = avg(successResults.map(r => r.durationMs).filter((n): n is number => n !== null));
  const avgWtAll = avg(gradedResults.map(r => getGrade(r)?.weightedTotal).filter((n): n is number => n !== null && n !== undefined));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Autmn Test Report — ${escHtml(runTimestamp)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; margin: 0; padding: 0; }
  h1 { font-size: 1.6rem; font-weight: 700; color: #fff; }
  h2 { font-size: 1.2rem; font-weight: 600; color: #ccc; margin-top: 2rem; }
  h3 { font-size: 1rem; font-weight: 600; color: #aaa; margin-top: 1.5rem; }
  .header { background: #1a1a1a; border-bottom: 1px solid #333; padding: 1.5rem 2rem; }
  .header-meta { display: flex; gap: 2rem; margin-top: 0.75rem; flex-wrap: wrap; }
  .meta-stat { display: flex; flex-direction: column; }
  .meta-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #888; }
  .meta-value { font-size: 1.4rem; font-weight: 700; color: #fff; }
  .meta-value.good { color: #4ade80; }
  .meta-value.bad { color: #f87171; }
  .content { padding: 2rem; max-width: 1400px; margin: 0 auto; }
  .product-section { margin-bottom: 3rem; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.5rem; background: #141414; }
  .product-title { color: #fff; font-size: 1.3rem; margin-top: 0; }
  .analysis-info { color: #aaa; font-size: 0.85rem; margin-bottom: 1rem; }
  .result-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .result-card { background: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 6px; padding: 0.75rem; }
  .result-card-error { border-color: #7f1d1d; background: #1c0a0a; }
  .result-card-header { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
  .style-label { font-size: 0.8rem; font-weight: 600; color: #d4d4d4; flex: 1; }
  .pipeline-label { font-size: 0.7rem; color: #666; }
  .instr-label { font-size: 0.7rem; color: #888; background: #2a2a2a; padding: 1px 6px; border-radius: 3px; }
  .output-thumb { width: 100%; aspect-ratio: 1/1; object-fit: cover; border-radius: 4px; display: block; margin: 0.5rem 0; }
  .error-box { background: #2d1515; color: #f87171; font-size: 0.75rem; padding: 0.5rem; border-radius: 4px; margin: 0.5rem 0; word-break: break-word; }
  .no-output { background: #1a1a1a; color: #555; font-size: 0.75rem; padding: 0.5rem; border-radius: 4px; margin: 0.5rem 0; text-align: center; }
  .result-meta { display: flex; gap: 0.5rem; font-size: 0.75rem; color: #888; flex-wrap: wrap; align-items: center; }
  .score-pass { color: #4ade80; font-weight: 600; }
  .score-fail { color: #f87171; font-weight: 600; }
  .grade-details { margin-top: 0.5rem; font-size: 0.75rem; }
  .grade-table { width: 100%; border-collapse: collapse; }
  .grade-table td { padding: 1px 4px; }
  .grade-table td:last-child { text-align: right; color: #d4d4d4; }
  .grade-total td { font-weight: 700; color: #fff; border-top: 1px solid #333; padding-top: 3px; }
  .failure-modes { color: #f97316; font-size: 0.7rem; margin-top: 0.25rem; word-break: break-word; }
  .observations { color: #94a3b8; font-size: 0.7rem; margin-top: 0.25rem; font-style: italic; }
  .badge { display: inline-block; font-size: 0.7rem; font-weight: 700; padding: 1px 6px; border-radius: 3px; }
  .badge-green { background: #14532d; color: #4ade80; }
  .badge-yellow { background: #422006; color: #fbbf24; }
  .badge-orange { background: #431407; color: #fb923c; }
  .badge-red { background: #450a0a; color: #f87171; }
  .badge-gray { background: #262626; color: #9ca3af; }
  .summary-tables { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { background: #1e1e1e; color: #aaa; text-align: left; padding: 8px 10px; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #333; position: sticky; top: 0; }
  td { padding: 7px 10px; border-bottom: 1px solid #1e1e1e; vertical-align: middle; }
  tr:hover td { background: #1a1a1a; }
  .row-error td { color: #f87171; }
  .table-container { background: #141414; border: 1px solid #2a2a2a; border-radius: 6px; overflow: hidden; }
  .table-wrapper { overflow-x: auto; max-height: 500px; overflow-y: auto; }
  .section-title { font-size: 1rem; font-weight: 600; color: #ddd; padding: 0.75rem 1rem; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; }
  .search-box { padding: 0.5rem 1rem; border-bottom: 1px solid #2a2a2a; background: #141414; }
  .search-box input { background: #1e1e1e; border: 1px solid #333; color: #e0e0e0; padding: 5px 10px; border-radius: 4px; font-size: 0.85rem; width: 100%; }
  .search-box input:focus { outline: none; border-color: #555; }
</style>
</head>
<body>

<div class="header">
  <h1>Autmn Test Report</h1>
  <div class="header-meta">
    <div class="meta-stat">
      <span class="meta-label">Run</span>
      <span class="meta-value">${escHtml(runTimestamp)}</span>
    </div>
    <div class="meta-stat">
      <span class="meta-label">Total Tests</span>
      <span class="meta-value">${results.length}</span>
    </div>
    <div class="meta-stat">
      <span class="meta-label">Success Rate</span>
      <span class="meta-value ${failedResults.length === 0 ? 'good' : 'bad'}">${pct(successResults.length, results.length)}</span>
    </div>
    <div class="meta-stat">
      <span class="meta-label">Avg QA Score</span>
      <span class="meta-value">${avgQaAll !== null ? avgQaAll.toFixed(1) : '—'}</span>
    </div>
    <div class="meta-stat">
      <span class="meta-label">Avg Duration</span>
      <span class="meta-value">${avgDurAll !== null ? (avgDurAll / 1000).toFixed(1) + 's' : '—'}</span>
    </div>
    ${avgWtAll !== null ? `<div class="meta-stat">
      <span class="meta-label">Avg Weighted Score</span>
      <span class="meta-value">${avgWtAll.toFixed(1)} (${scoreToLetter(avgWtAll)})</span>
    </div>` : ''}
    <div class="meta-stat">
      <span class="meta-label">Graded</span>
      <span class="meta-value">${gradedResults.length} / ${successResults.length}</span>
    </div>
  </div>
</div>

<div class="content">

${productCards}

<h2>Summary Tables</h2>
<div class="summary-tables">

  <div class="table-container">
    <div class="section-title">By Style</div>
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Style</th><th>Tests</th><th>Fail</th><th>Avg QA</th><th>Avg Dur</th><th>Avg Grade</th><th>Letter</th></tr></thead>
        <tbody>${styleTableRows}</tbody>
      </table>
    </div>
  </div>

  ${sortedFailureModes.length > 0 ? `<div class="table-container">
    <div class="section-title">Failure Mode Frequency</div>
    <div class="table-wrapper">
      <table>
        <thead><tr><th>Mode</th><th>Count</th><th>%</th></tr></thead>
        <tbody>${failureModeRows}</tbody>
      </table>
    </div>
  </div>` : ''}

</div>

<h2>All Results</h2>
<div class="table-container">
  <div class="search-box">
    <input type="text" id="tableSearch" placeholder="Filter by product, style, pipeline..." oninput="filterTable()" />
  </div>
  <div class="table-wrapper">
    <table id="resultsTable">
      <thead>
        <tr>
          <th>Product</th><th>Style</th><th>Instruction</th><th>Run</th>
          <th>QA</th><th>Tier</th><th>Pipeline</th><th>Duration</th>
          <th>Score</th><th>Grade</th><th>Error</th>
        </tr>
      </thead>
      <tbody>${rawTableRows}</tbody>
    </table>
  </div>
</div>

</div>

<script>
function filterTable() {
  const q = document.getElementById('tableSearch').value.toLowerCase();
  const rows = document.querySelectorAll('#resultsTable tbody tr');
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
</script>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { run } = parseArgs();

  const runsDir = resolve(__dirname, 'runs');

  // If no run specified, use most recent
  let runTimestamp = run;
  if (!runTimestamp) {
    const entries = await readdir(runsDir).catch(() => [] as string[]);
    const sorted = entries.sort().reverse();
    if (sorted.length === 0) {
      console.error('No runs found in runs/ directory. Run tests first.');
      process.exit(1);
    }
    runTimestamp = sorted[0];
    console.log(`No --run specified, using most recent: ${runTimestamp}`);
  }

  const runDir = join(runsDir, runTimestamp);
  const resultsCsvPath = join(runDir, 'results.csv');
  const gradesCsvPath = join(runDir, 'grades.csv');
  const reportPath = join(runDir, 'report.html');

  // Load results
  let resultsCsv: string;
  try {
    resultsCsv = await readFile(resultsCsvPath, 'utf-8');
  } catch {
    console.error(`Cannot read results.csv at ${resultsCsvPath}`);
    process.exit(1);
  }
  const results = loadResults(resultsCsv);
  console.log(`Loaded ${results.length} result rows.`);

  // Load grades (optional)
  let grades: GradeEntry[] = [];
  try {
    const gradesCsv = await readFile(gradesCsvPath, 'utf-8');
    grades = loadGrades(gradesCsv);
    // Filter out rows with no scores (template rows that haven't been filled in)
    grades = grades.filter(g =>
      g.productAccuracy !== null || g.brandPreservation !== null ||
      g.styleMatch !== null || g.adQuality !== null || g.creativity !== null,
    );
    console.log(`Loaded ${grades.length} graded rows.`);
  } catch {
    console.log('No grades.csv found or empty — report will show ungraded results.');
  }

  const html = generateReport({ runTimestamp, results, grades, runDir });
  await writeFile(reportPath, html);
  console.log(`Report written to: ${reportPath}`);
  console.log(`Open in browser: file://${reportPath}`);
}

main().catch(err => {
  console.error('Fatal error in report generator:', err);
  process.exit(1);
});
