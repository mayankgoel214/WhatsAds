import { GoogleGenAI } from '@google/genai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FocusedCheckResult {
  productCount: number;
  hasFundamentalDefect: boolean;
  defectDescription: string | null;
  hasRandomTextOrSketch: boolean;
  hasAnatomyIssue: boolean;
  anatomyDescription: string | null;
  pass: boolean;
  failReasons: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClient(): GoogleGenAI {
  const key = process.env.GOOGLE_AI_API_KEY ?? process.env.GOOGLE_GENAI_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_AI_API_KEY');
  return new GoogleGenAI({ apiKey: key });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const timer = new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms));
  return Promise.race([promise, timer]);
}

async function askBinaryQuestion(
  client: GoogleGenAI,
  imageBuffer: Buffer,
  prompt: string,
): Promise<string> {
  const response = await client.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } },
          { text: prompt },
        ],
      },
    ],
    config: {
      temperature: 0.1, // very low for factual answers
      maxOutputTokens: 100,
    },
  });

  return response.text?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkProductCount(
  client: GoogleGenAI,
  outputBuffer: Buffer,
  productName: string,
): Promise<{ count: number; raw: string }> {
  const prompt = `Count the number of "${productName}" (or very similar products) visible in this advertisement image.

Count EACH separate instance — if you see 2 copies of the same product, answer 2. If there is one product shown from one angle, answer 1. Do NOT count reflections on polished/acrylic/glass surfaces as separate products — those are reflections, not duplicates. Do NOT count shadows as separate instances.

Reply with ONLY a single number (e.g., "1" or "2"). Nothing else.`;

  const raw = await askBinaryQuestion(client, outputBuffer, prompt);
  const match = raw.match(/\d+/);
  const count = match ? parseInt(match[0], 10) : 1;
  return { count, raw };
}

async function checkFundamentalDefects(
  client: GoogleGenAI,
  outputBuffer: Buffer,
): Promise<{ hasDefect: boolean; description: string | null; raw: string }> {
  const prompt = `Inspect this product advertisement image for CRITICAL defects only. Check for:

1. Product is melted, warped, or has wrong proportions
2. Major rendering artifacts: half-rendered objects, glitch patterns, smeared/blurry regions covering >10% of image
3. Product is clearly floating in mid-air (no surface contact at all)
4. Product is merged into or growing out of another object
5. Product is severely distorted — wrong shape, wrong color, unrecognizable vs what a real product would look like
6. Scene has impossible physics — objects embedded in walls, surfaces at impossible angles
7. Product looks like a CGI RENDER or CARTOON instead of a photographed physical object — uniformly smooth surfaces with no specular highlights, no material texture, no packaging crinkle, looks like a flat digital illustration rather than a real product under real lighting

Do NOT flag minor issues like slight color differences, soft focus in background, or subtle texture artifacts.

If you find ANY critical defect, reply: "YES: [one sentence describing the defect]"
If the image looks clean with no critical defects, reply: "NO"

Reply YES or NO only.`;

  const raw = await askBinaryQuestion(client, outputBuffer, prompt);
  const isYes = raw.toUpperCase().startsWith('YES');
  const description = isYes ? raw.replace(/^YES:?\s*/i, '').trim() || null : null;
  return { hasDefect: isYes, description, raw };
}

async function checkHumanAnatomy(
  client: GoogleGenAI,
  outputBuffer: Buffer,
): Promise<{ hasIssue: boolean; description: string | null; raw: string }> {
  const prompt = `Inspect this image for human anatomy problems. If there is NO person in the image, reply "NO" immediately.

If a person IS present, carefully check:
1. LIMB COUNT: Does the person have exactly 2 arms and exactly 2 legs? Count carefully — look for phantom/extra limbs, especially in seated or curled poses where legs may overlap. A third leg or arm is a critical failure.
2. HAND COUNT: Exactly 2 hands, each with exactly 5 fingers (4 fingers + 1 thumb). Count each finger individually.
3. FEET: Exactly 2 feet. No extra feet visible.
4. FACE: 2 eyes, 1 nose, 1 mouth. Eyes should focus on the same point. No distorted facial features.
5. PROPORTIONS: Natural human body proportions — no elongated/shortened limbs, no oversized/undersized head.

If ANY anatomy issue exists, reply: "YES: [describe the specific issue]"
If anatomy looks correct OR no person is present, reply: "NO"

Reply YES or NO only.`;

  const raw = await askBinaryQuestion(client, outputBuffer, prompt);
  const isYes = raw.toUpperCase().startsWith('YES');
  const description = isYes ? raw.replace(/^YES:?\s*/i, '').trim() || null : null;
  return { hasIssue: isYes, description, raw };
}

async function checkRandomTextAndSketches(
  client: GoogleGenAI,
  outputBuffer: Buffer,
): Promise<{ hasIssue: boolean; raw: string }> {
  const prompt = `Check this advertisement image for TWO things:

1. RANDOM TEXT: Is there any generated/random text in the BACKGROUND or SCENE that is NOT part of the product itself? Product labels, brand names ON the product, keyboard keys — those are fine. But random words, "8K", "QUALITY", gibberish text, watermarks in the scene = problem. EXCEPTION: A small "AI Generated by Clickkar" label at the very bottom is INTENTIONAL — ignore it.

2. SKETCHES/CARTOONS: Does any part of the image look like a line drawing, sketch, illustration, or cartoon instead of a photograph?

If EITHER issue exists, reply: "YES"
If the image is clean (photorealistic, no random scene text), reply: "NO"

Reply YES or NO only.`;

  const raw = await askBinaryQuestion(client, outputBuffer, prompt);
  const isYes = raw.toUpperCase().startsWith('YES');
  return { hasIssue: isYes, raw };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Layer 1: Focused AI binary questions.
 * Fires 3 independent Gemini calls in parallel (~2s wall clock).
 * Each asks ONE specific yes/no question — far more reliable than omnibus scoring.
 */
export async function runFocusedChecks(
  outputBuffer: Buffer,
  productName: string,
): Promise<FocusedCheckResult> {
  const client = getClient();

  const result: FocusedCheckResult = {
    productCount: 1,
    hasFundamentalDefect: false,
    defectDescription: null,
    hasRandomTextOrSketch: false,
    hasAnatomyIssue: false,
    anatomyDescription: null,
    pass: true,
    failReasons: [],
  };

  // Fire all 4 checks in parallel with timeout
  // CRITICAL: timeout defaults to FAIL (not pass) to prevent bad images slipping through
  const [countResult, defectResult, textResult, anatomyResult] = await Promise.all([
    withTimeout(
      checkProductCount(client, outputBuffer, productName),
      TIMEOUT_MS,
      { count: -1, raw: 'timeout' }, // -1 = unknown, treated as fail
    ),
    withTimeout(
      checkFundamentalDefects(client, outputBuffer),
      TIMEOUT_MS,
      { hasDefect: true, description: 'check timed out — assuming defect', raw: 'timeout' },
    ),
    withTimeout(
      checkRandomTextAndSketches(client, outputBuffer),
      TIMEOUT_MS,
      { hasIssue: true, raw: 'timeout' }, // assume issue on timeout
    ),
    withTimeout(
      checkHumanAnatomy(client, outputBuffer),
      TIMEOUT_MS,
      { hasIssue: false, description: null, raw: 'timeout' }, // anatomy timeout = pass (most images don't have people)
    ),
  ]);

  result.productCount = countResult.count;
  result.hasFundamentalDefect = defectResult.hasDefect;
  result.defectDescription = defectResult.description;
  result.hasRandomTextOrSketch = textResult.hasIssue;
  result.hasAnatomyIssue = anatomyResult.hasIssue;
  result.anatomyDescription = anatomyResult.description;

  console.info(JSON.stringify({
    event: 'focused_checks_complete',
    productCount: countResult.count,
    productCountRaw: countResult.raw,
    hasFundamentalDefect: defectResult.hasDefect,
    defectDescription: defectResult.description,
    hasRandomTextOrSketch: textResult.hasIssue,
    hasAnatomyIssue: anatomyResult.hasIssue,
    anatomyDescription: anatomyResult.description,
  }));

  // Evaluate pass/fail
  if (countResult.count !== 1) {
    result.pass = false;
    if (countResult.count === -1) {
      result.failReasons.push('product_count_timeout');
    } else if (countResult.count === 0) {
      result.failReasons.push('product_missing');
    } else {
      result.failReasons.push(`product_duplicated:count=${countResult.count}`);
    }
  }

  if (defectResult.hasDefect) {
    result.pass = false;
    result.failReasons.push(`fundamental_defect:${defectResult.description ?? 'unknown'}`);
  }

  if (textResult.hasIssue) {
    result.pass = false;
    result.failReasons.push('random_text_or_sketch');
  }

  if (anatomyResult.hasIssue) {
    result.pass = false;
    result.failReasons.push(`anatomy_issue:${anatomyResult.description ?? 'unknown'}`);
  }

  return result;
}
