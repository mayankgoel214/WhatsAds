import { fal } from '@fal-ai/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KontextShotInput {
  /** URL of the original product image */
  imageUrl: string;
  /** Scene/background prompt — should instruct to keep product unchanged */
  prompt: string;
}

interface KontextShotOutput {
  outputUrl: string;
}

// ---------------------------------------------------------------------------
// fal.ai client configuration
// ---------------------------------------------------------------------------

const KONTEXT_MODEL = 'fal-ai/flux-pro/kontext';
const TIMEOUT_MS = 60_000; // Kontext can take longer than Bria

function ensureFalConfig() {
  const key = process.env['FAL_KEY'] ?? process.env['FAL_API_KEY'] ?? '';
  fal.config({ credentials: key });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run Flux Kontext Pro via fal.ai.
 *
 * Kontext Pro is an image-to-image model that edits the scene around the
 * product while preserving the original product's appearance. Unlike Bria
 * Product Shot which regenerates the product, Kontext Pro keeps the product
 * pixels faithful to the input.
 *
 * @throws Error if the API call fails or times out.
 */
export async function runKontextShot(
  params: KontextShotInput
): Promise<KontextShotOutput> {
  ensureFalConfig();
  const startMs = Date.now();

  console.info(
    JSON.stringify({
      event: 'kontext_shot_start',
      model: KONTEXT_MODEL,
      promptPreview: params.prompt.slice(0, 100),
    })
  );

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Kontext Pro timed out after ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS
    )
  );

  const apiPromise = fal.subscribe(KONTEXT_MODEL as string, {
    input: {
      image_url: params.imageUrl,
      prompt: params.prompt,
    },
    logs: false,
  });

  // Race against timeout
  const result = (await Promise.race([apiPromise, timeoutPromise])) as {
    data: {
      images?: Array<{ url: string }>;
      image?: { url: string };
    };
    requestId: string;
  };

  // Handle both possible output shapes from fal.ai
  const outputUrl =
    result.data?.images?.[0]?.url ?? result.data?.image?.url ?? null;

  if (!outputUrl) {
    throw new Error(
      `Kontext Pro returned no output URL. requestId=${result.requestId ?? 'unknown'}`
    );
  }

  console.info(
    JSON.stringify({
      event: 'kontext_shot_complete',
      outputUrl,
      durationMs: Date.now() - startMs,
    })
  );

  return { outputUrl };
}
