/**
 * Admin Test UI — mirrors the WhatsApp customer experience for rapid pipeline testing.
 *
 * GET  /admin/test         → HTML page (style picker + photo upload + results)
 * POST /admin/test/generate → multipart endpoint; runs 3 parallel style generations
 *
 * Auth: query param ?key=<ADMIN_SECRET> (skipped when ADMIN_SECRET === 'placeholder' in dev)
 */

import { timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { getConfig } from '../../config.js';
import { uploadFile } from '@autmn/storage';
import { lightAnalyze } from '@autmn/ai';
import { processImageNeverFail } from '@autmn/ai';
import { getStylePromptV5 } from '@autmn/ai';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function checkAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const config = getConfig();
  const adminSecret = config.ADMIN_SECRET ?? '';

  // In dev with placeholder, skip auth
  if (config.NODE_ENV !== 'production' && adminSecret === 'placeholder') {
    return true;
  }

  const key = (req.query as Record<string, string>)['key'] ?? '';
  if (!key || !adminSecret) {
    reply.code(403).send({ error: 'Forbidden', code: 'ADMIN_AUTH_REQUIRED' });
    return false;
  }

  try {
    if (
      Buffer.byteLength(key) !== Buffer.byteLength(adminSecret) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(adminSecret))
    ) {
      reply.code(403).send({ error: 'Forbidden', code: 'ADMIN_AUTH_REQUIRED' });
      return false;
    }
  } catch {
    reply.code(403).send({ error: 'Forbidden', code: 'ADMIN_AUTH_REQUIRED' });
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Style metadata — matches styleDisplayName() from packages/session/src/messages.ts
// ---------------------------------------------------------------------------

const STYLES = [
  { id: 'style_autmn_special', label: 'Autmn Special ✨' },
  { id: 'style_clean_white',   label: 'Clean White Background' },
  { id: 'style_lifestyle',     label: 'Lifestyle Setting' },
  { id: 'style_gradient',      label: 'Dark Luxury' },
  { id: 'style_outdoor',       label: 'Outdoor Scene' },
  { id: 'style_studio',        label: 'Colored Studio' },
  { id: 'style_festive',       label: 'Festive Style' },
  { id: 'style_minimal',       label: 'Minimal & Clean' },
  { id: 'style_with_model',    label: 'With Model' },
] as const;

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

const STYLES_JSON = JSON.stringify(STYLES);

function buildHtml(adminKey: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Autmn Admin — Pipeline Test</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .thumb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; }
    .thumb-grid img { width: 100%; height: 100px; object-fit: cover; border-radius: 6px; border: 2px solid #e5e7eb; }
    .style-btn { transition: all 0.15s; }
    .style-btn.selected { border-color: #6366f1; background-color: #eef2ff; }
    .style-btn.selected .style-check { display: inline; }
    .style-btn .style-check { display: none; }
    pre { white-space: pre-wrap; word-break: break-word; }
    .result-card { animation: fadeIn 0.3s ease-in; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

<div class="max-w-5xl mx-auto px-4 py-8">
  <!-- Header -->
  <div class="mb-8">
    <h1 class="text-2xl font-bold text-gray-900">Autmn Pipeline Tester</h1>
    <p class="text-sm text-gray-500 mt-1">Upload 1–5 photos, pick exactly 3 styles, run the AI pipeline. Mirrors the WhatsApp flow.</p>
  </div>

  <!-- Step 1: Upload Photos -->
  <div class="bg-white rounded-xl border border-gray-200 p-6 mb-5 shadow-sm">
    <h2 class="font-semibold text-gray-800 mb-3">1. Upload Photos <span class="text-gray-400 text-sm font-normal">(1–5, max 10MB each)</span></h2>
    <label
      id="drop-zone"
      class="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-lg py-10 px-4 cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition"
    >
      <svg class="w-10 h-10 text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
      </svg>
      <span class="text-gray-500">Drag & drop photos here, or <span class="text-indigo-600 font-medium">click to browse</span></span>
      <span class="text-xs text-gray-400 mt-1">JPG, PNG, WEBP</span>
      <input id="file-input" type="file" multiple accept="image/*" class="hidden" />
    </label>
    <div id="thumb-container" class="mt-4 thumb-grid hidden"></div>
    <p id="photo-count-msg" class="text-sm text-gray-500 mt-2 hidden"></p>
  </div>

  <!-- Step 2: Pick 3 Styles -->
  <div class="bg-white rounded-xl border border-gray-200 p-6 mb-5 shadow-sm">
    <h2 class="font-semibold text-gray-800 mb-1">2. Pick Exactly 3 Styles</h2>
    <p id="style-count-label" class="text-sm text-gray-400 mb-4">0/3 selected</p>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3" id="style-grid"></div>
  </div>

  <!-- Step 3: Instructions -->
  <div class="bg-white rounded-xl border border-gray-200 p-6 mb-5 shadow-sm">
    <h2 class="font-semibold text-gray-800 mb-3">3. Instructions <span class="text-gray-400 text-sm font-normal">(optional)</span></h2>
    <textarea
      id="instructions"
      rows="3"
      placeholder="Any special instructions? e.g. 'show on a marble slab' or 'make the model wear a red saree'"
      class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-300"
    ></textarea>
  </div>

  <!-- Start button -->
  <button
    id="start-btn"
    disabled
    class="w-full py-3 px-6 rounded-xl font-semibold text-white bg-indigo-600 disabled:bg-gray-300 disabled:cursor-not-allowed hover:bg-indigo-700 transition"
  >
    Start — Generate 3 Ads
  </button>

  <!-- Progress -->
  <div id="progress-area" class="hidden mt-8 bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
    <div class="flex items-center gap-3">
      <div class="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
      <span class="text-gray-700 font-medium" id="progress-text">📷 Photo mil gayi! 3 ads bana rahe hain...</span>
    </div>
    <!-- Analysis block -->
    <div id="analysis-block" class="hidden mt-5 border-t border-gray-100 pt-4">
      <p class="text-xs text-gray-400 uppercase tracking-wide mb-2 font-semibold">Gemini understood this product as:</p>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm" id="analysis-grid"></div>
    </div>
  </div>

  <!-- Results -->
  <div id="results-area" class="hidden mt-8">
    <h2 class="text-lg font-semibold text-gray-800 mb-4">Results</h2>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-5" id="results-grid"></div>
    <button
      id="again-btn"
      class="mt-6 w-full py-3 px-6 rounded-xl font-semibold text-white bg-gray-700 hover:bg-gray-800 transition"
    >
      Run Again
    </button>
  </div>

  <!-- Error -->
  <div id="error-area" class="hidden mt-8 bg-red-50 border border-red-200 rounded-xl p-5 text-red-800 text-sm"></div>
</div>

<script>
const ADMIN_KEY = ${JSON.stringify(adminKey)};
const STYLES = ${STYLES_JSON};

let selectedFiles = [];
let selectedStyles = [];

// ── File upload ──────────────────────────────────────────────────────────────

const dropZone   = document.getElementById('drop-zone');
const fileInput  = document.getElementById('file-input');
const thumbCont  = document.getElementById('thumb-container');
const photoMsg   = document.getElementById('photo-count-msg');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('border-indigo-400'); });
dropZone.addEventListener('dragleave',  () => dropZone.classList.remove('border-indigo-400'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('border-indigo-400');
  handleFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));

function handleFiles(files) {
  const imageFiles = files.filter(f => f.type.startsWith('image/'));
  const oversized  = imageFiles.filter(f => f.size > 10 * 1024 * 1024);
  if (oversized.length) {
    showError('Some files exceed 10MB and were skipped: ' + oversized.map(f => f.name).join(', '));
    return;
  }
  const merged = [...selectedFiles, ...imageFiles].slice(0, 5);
  selectedFiles = merged;
  renderThumbs();
  updateStartBtn();
}

function renderThumbs() {
  thumbCont.innerHTML = '';
  if (selectedFiles.length === 0) {
    thumbCont.classList.add('hidden');
    photoMsg.classList.add('hidden');
    return;
  }
  thumbCont.classList.remove('hidden');
  photoMsg.classList.remove('hidden');
  photoMsg.textContent = selectedFiles.length + ' photo' + (selectedFiles.length > 1 ? 's' : '') + ' selected' + (selectedFiles.length === 1 ? ' (Primary)' : ' (first = Primary)');
  selectedFiles.forEach((file, idx) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = document.createElement('img');
      img.src = e.target.result;
      img.title = (idx === 0 ? '★ Primary — ' : '') + file.name;
      if (idx === 0) img.style.borderColor = '#6366f1';
      thumbCont.appendChild(img);
    };
    reader.readAsDataURL(file);
  });
}

// ── Style picker ─────────────────────────────────────────────────────────────

const styleGrid  = document.getElementById('style-grid');
const styleLabel = document.getElementById('style-count-label');

STYLES.forEach(s => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.styleId = s.id;
  btn.className = 'style-btn border-2 border-gray-200 rounded-lg px-4 py-3 text-left hover:border-indigo-300 transition';
  btn.innerHTML = '<span class="style-check text-indigo-600 mr-1">✓</span>' + s.label;
  btn.addEventListener('click', () => toggleStyle(s.id, btn));
  styleGrid.appendChild(btn);
});

function toggleStyle(id, btn) {
  if (selectedStyles.includes(id)) {
    selectedStyles = selectedStyles.filter(s => s !== id);
    btn.classList.remove('selected');
  } else {
    if (selectedStyles.length >= 3) return; // hard cap at 3
    selectedStyles.push(id);
    btn.classList.add('selected');
  }
  styleLabel.textContent = selectedStyles.length + '/3 selected';
  updateStartBtn();
}

// ── Start button ─────────────────────────────────────────────────────────────

const startBtn = document.getElementById('start-btn');

function updateStartBtn() {
  const ready = selectedFiles.length >= 1 && selectedStyles.length === 3;
  startBtn.disabled = !ready;
}

startBtn.addEventListener('click', runGeneration);

// ── Generation ───────────────────────────────────────────────────────────────

const progressArea = document.getElementById('progress-area');
const progressText = document.getElementById('progress-text');
const analysisBlock = document.getElementById('analysis-block');
const analysisGrid  = document.getElementById('analysis-grid');
const resultsArea  = document.getElementById('results-area');
const resultsGrid  = document.getElementById('results-grid');
const errorArea    = document.getElementById('error-area');
const againBtn     = document.getElementById('again-btn');

againBtn.addEventListener('click', resetUI);

async function runGeneration() {
  clearError();
  startBtn.disabled = true;
  progressArea.classList.remove('hidden');
  resultsArea.classList.add('hidden');
  analysisBlock.classList.add('hidden');
  progressText.textContent = '📷 Photo mil gayi! 3 ads bana rahe hain...';

  const formData = new FormData();
  selectedFiles.forEach(f => formData.append('photos', f));
  selectedStyles.forEach(s => formData.append('styles', s));
  const instructions = document.getElementById('instructions').value.trim();
  if (instructions) formData.append('instructions', instructions);

  const url = '/admin/test/generate' + (ADMIN_KEY ? '?key=' + encodeURIComponent(ADMIN_KEY) : '');

  let resp;
  try {
    resp = await fetch(url, { method: 'POST', body: formData });
  } catch (err) {
    progressArea.classList.add('hidden');
    startBtn.disabled = false;
    showError('Network error: ' + err.message);
    return;
  }

  if (!resp.ok) {
    progressArea.classList.add('hidden');
    startBtn.disabled = false;
    let msg = 'Server error ' + resp.status;
    try { const j = await resp.json(); msg = j.error || msg; } catch {}
    showError(msg);
    return;
  }

  let data;
  try { data = await resp.json(); } catch {
    progressArea.classList.add('hidden');
    startBtn.disabled = false;
    showError('Invalid JSON response from server.');
    return;
  }

  // Show analysis
  if (data.analysis) {
    const a = data.analysis;
    analysisBlock.classList.remove('hidden');
    analysisGrid.innerHTML = '';
    [
      { label: 'Product', value: a.productName },
      { label: 'Category', value: a.productCategory },
      { label: 'Items', value: a.itemCount > 1 ? a.itemCount + 'x — ' + a.items.join(', ') : (a.items?.[0] ?? a.productName) },
      { label: 'Set', value: a.setDescription || '—' },
    ].forEach(({ label, value }) => {
      const div = document.createElement('div');
      div.className = 'bg-gray-50 rounded-lg p-3';
      div.innerHTML = '<p class="text-xs text-gray-400 mb-0.5">' + label + '</p><p class="text-gray-800 font-medium text-sm">' + escHtml(value) + '</p>';
      analysisGrid.appendChild(div);
    });
  }

  // Show results
  progressArea.classList.add('hidden');
  resultsArea.classList.remove('hidden');
  resultsGrid.innerHTML = '';

  const results = data.results ?? [];
  results.forEach((r, idx) => {
    const styleLabel = STYLES.find(s => s.id === r.style)?.label ?? r.style;
    const card = document.createElement('div');
    card.className = 'result-card bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden';

    const qaIcon   = r.qaScore >= 65 ? '✅' : '⚠️';
    const qaClass  = r.qaScore >= 65 ? 'text-green-700' : 'text-yellow-700';
    const tierBadge = r.tier ? 'Tier ' + r.tier + ' — ' + (r.pipeline ?? '') : (r.pipeline ?? '');

    if (r.error) {
      card.innerHTML =
        '<div class="p-4">' +
          '<p class="font-semibold text-gray-800 mb-1">' + escHtml(styleLabel) + ' <span class="text-gray-400 text-xs">' + (idx+1) + '/3</span></p>' +
          '<div class="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">' +
            '<p class="font-medium mb-1">Generation failed</p>' +
            '<p class="font-mono text-xs break-all">' + escHtml(r.error) + '</p>' +
          '</div>' +
        '</div>';
    } else {
      // Input thumb (primary photo) — small DataURL we stashed
      const thumbHtml = data.primaryThumbDataUrl
        ? '<div class="mt-3"><p class="text-xs text-gray-400 mb-1">Input (Primary)</p><img src="' + escHtml(data.primaryThumbDataUrl) + '" class="h-12 w-auto rounded border border-gray-200" /></div>'
        : '';

      card.innerHTML =
        '<img src="' + escHtml(r.outputUrl) + '" class="w-full aspect-square object-cover" />' +
        '<div class="p-4">' +
          '<p class="font-semibold text-gray-800 mb-1">' + escHtml(styleLabel) + ' <span class="text-gray-400 text-xs">(' + (idx+1) + '/3)</span></p>' +
          '<div class="flex items-center gap-3 text-xs mb-3">' +
            '<span class="' + qaClass + '">' + qaIcon + ' QA ' + r.qaScore + '</span>' +
            '<span class="text-gray-400">⏱ ' + ((r.durationMs ?? 0) / 1000).toFixed(1) + 's</span>' +
            '<span class="text-gray-400 italic">' + escHtml(tierBadge) + '</span>' +
          '</div>' +
          (r.prompt
            ? '<div class="mt-3 mb-3">' +
                '<div class="flex items-center justify-between mb-1">' +
                  '<span class="text-xs text-gray-500 uppercase tracking-wide">Prompt sent to Gemini</span>' +
                  '<button onclick="copyPrompt(this)" class="text-xs text-indigo-600 hover:text-indigo-800 font-medium transition">Copy</button>' +
                '</div>' +
                '<pre class="bg-gray-50 border border-gray-200 rounded p-3 text-xs text-gray-800 font-mono whitespace-pre-wrap max-h-52 overflow-y-auto">' + escHtml(r.prompt) + '</pre>' +
              '</div>'
            : '') +
          thumbHtml +
          '<a href="' + escHtml(r.outputUrl) + '" download class="mt-3 block text-center text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg py-2 transition">Download</a>' +
        '</div>';
    }

    resultsGrid.appendChild(card);
  });
}

function resetUI() {
  selectedFiles = [];
  selectedStyles = [];
  renderThumbs();
  document.querySelectorAll('.style-btn').forEach(b => b.classList.remove('selected'));
  styleLabel.textContent = '0/3 selected';
  document.getElementById('instructions').value = '';
  resultsArea.classList.add('hidden');
  clearError();
  updateStartBtn();
}

function showError(msg) {
  errorArea.textContent = msg;
  errorArea.classList.remove('hidden');
}
function clearError() {
  errorArea.classList.add('hidden');
  errorArea.textContent = '';
}
function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function copyPrompt(btn) {
  const pre = btn.closest('div').nextElementSibling;
  const text = pre ? pre.textContent : '';
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1500);
  }).catch(() => {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

const GenerateBodySchema = z.object({
  styles: z.array(z.string()).min(3).max(3),
  instructions: z.string().optional(),
});

export async function adminTestRoutes(app: FastifyInstance): Promise<void> {
  // Register multipart support scoped to this plugin
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB per file
      files: 5,
    },
  });

  // ── GET /admin/test ──────────────────────────────────────────────────────
  app.get('/admin/test', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(req, reply)) return;

    const adminKey = (req.query as Record<string, string>)['key'] ?? '';
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(buildHtml(adminKey));
  });

  // ── POST /admin/test/generate ────────────────────────────────────────────
  app.post('/admin/test/generate', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(req, reply)) return;

    const parts = req.parts();

    let photoBuffers: Array<{ buffer: Buffer; mimetype: string; filename: string }> = [];
    let rawStyles: string[] = [];
    let instructions: string | undefined;

    // Parse multipart fields and files
    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname === 'photos') {
          if (!part.mimetype.startsWith('image/')) {
            await part.toBuffer(); // drain
            return reply.code(400).send({
              error: `File "${part.filename}" is not an image`,
              code: 'INVALID_FILE_TYPE',
            });
          }
          const buffer = await part.toBuffer();
          photoBuffers.push({ buffer, mimetype: part.mimetype, filename: part.filename ?? 'photo.jpg' });
          if (photoBuffers.length > 5) {
            return reply.code(400).send({ error: 'Maximum 5 photos allowed', code: 'TOO_MANY_PHOTOS' });
          }
        } else {
          await part.toBuffer(); // drain unexpected files
        }
      } else {
        // field
        const value = part.value as string;
        if (part.fieldname === 'styles') rawStyles.push(value);
        if (part.fieldname === 'instructions') instructions = value.trim() || undefined;
      }
    }

    // Validate
    if (photoBuffers.length === 0) {
      return reply.code(400).send({ error: 'At least 1 photo required', code: 'NO_PHOTOS' });
    }

    const parsed = GenerateBodySchema.safeParse({ styles: rawStyles, instructions });
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.errors[0]?.message ?? 'Invalid input',
        code: 'VALIDATION_ERROR',
      });
    }

    const { styles } = parsed.data;

    // Upload primary photo to Supabase
    const primary = photoBuffers[0]!;
    const storagePath = `admin-test-${Date.now()}.jpg`;
    let imageUrl: string;

    try {
      imageUrl = await uploadFile('raw-images', storagePath, primary.buffer, primary.mimetype);
    } catch (err) {
      app.log.error({ err }, 'Admin test: failed to upload primary photo');
      return reply.code(500).send({
        error: 'Failed to upload photo to storage',
        code: 'STORAGE_UPLOAD_FAILED',
      });
    }

    // Collect reference buffers (all photos except primary)
    const referenceImageBuffers = photoBuffers.slice(1).map(p => p.buffer);

    // Light analysis (once, shared across all styles) — pass all photo buffers
    let analysis;
    try {
      analysis = await lightAnalyze([primary.buffer, ...referenceImageBuffers]);
    } catch (err) {
      app.log.warn({ err }, 'Admin test: lightAnalyze failed — continuing with fallback');
      // Minimal fallback so generation can still proceed
      analysis = {
        productName: 'product',
        productCategory: 'other',
        hasBranding: true,
        physicalSize: 'medium' as const,
        dominantColors: ['neutral'],
        typicalSetting: 'tabletop',
        usable: true,
        itemCount: 1,
        items: ['product'],
        setDescription: null,
      };
    }

    // Run 3 style generations in parallel
    const generationTasks = styles.map(async (style) => {
      const styleStart = Date.now();

      // Capture the prompt before running (same call the pipeline uses internally)
      let prompt: string;
      try {
        prompt = getStylePromptV5(style, 'DIRECT', analysis, instructions);
      } catch {
        prompt = '(prompt generation failed)';
      }

      try {
        const result = await processImageNeverFail({
          imageUrl,
          style,
          productCategory: analysis.productCategory,
          voiceInstructions: instructions,
          referenceImageBuffers: referenceImageBuffers.length > 0 ? referenceImageBuffers : undefined,
        });

        return {
          style,
          outputUrl: result.outputUrl,
          qaScore: result.qaScore,
          pipeline: result.pipeline,
          tier: result.tier,
          tierReason: result.tierReason,
          durationMs: result.durationMs ?? (Date.now() - styleStart),
          prompt,
          error: null as string | null,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        app.log.error({ err, style }, 'Admin test: generation failed for style');
        return {
          style,
          outputUrl: null as string | null,
          qaScore: 0,
          pipeline: null as string | null,
          tier: null as number | null,
          tierReason: null as string | null,
          durationMs: Date.now() - styleStart,
          prompt,
          error: errMsg,
        };
      }
    });

    const results = await Promise.all(generationTasks);

    app.log.info(
      {
        styles,
        imageUrl,
        resultCount: results.length,
        successCount: results.filter(r => !r.error).length,
      },
      'Admin test: generation complete',
    );

    return reply.send({ analysis, results });
  });
}
