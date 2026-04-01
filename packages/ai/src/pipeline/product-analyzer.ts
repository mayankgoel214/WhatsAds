import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ProductAnalysisSchema = z.object({
  productName: z.string(),
  brandName: z.string().nullable(),
  productType: z.string(),
  specificDescription: z.string(),
  dominantColors: z.array(z.string()),
  material: z.string(),
  shape: z.string(),
  keyVisualElements: z.array(z.string()),
  visibleText: z.array(z.string()),
  targetAudience: z.string(),
  priceSegment: z.enum(['budget', 'mid_range', 'premium', 'luxury']),
  salesChannel: z.string(),
  desiredEmotion: z.string(),
  recommendedScene: z.object({
    surface: z.string(),
    background: z.string(),
    lighting: z.string(),
    colorPalette: z.string(),
    props: z.array(z.string()),
    mood: z.string(),
    photographyStyle: z.string(),
  }),
  category: z.enum([
    'food', 'jewellery', 'garment', 'skincare', 'candle',
    'bag', 'home_goods', 'electronics', 'handicraft', 'other',
  ]),
  adBestPractices: z.string(),
});

export type ProductAnalysis = z.infer<typeof ProductAnalysisSchema>;

// Consolidated output — single Gemini call returns everything
const AnalyzeAndPlanSchema = z.object({
  // Input QA
  usable: z.boolean(),
  rejectionReason: z.string().nullable(),
  productCategory: z.enum([
    'food', 'jewellery', 'garment', 'skincare', 'candle',
    'bag', 'home_goods', 'electronics', 'handicraft', 'other',
  ]),

  // Branding detection
  hasBranding: z.boolean(),
  brandingConfidence: z.number().min(0).max(1),
  brandElements: z.array(z.string()),

  // Input quality
  hasGlare: z.boolean(),
  inputAngleQuality: z.enum(['good', 'suboptimal', 'unusable']),

  // Product analysis
  analysis: ProductAnalysisSchema,

  // Creative prompts
  scenePrompt: z.string(),
  backgroundOnlyPrompt: z.string(),
});

export type AnalyzeAndPlanResult = z.infer<typeof AnalyzeAndPlanSchema>;

// ---------------------------------------------------------------------------
// Consolidated prompt — replaces 3 separate Gemini calls
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Style-specific technical briefs — exact photographic specifications
// ---------------------------------------------------------------------------

const STYLE_BRIEFS: Record<string, string> = {
  style_clean_white: `STYLE: STUDIO WHITE
Surface: Seamless pure white sweep (paper or acrylic)
Background: Pure white (#FFFFFF), blown out 1-2 stops above key light
Lighting: Large softbox at 45° front-left, white V-flat fill opposite, 2:1 light ratio, 5600K daylight
Shadow: Soft contact shadow only, directly beneath product
Props: NONE. Product only. Absolutely no props.
Angle: Eye level to slightly above (0-15°)
Mood: Clean, trustworthy, detail-focused. Amazon/Flipkart listing quality.
Key: Even, flat lighting. No dramatic shadows. Product colors accurate.`,

  style_studio: `STYLE: STUDIO WHITE
Surface: Seamless pure white sweep (paper or acrylic)
Background: Pure white (#FFFFFF), blown out 1-2 stops above key light
Lighting: Large softbox at 45° front-left, white V-flat fill opposite, 2:1 light ratio, 5600K daylight
Shadow: Soft contact shadow only, directly beneath product
Props: NONE. Product only. Absolutely no props.
Angle: Eye level to slightly above (0-15°)
Mood: Clean, trustworthy, detail-focused.
Key: Even, flat lighting. No dramatic shadows. Product colors accurate.`,

  style_gradient: `STYLE: DRAMATIC DARK
Surface: Black reflective acrylic or polished obsidian showing product REFLECTION on the surface
Background: Deep black to charcoal gradient, no detail visible
Lighting: TWO strip softbox rim lights — one from behind-left, one from behind-right. Product edges GLOW with rim light. 8:1+ contrast ratio. Warm key (3200K), cool rim (6500K).
Props: None, or a single accent element (scattered gold dust particles, a few water droplets)
Angle: Eye level or SLIGHTLY BELOW (hero angle, -5 to 0°) — makes product look powerful
Mood: Premium, luxurious, exclusive, powerful
Key: Product edges glow against black. Surface shows subtle reflection. High contrast. Dark and moody.`,

  style_lifestyle: `STYLE: WARM LIFESTYLE
Surface: Natural wood table (oak or walnut grain visible), linen cloth, or woven jute mat
Background: Blurred warm domestic interior (out of focus bookshelf, plant, window), shallow depth of field with visible bokeh
Lighting: Window light simulation, warm 3200-4000K, directional from one side creating visible shadows, 3:1-4:1 ratio
Props: 2-3 small contextual items that complement the product (coffee cup, small plant, open book, candle). Props are SMALLER than the product.
Angle: 30-45° above, slightly off-center composition
Mood: Cozy, aspirational, "I want this in my life"
Key: Warm color temperature throughout. Visible directional light with warm shadows. Real-world context. Shallow depth of field.`,

  style_festive: `STYLE: INDIAN FESTIVE
Surface: Brass thali/plate, richly embroidered silk cloth (maroon or gold), or dark wood with decorative elements
Background: Warm bokeh of lit diyas and fairy lights, rich gold and deep red tones, celebration atmosphere
Lighting: Warm 2800-3200K simulating diya/lamp light, multiple small warm point light sources creating golden bokeh, 2:1-3:1 ratio
Props: Marigold flowers (yellow/orange), lit diyas, scattered rose petals, brass utensils, silk fabric drape
Color palette: Gold, deep red/maroon, orange, saffron, touches of emerald green
Angle: 30-45° above
Mood: Celebration, warmth, Indian tradition, abundance, festive joy
Key: Multiple warm point light sources creating rich golden bokeh. Marigold and diya are signature elements.`,

  style_outdoor: `STYLE: OUTDOOR NATURAL
Surface: Weathered wood table/bench, stone ledge, or moss-covered rock
Background: HEAVILY blurred (f/1.8-2.8 simulation) lush green foliage with visible circular bokeh balls, golden hour backlight creating sun flares
Lighting: Natural daylight, open shade with golden hour backlight rimming the product, warm natural tones
Props: A few natural elements — a leaf, wildflower, water droplets on surface. Organic and minimal.
Angle: Eye level to slightly below (hero angle, -5 to 10°)
Mood: Fresh, natural, alive, healthy, organic
Key: STRONG background blur with visible circular bokeh. Natural green color palette. Sense of being outdoors in nature.`,

  style_minimal: `STYLE: MINIMAL CLEAN
Surface: White or light grey smooth concrete, pale birch wood, or matte pale surface
Background: Very soft neutral gradient (white to very light grey), almost featureless
Lighting: Large overhead softbox, very even illumination, 1.5:1 ratio, 5000K neutral
Props: Maximum ONE single accent item (small plant sprig, geometric brass shape, or single pebble)
Angle: 15-30° above
Mood: Zen, calm, sophisticated simplicity
Key: GENEROUS negative space — product occupies ~40% of frame with breathing room. Everything is understated. Less is more.`,

  style_with_model: `STYLE: WITH HUMAN MODEL
The product must be shown being HELD, WORN, or USED by a real-looking person.

MODEL SELECTION (you decide based on the product):
- Cosmetics/skincare/jewelry → Young Indian woman (20s-30s), elegant
- Men's accessories/gadgets/electronics → Indian man (25-35), confident
- Food/beverage → Varies by product personality — could be either gender
- Clothing → Person matching the garment's target audience and size
- General/home goods → Friendly Indian person, gender matching product audience

MODEL REQUIREMENTS:
- Indian/South Asian features, natural skin tone
- Natural, confident expression — NOT stiff, NOT awkward, NOT overly posed
- Person is SECONDARY to the product — product is still the HERO and most visible element
- Person shown from chest up or waist up (not full body unless clothing/shoes)
- Clean, simple clothing on the model (solid neutral colors — no competing patterns or logos)
- Hands must look natural if holding product (correct finger count, natural grip)

HOW THE PERSON INTERACTS WITH PRODUCT:
- Holding: Product in one or both hands, tilted toward camera so product face/label is visible
- Wearing: Product on body (jewelry on neck/wrist, bag on shoulder, clothing worn)
- Using: Drinking from bottle, applying skincare to face, typing on laptop, listening with headphones

SCENE:
- Background: Soft blurred neutral or lifestyle background (home, cafe, studio), shallow depth of field
- Lighting: Soft studio lighting, Rembrandt pattern (key light 45° front-left), warm 5000-5600K
- Color palette: Warm, inviting, matches product's brand energy
- Props: ABSOLUTELY NONE. No floating objects, no scattered elements, no ice cubes, no fruit, no petals, no particles. ONLY the person and the product. Clean and simple.

CRITICAL RULES:
- The product must be CLEARLY VISIBLE, well-lit, and the FOCUS of the image even though a person is present
- The person must be wearing appropriate clothing (shirt, blouse, dress — NEVER shirtless)
- The person's face should be partially visible, natural candid expression
- No text, no words, no watermarks in the scene
- No floating or suspended elements of any kind — everything must obey gravity
- Everything photorealistic — must look like a real photoshoot with a real model
- ANATOMY: Every hand must have EXACTLY 5 fingers. Natural human proportions. No extra limbs.
- SKIN: Realistic skin texture with pores and natural imperfections — NOT smooth/plastic AI skin
- GRIP: The person's hand must grip the product naturally — fingers wrap around it realistically
- EYES: Natural eye direction, realistic iris detail, no glowing or dead eyes
- SINGLE PERSON ONLY: One model, not multiple. One product instance, not duplicated.`,
};

const DEFAULT_STYLE_BRIEF = STYLE_BRIEFS['style_lifestyle']!;

const ANALYZE_AND_PLAN_PROMPT = `You are an expert product photographer and advertising creative director. Analyze this product image and return a complete plan for creating a professional advertisement.

Your response MUST be valid JSON only — no markdown, no explanation.

## STEP 1: Input Quality Assessment
- Is this photo usable? Reject only if: no product visible, extremely blurry, too dark, too small, or corrupted
- Accept messy backgrounds and poor lighting — we will fix them
- "hasGlare": true if the product surface has visible specular reflections, glare hotspots, or flash reflections
- "inputAngleQuality": "good" if the viewing angle is suitable for advertising, "suboptimal" if a different angle would be better (e.g., flat top-down when a 3/4 view would sell better), "unusable" if the product is barely visible from this angle

## STEP 2: Product Identification (be EXTREMELY specific)
- Full brand name, product type, variant, size
- Example: NOT "speaker" but "Anker SoundCore 2 Portable Bluetooth Speaker, black mesh front, ANKER logo on face"

## STEP 3: Branding Detection (CRITICAL)
- "hasBranding": true if ANY brand text, logo, or distinctive brand mark is visible
- "brandingConfidence": 0.0 to 1.0 — how confident are you about the branding detection? 1.0 = obvious large logo/text. 0.5 = small or partially obscured. 0.0 = no branding at all. When uncertain (embossed text, tiny logos, partial visibility), err on the side of HIGHER confidence (we'd rather preserve than destroy branding).
- "brandElements": list every visible brand element
- A plain black speaker with no text = false. A speaker with "ANKER" = true. A Pepsi can = true. Handmade jewelry = false.

## STEP 4: Full Product Analysis
Deep analysis: colors, materials, textures, target audience, price segment, recommended scene, ad best practices for this product type.

## STEP 5: Scene Prompt Generation (STYLE-AWARE)

`;

// ---------------------------------------------------------------------------
// Build the full prompt with style context
// ---------------------------------------------------------------------------

function buildFullPrompt(style?: string, voiceInstructions?: string): string {
  const styleBrief = (style && STYLE_BRIEFS[style]) ? STYLE_BRIEFS[style] : DEFAULT_STYLE_BRIEF;

  let prompt = ANALYZE_AND_PLAN_PROMPT;

  prompt += `The user has selected this photography style:\n\n${styleBrief}\n\n`;

  prompt += `Generate TWO prompts that STRICTLY follow the style specification above:

**scenePrompt** (40-70 words): A creative ad scene in the specified style WITH the product as hero.
- Follow the style's surface, lighting, props, background, and mood EXACTLY
- Product is the ONLY main subject — NO other products, bottles, glasses, cups
- Props must match the style specification (none for studio, contextual for lifestyle, etc.)
- Everything PHOTOREALISTIC — shot on 85mm f/2.8 lens
- NEVER use words like "8k", "quality", "HD", "resolution" — AI renders these as visible text
- ONLY include dynamic elements (scattered props, floating ingredients) if the style specification ALLOWS them. If the style says "no props" or "no floating elements", do NOT add any.

**backgroundOnlyPrompt** (40-70 words): An EMPTY scene matching the style with NO product.
- Same surface, lighting, background, and mood as scenePrompt
- Clear empty space in center where product will be composited
- Must include "no products, no objects in center, clear negative space"

`;

  if (voiceInstructions && voiceInstructions.trim().length > 0) {
    prompt += `\nUser's additional instructions (incorporate into scene): ${voiceInstructions.trim()}\n\n`;
  }

  prompt += `Return this exact JSON structure:
{
  "usable": boolean,
  "rejectionReason": string | null,
  "productCategory": "food" | "jewellery" | "garment" | "skincare" | "candle" | "bag" | "home_goods" | "electronics" | "handicraft" | "other",
  "hasBranding": boolean,
  "brandingConfidence": number,
  "brandElements": string[],
  "hasGlare": boolean,
  "inputAngleQuality": "good" | "suboptimal" | "unusable",
  "analysis": {
    "productName": string,
    "brandName": string | null,
    "productType": string,
    "specificDescription": string,
    "dominantColors": string[],
    "material": string,
    "shape": string,
    "keyVisualElements": string[],
    "visibleText": string[],
    "targetAudience": string,
    "priceSegment": "budget" | "mid_range" | "premium" | "luxury",
    "salesChannel": string,
    "desiredEmotion": string,
    "recommendedScene": {
      "surface": string,
      "background": string,
      "lighting": string,
      "colorPalette": string,
      "props": string[],
      "mood": string,
      "photographyStyle": string
    },
    "category": "food" | "jewellery" | "garment" | "skincare" | "candle" | "bag" | "home_goods" | "electronics" | "handicraft" | "other",
    "adBestPractices": string
  },
  "scenePrompt": string,
  "backgroundOnlyPrompt": string
}`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

// ---------------------------------------------------------------------------
// Consolidated analysis — SINGLE Gemini call replaces 3 separate calls
// ---------------------------------------------------------------------------

/**
 * Single Gemini call that returns:
 * - Input quality assessment (usable/rejected)
 * - Branding detection (hasBranding, brandElements)
 * - Full product analysis (name, colors, materials, audience, scene)
 * - Creative scene prompt (for Seedream Track B)
 * - Background-only prompt (for Flux Track A)
 *
 * Uses Gemini 2.5 Flash (not Lite) for this critical analysis.
 */
export async function analyzeAndPlan(
  imageBuffer: Buffer,
  voiceInstructions?: string,
  style?: string
): Promise<AnalyzeAndPlanResult> {
  const startMs = Date.now();

  const genai = new GoogleGenAI({
    apiKey: process.env['GOOGLE_GENAI_API_KEY']!,
  });

  const base64Image = imageBuffer.toString('base64');
  const mimeType = detectMime(imageBuffer);

  const prompt = buildFullPrompt(style, voiceInstructions);

  const response = await genai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64Image } },
          { text: prompt },
        ],
      },
    ],
  });

  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemini returned non-JSON for analyzeAndPlan: ${rawText.slice(0, 300)}`);
  }

  const result = AnalyzeAndPlanSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`analyzeAndPlan schema validation failed: ${result.error.message}`);
  }

  console.info(JSON.stringify({
    event: 'analyze_and_plan_complete',
    usable: result.data.usable,
    productName: result.data.analysis.productName,
    category: result.data.productCategory,
    hasBranding: result.data.hasBranding,
    brandingConfidence: result.data.brandingConfidence,
    brandElements: result.data.brandElements,
    hasGlare: result.data.hasGlare,
    inputAngleQuality: result.data.inputAngleQuality,
    style: style ?? 'default',
    scenePromptPreview: result.data.scenePrompt.slice(0, 80),
    durationMs: Date.now() - startMs,
  }));

  return result.data;
}

// ---------------------------------------------------------------------------
// Legacy exports (keep backward compat for index.ts exports)
// ---------------------------------------------------------------------------

export async function analyzeProduct(imageBuffer: Buffer): Promise<ProductAnalysis> {
  const result = await analyzeAndPlan(imageBuffer);
  return result.analysis;
}

export async function generateAdPrompt(
  analysis: ProductAnalysis,
  voiceInstructions?: string
): Promise<string> {
  // This is now handled inside analyzeAndPlan, but keep for backward compat
  const genai = new GoogleGenAI({ apiKey: process.env['GOOGLE_GENAI_API_KEY']! });
  const prompt = `Generate a 40-70 word creative ad scene prompt for this product. The product is already placed on a canvas — describe ONLY the scene around it. No text, no words, no "8k", no "quality". Photorealistic only. Product is the ONLY main subject. No competing objects.\n\nProduct: ${JSON.stringify(analysis)}${voiceInstructions ? `\n\nUser instructions: ${voiceInstructions}` : ''}`;

  const response = await genai.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return rawText.replace(/^["'`]+/, '').replace(/["'`]+$/, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
}
