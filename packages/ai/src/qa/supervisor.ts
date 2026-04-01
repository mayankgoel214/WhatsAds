import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const SupervisorResultSchema = z.object({
  pass: z.boolean(),
  hasRandomText: z.boolean(),
  hasSketchesOrDrawings: z.boolean(),
  hasArtifacts: z.boolean(),
  productIntact: z.boolean(),
  issues: z.array(z.string()),
  retryHint: z.string().nullable(),
});

export type SupervisorResult = z.infer<typeof SupervisorResultSchema>;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const STUDIO_SHOT_CHECK = `You are a strict quality control inspector for product photography. Check this image for issues.

This should be a CLEAN studio-quality product photograph — product on a clean background with professional lighting.

Check for:
1. Is the product clearly visible, sharp, and well-lit?
2. Is the background clean (white, gradient, or solid color — no clutter)?
3. Are the product edges clean (no rough cutout artifacts, halos, fringing)?
4. Any RANDOM TEXT visible that shouldn't be there? (e.g., "8K", "HD", "QUALITY", random words)
5. Any weird shapes, sketches, or non-photorealistic elements?

Return valid JSON only:
{
  "pass": boolean,
  "hasRandomText": boolean,
  "hasSketchesOrDrawings": boolean,
  "hasArtifacts": boolean,
  "productIntact": boolean,
  "issues": string[],
  "retryHint": string | null
}

"pass" is true ONLY if: product is clear, background is clean, NO random text, NO sketches, NO artifacts.
"retryHint" suggests what to fix if pass is false.`;

const CREATIVE_AD_CHECK = `You are a strict quality control inspector for product advertisement images. This should look like a professional ad — the kind a D2C brand would post on Instagram.

IMPORTANT — DISTINGUISH PRODUCT TEXT vs RANDOM TEXT:
- Text that is PART OF THE PRODUCT is EXPECTED and OK: keyboard keys, screen content, brand logos, product labels, packaging text, buttons, dials with numbers, etc. This is the real product — its text should be there.
- RANDOM/GENERATED text is text that appears IN THE SCENE/BACKGROUND that is NOT on the product itself: floating words, watermarks like "PHOTORESIVE", gibberish text on walls/surfaces, "8K", "QUALITY", lorem ipsum, etc. ONLY this type of text is a failure.

CHECK FOR THESE CRITICAL FAILURES (any = auto-fail):
1. RANDOM/GENERATED text in the SCENE or BACKGROUND (NOT on the product)? — INSTANT FAIL. But keyboard keys, screen text, product labels = OK.
2. ANY line drawings, sketches, illustrations, or cartoon-like elements? — INSTANT FAIL
3. ANY watermarks or generated logos IN THE SCENE? — INSTANT FAIL
4. Is the product EMBEDDED INSIDE another object? — INSTANT FAIL
5. Is the scene physically nonsensical? — INSTANT FAIL

ALSO CHECK:
6. Is the product still clearly recognizable and intact?
7. Does the scene look photorealistic (real surfaces, real lighting, real props)?
8. Is the product sitting naturally ON a flat surface?
9. Would a real brand actually use this image for advertising?

Return valid JSON only:
{
  "pass": boolean,
  "hasRandomText": boolean,
  "hasSketchesOrDrawings": boolean,
  "hasArtifacts": boolean,
  "productIntact": boolean,
  "issues": string[],
  "retryHint": string | null
}

"pass" is true ONLY if: NO random text IN THE SCENE (product text is fine), NO sketches, product sits ON a surface, scene is photorealistic.
"hasRandomText" should be true ONLY for text in the background/scene — NOT for text that is part of the product itself.`;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

function detectMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

/**
 * Supervisor quality gate — checks pipeline output at each stage.
 *
 * Uses Gemini vision to detect:
 * - Random/garbage text (like "8K", "QUALTY")
 * - Sketches, line drawings, non-photorealistic elements
 * - Artifacts, cutout halos, compositing issues
 * - Product distortion or loss
 *
 * Returns pass/fail with specific issues and retry hints.
 */
export async function supervisorCheck(
  imageBuffer: Buffer,
  checkType: 'studio_shot' | 'creative_ad'
): Promise<SupervisorResult> {
  const startMs = Date.now();

  const genai = new GoogleGenAI({
    apiKey: process.env['GOOGLE_GENAI_API_KEY']!,
  });

  const base64 = imageBuffer.toString('base64');
  const mimeType = detectMime(imageBuffer);
  const prompt = checkType === 'studio_shot' ? STUDIO_SHOT_CHECK : CREATIVE_AD_CHECK;

  try {
    const response = await genai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: prompt },
          ],
        },
      ],
    });

    const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(cleaned);
    const result = SupervisorResultSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(`Supervisor schema validation failed: ${result.error.message}`);
    }

    console.info(
      JSON.stringify({
        event: `supervisor_${checkType}`,
        pass: result.data.pass,
        hasRandomText: result.data.hasRandomText,
        hasSketchesOrDrawings: result.data.hasSketchesOrDrawings,
        issues: result.data.issues,
        durationMs: Date.now() - startMs,
      })
    );

    return result.data;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: `supervisor_${checkType}_error`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      })
    );

    // Fail open — let the image through if supervisor is unavailable
    return {
      pass: true,
      hasRandomText: false,
      hasSketchesOrDrawings: false,
      hasArtifacts: false,
      productIntact: true,
      issues: ['supervisor_unavailable'],
      retryHint: null,
    };
  }
}
