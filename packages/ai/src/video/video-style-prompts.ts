/**
 * Video style prompts for Seedance 2.0 generation.
 *
 * Three beta styles:
 *   video_cinematic — slow dolly luxury product showcase
 *   video_ugc       — AI avatar talking-head with product (lip-sync)
 *   video_demo      — product-in-use, category-aware motion
 *
 * Each prompt follows the schema:
 *   Subject · Environment · Composition · Motion · Lighting · Audio/Voice · Preservation anchor
 */

import type { LightAnalysis } from '../pipeline/light-analyzer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VideoStyle = 'video_cinematic' | 'video_ugc' | 'video_demo';

export interface VideoPromptParams {
  style: VideoStyle;
  /** Product analysis from lightAnalyze() — provides productName, category, etc. */
  analysis: LightAnalysis;
  /** Optional free-text note from the customer */
  userInstructions?: string;
  /** Explicit voiceover text for UGC style (auto-generated if omitted) */
  voiceoverText?: string;
  /** Language for UGC lip-sync */
  voiceoverLanguage?: 'en' | 'hi' | 'hinglish';
}

export interface VideoPromptResult {
  /** Full prompt string sent to Seedance */
  prompt: string;
  /** Resolved voiceover text (populated for UGC style) */
  voiceoverText?: string;
}

// ---------------------------------------------------------------------------
// Preservation anchor — same philosophy as Phase 1 image prompts
// ---------------------------------------------------------------------------

const PRESERVATION_ANCHOR = `
Preservation rule (highest priority): The product shown in Image 1 must appear exactly as in the reference photo — identical colors, identical logo placement, identical material finish, identical proportions, identical physical details. Any creative motion, camera work, or environmental styling applies exclusively to the environment and camera movement, never to the product itself. Do not alter, recolor, distort, add text to, or reimagine the product in any frame.`.trim();

// ---------------------------------------------------------------------------
// Category-aware demo motion descriptions
// ---------------------------------------------------------------------------

const DEMO_MOTION_BY_CATEGORY: Record<string, string> = {
  food: 'Product is poured, plated, or sliced in a natural kitchen setting. Steam rises from a warm dish. Close-up of texture and appetite appeal.',
  jewellery: 'Jewelry piece is placed on a velvet surface by elegant hands. Light catches the facets in a slow turn. Close-up of gem sparkle.',
  garment: 'Fabric flows as hands smooth it across a flat surface, revealing texture and drape. Subtle fold movement.',
  skincare: 'Product cap lifts cleanly. A drop of serum or cream catches soft light. Fingers gently apply product to skin visible at frame edge.',
  candle: 'Wick is lit; flame appears. Warm light spreads across the wax surface. Gentle smoke curl in ambient light.',
  bag: 'Bag is unzipped or clasp opened. Hand lifts the flap to reveal interior. Placed on a clean surface with natural casual motion.',
  electronics: 'Device screen lights up. Button or switch pressed with satisfying tactile motion. Product rotated 180° to show key features.',
  other: 'Product is picked up, inspected, and set back down naturally. Fingers interact with the most interesting design detail.',
};

function getDemoMotion(category: string): string {
  return DEMO_MOTION_BY_CATEGORY[category] ?? DEMO_MOTION_BY_CATEGORY['other']!;
}

// ---------------------------------------------------------------------------
// Style prompt builders
// ---------------------------------------------------------------------------

function buildCinematicPrompt(analysis: LightAnalysis, userInstructions?: string): string {
  const { productName, productCategory, dominantColors } = analysis;
  const colorHint =
    dominantColors.length > 0
      ? `The product palette includes ${dominantColors.slice(0, 2).join(' and ')}.`
      : '';

  const lines = [
    `Subject: ${productName} — a premium ${productCategory} product placed as the sole hero.`,
    `Environment: Luxury interior. Black marble surface, dark velvet drape in background, subtle brass accent elements. Low-key, high-contrast studio.`,
    `${colorHint}`,
    `Composition: Product centered, slight low angle looking up — hero perspective. Full product visible, generous negative space.`,
    `Motion: Slow 180-degree dolly arc around the product over the full clip duration. Subtle rack focus from foreground edge to product center at the midpoint. Camera never cuts — one continuous cinematic move.`,
    `Lighting: Warm 3000K key light from camera-right. Cool 5500K rim from behind creating a crisp separation halo. Volumetric haze backlit for depth. Specular highlight rolls across the product surface during the dolly.`,
    `Audio: Cinematic ambient low hum — no dialogue, no music lyrics. Optional low-frequency synth pad. Natural material sound if the product surface reflects light click-through.`,
    userInstructions ? `Customer note: ${userInstructions}` : '',
    PRESERVATION_ANCHOR,
  ].filter(Boolean);

  return lines.join('\n\n');
}

function buildUgcPrompt(
  analysis: LightAnalysis,
  voiceoverText: string,
  voiceoverLanguage: 'en' | 'hi' | 'hinglish',
  userInstructions?: string,
): string {
  const { productName, productCategory } = analysis;

  const langLabel =
    voiceoverLanguage === 'hi' ? 'Hindi' : voiceoverLanguage === 'en' ? 'English' : 'Hinglish (mixed Hindi-English)';

  const lines = [
    `Subject: South Asian avatar, age 25–35, friendly and relatable, visible chest-up, holding the ${productName} at chest level. The actual product (Image 1) must appear in the avatar's hand or on-screen — preserved exactly.`,
    `Environment: Casual, authentic setting — modern home interior or cozy cafe. Shallow depth of field. Background slightly blurred. Natural and unpolished — UGC aesthetic.`,
    `Composition: Medium close-up. Avatar fills 50–60% of frame. Product held at chest level, tilted slightly toward camera. Occasional glance from avatar face to product.`,
    `Motion: Avatar's head moves naturally — subtle nod, natural blink rhythm. Hands shift the product orientation once mid-clip to show a different face of the product. No stiff poses.`,
    `Lighting: Soft natural daylight from a large window. Warm skin tones. Gentle fill light to avoid hard shadows. No dramatic studio lighting — must feel authentic.`,
    `Audio / Lip-sync: Avatar speaks the voiceover text in ${langLabel} with phoneme-level lip-sync. Voice should sound natural and conversational, not scripted or robotic.`,
    `Voiceover text (avatar says exactly): "${voiceoverText}"`,
    `Category context: This is a ${productCategory} product — the avatar's interaction should feel appropriate for how a real customer would describe and hold this type of item.`,
    userInstructions ? `Customer note: ${userInstructions}` : '',
    PRESERVATION_ANCHOR,
  ].filter(Boolean);

  return lines.join('\n\n');
}

function buildDemoPrompt(analysis: LightAnalysis, userInstructions?: string): string {
  const { productName, productCategory, typicalSetting } = analysis;
  const demoMotion = getDemoMotion(productCategory);
  const settingHint = typicalSetting !== 'tabletop' ? typicalSetting : 'a clean neutral surface';

  const lines = [
    `Subject: The ${productName} being used naturally in a real-world context. Product is the undisputed focus.`,
    `Environment: ${settingHint} setting that matches how a customer would use this ${productCategory} product. Lived-in but tidy. Natural ambient textures.`,
    `Composition: Close to medium shot. Product in sharp focus throughout. Shallow depth of field. Human hands visible only as props during interaction — no face shown unless product is wearable.`,
    `Motion: ${demoMotion}`,
    `Lighting: Natural warm 3500K light. Soft directional shadows. No harsh glare. Surfaces reflect ambient environment naturally.`,
    `Audio: Realistic product-in-use sounds — material texture, mechanical feedback, ambient room tone. Light background music at 20% volume underneath. No dialogue.`,
    userInstructions ? `Customer note: ${userInstructions}` : '',
    PRESERVATION_ANCHOR,
  ].filter(Boolean);

  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build a structured Seedance 2.0 prompt for the given video style.
 *
 * For `video_ugc` style, also returns the resolved voiceoverText so the caller
 * can pass it as the `voiceoverText` param to generateProductVideo().
 */
export function getVideoPrompt(params: VideoPromptParams): VideoPromptResult {
  const { style, analysis, userInstructions, voiceoverText, voiceoverLanguage = 'hinglish' } = params;

  switch (style) {
    case 'video_cinematic': {
      return {
        prompt: buildCinematicPrompt(analysis, userInstructions),
      };
    }

    case 'video_ugc': {
      // Resolve voiceover: caller-provided > auto-generated Hinglish default
      const resolvedVoiceover =
        voiceoverText?.trim() ||
        `Yaar ye ${analysis.productName} try karo, genuinely kaafi acha hai!`;

      return {
        prompt: buildUgcPrompt(analysis, resolvedVoiceover, voiceoverLanguage, userInstructions),
        voiceoverText: resolvedVoiceover,
      };
    }

    case 'video_demo': {
      return {
        prompt: buildDemoPrompt(analysis, userInstructions),
      };
    }

    default: {
      // Exhaustiveness guard
      const _never: never = style;
      throw new Error(`getVideoPrompt: unknown video style "${_never}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Metadata — style display labels for the admin UI
// ---------------------------------------------------------------------------

export const VIDEO_STYLES: Array<{ id: VideoStyle; label: string; description: string }> = [
  {
    id: 'video_cinematic',
    label: 'Cinematic Luxury',
    description: '180° dolly shot, dark marble, volumetric light — premium brand feel',
  },
  {
    id: 'video_ugc',
    label: 'UGC Talking Head',
    description: 'Avatar holds & recommends product in Hinglish — authentic social media style',
  },
  {
    id: 'video_demo',
    label: 'Product Demo',
    description: 'Product in use — category-aware motion, realistic sounds, no talking head',
  },
];
