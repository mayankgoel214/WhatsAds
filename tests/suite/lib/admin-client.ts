import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AnalysisResult } from './types.js';

// ---------------------------------------------------------------------------
// Image mode result
// ---------------------------------------------------------------------------

export interface AdminGenerateResult {
  analysis: AnalysisResult;
  results: Array<{
    style: string;
    outputUrl: string;
    prompt: string;
    qaScore: number;
    durationMs: number;
    tier: number;
    pipeline: string;
    error: string | null;
  }>;
}

export async function generateViaAdminApi(params: {
  adminUrl: string;
  adminKey: string;
  photoPaths: string[];
  styles: string[];                    // exactly 3
  instructions: string | null;
  timeoutMs?: number;
}): Promise<AdminGenerateResult> {
  if (params.styles.length !== 3) {
    throw new Error(`Admin API requires exactly 3 styles, got ${params.styles.length}`);
  }

  const formData = new FormData();
  for (const photoPath of params.photoPaths) {
    const buf = await readFile(photoPath);
    const blob = new Blob([buf], { type: 'image/jpeg' });
    formData.append('photos', blob, basename(photoPath));
  }
  for (const style of params.styles) {
    formData.append('styles', style);
  }
  if (params.instructions) {
    formData.append('instructions', params.instructions);
  }
  formData.append('mediaType', 'image');

  const url = `${params.adminUrl}/admin/test/generate?key=${encodeURIComponent(params.adminKey)}`;
  const timeout = params.timeoutMs ?? 180_000; // 3 min default

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Admin API returned ${resp.status}: ${text.slice(0, 500)}`);
    }
    const data = await resp.json() as AdminGenerateResult & { analysis: { productName?: string; items?: string[] } };
    // Detect analyzer fallback: silent fallback returns generic "product" name
    if (data.analysis) {
      data.analysis.analyzerFellBack =
        data.analysis.productName === 'product' ||
        (data.analysis.items?.length === 1 && data.analysis.items[0] === 'product');
    }
    return data as AdminGenerateResult;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Video mode result
// ---------------------------------------------------------------------------

export interface AdminVideoResult {
  analysis: AnalysisResult;
  video: {
    videoStyle: string;
    videoUrl: string | null;
    prompt: string;
    voiceoverText?: string;
    aspectRatio: string;
    durationSec: number;
    durationMs: number;
    modelId: string;
    error: string | null;
  };
}

export async function generateVideoViaAdminApi(params: {
  adminUrl: string;
  adminKey: string;
  photoPaths: string[];
  videoStyle: string;                  // video_cinematic | video_ugc | video_demo
  videoDuration?: number;              // seconds, default 5
  aspectRatio?: '1:1' | '9:16' | '16:9';
  voiceoverText?: string;
  voiceoverLanguage?: 'en' | 'hi' | 'hinglish';
  instructions?: string | null;
  timeoutMs?: number;
}): Promise<AdminVideoResult> {
  const formData = new FormData();

  for (const photoPath of params.photoPaths) {
    const buf = await readFile(photoPath);
    const blob = new Blob([buf], { type: 'image/jpeg' });
    formData.append('photos', blob, basename(photoPath));
  }

  formData.append('mediaType', 'video');
  formData.append('videoStyle', params.videoStyle);
  formData.append('videoDuration', String(params.videoDuration ?? 5));
  formData.append('aspectRatio', params.aspectRatio ?? '9:16');
  formData.append('voiceoverLanguage', params.voiceoverLanguage ?? 'hinglish');

  if (params.voiceoverText) {
    formData.append('voiceoverText', params.voiceoverText);
  }
  if (params.instructions) {
    formData.append('instructions', params.instructions);
  }

  const url = `${params.adminUrl}/admin/test/generate?key=${encodeURIComponent(params.adminKey)}`;
  const timeout = params.timeoutMs ?? 300_000; // 5 min — video takes longer

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Admin API returned ${resp.status}: ${text.slice(0, 500)}`);
    }
    const data = await resp.json() as AdminVideoResult & { analysis: { productName?: string; items?: string[] } };
    if (data.analysis) {
      data.analysis.analyzerFellBack =
        data.analysis.productName === 'product' ||
        (data.analysis.items?.length === 1 && data.analysis.items[0] === 'product');
    }
    return data as AdminVideoResult;
  } finally {
    clearTimeout(timer);
  }
}
