import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

// Re-export the base types from V2 for shared schema fields
export type { ProductAnalysis } from './product-analyzer.js';

// ---------------------------------------------------------------------------
// V3 Schema — extends V2 with creative concept fields
// ---------------------------------------------------------------------------

const ProductAnalysisSchema = z.object({
  productName: z.string(),
  brandName: z.string().nullable(),
  productType: z.string(),
  specificDescription: z.string(),
  dominantColors: z.union([z.array(z.string()), z.string()]).transform(v => Array.isArray(v) ? v : [v]),
  material: z.string(),
  shape: z.string(),
  keyVisualElements: z.union([z.array(z.string()), z.string()]).transform(v => Array.isArray(v) ? v : [v]),
  productComponents: z.union([z.array(z.string()), z.string()]).transform(v => Array.isArray(v) ? v : v === 'none' || v === '' ? [] : [v]).catch([]).describe('List of all visible physical sub-components: caps, lids, straws, cables, stands, boxes, tags, applicators'),
  visibleText: z.union([z.array(z.string()), z.string()]).transform(v => Array.isArray(v) ? v : v === 'none' || v === '' ? [] : [v]),
  targetAudience: z.string(),
  priceSegment: z.string().transform(v => {
    const valid = ['budget', 'mid_range', 'premium', 'luxury'] as const;
    return valid.includes(v as any) ? v as typeof valid[number] : 'mid_range';
  }),
  salesChannel: z.string(),
  desiredEmotion: z.string(),
  recommendedScene: z.object({
    surface: z.string(),
    background: z.string(),
    lighting: z.string(),
    colorPalette: z.string(),
    props: z.union([z.array(z.string()), z.string()]).transform(v => Array.isArray(v) ? v : v === 'none' || v === '' ? [] : [v]),
    mood: z.string(),
    photographyStyle: z.string(),
  }),
  category: z.string().transform(v => {
    const valid = ['food', 'jewellery', 'garment', 'skincare', 'candle', 'bag', 'home_goods', 'electronics', 'handicraft', 'other'] as const;
    return valid.includes(v as any) ? v as typeof valid[number] : 'other';
  }),
  adBestPractices: z.string(),
});

const AnalyzeAndPlanV3Schema = z.object({
  // Input QA (same as V2)
  usable: z.boolean(),
  rejectionReason: z.string().nullable(),
  productCategory: z.string().transform(v => {
    const valid = ['food', 'jewellery', 'garment', 'skincare', 'candle', 'bag', 'home_goods', 'electronics', 'handicraft', 'other'] as const;
    return valid.includes(v as any) ? v as typeof valid[number] : 'other';
  }),

  // Branding detection (same as V2)
  hasBranding: z.boolean(),
  brandingConfidence: z.number().catch(0.5).transform(v => Math.max(0, Math.min(1, v))),
  brandElements: z.union([z.array(z.string()), z.string()]).transform(v => Array.isArray(v) ? v : v === 'none' || v === '' ? [] : [v]),

  // Input quality (same as V2)
  hasGlare: z.boolean(),
  inputAngleQuality: z.string().transform(v => {
    const valid = ['good', 'suboptimal', 'unusable'] as const;
    return valid.includes(v as any) ? v as typeof valid[number] : 'good';
  }),

  // Physical characteristics (same as V2)
  productPhysicalSize: z.string().transform(v => {
    const valid = ['tiny', 'small', 'medium', 'large'] as const;
    return valid.includes(v as any) ? v as typeof valid[number] : 'medium';
  }),
  productDimensionality: z.string().transform(v => {
    const valid = ['flat_2d', 'shallow_3d', 'deep_3d'] as const;
    return valid.includes(v as any) ? v as typeof valid[number] : 'shallow_3d';
  }),
  recommendedCanvasFill: z.number().catch(0.65).transform(v => Math.max(0.3, Math.min(0.95, v))),

  // Product analysis (same as V2)
  analysis: ProductAnalysisSchema,

  // V2 prompts (kept for compatibility)
  scenePrompt: z.string(),
  backgroundOnlyPrompt: z.string(),

  // --- V3 CREATIVE CONCEPT FIELDS (NEW) ---

  heroMoment: z.string(),
  dynamicElements: z.union([z.array(z.string()), z.string()]).transform(v => Array.isArray(v) ? v : [v]),
  emotionalTrigger: z.string().transform(v => {
    const valid = ['craving', 'desire', 'energy', 'comfort', 'luxury', 'freshness', 'joy', 'confidence'] as const;
    return valid.includes(v as any) ? v as typeof valid[number] : 'desire';
  }),
  storyScene: z.string(),
  creativeBrief: z.string(),
});

export type AnalyzeAndPlanV3Result = z.infer<typeof AnalyzeAndPlanV3Schema>;

// ---------------------------------------------------------------------------
// Style Narratives — technique-driven creative direction per style + category
// Each narrative specifies 2-3 visual TECHNIQUES to combine, not just a scene.
// Format: EMOTION first → TECHNIQUES to combine → SPECIFIC elements
// ---------------------------------------------------------------------------

const STYLE_NARRATIVES: Record<string, Record<string, string>> = {
  style_lifestyle: {
    food: `CRAVING TRIGGER. Techniques: INGREDIENT SCATTER + CROSS-SECTION REVEAL + WARM CHIAROSCURO. The product's raw ingredients burst outward from it in a halo (nuts, chocolate chips, spice pods, fruit slices scattered around). One unit is broken open or bitten to reveal the inside texture (gooey, crunchy, layered). Warm 3200K side-lighting from left, deep shadows on right. Rustic wood or dark slate surface with authentic wear marks. Crumbs, powder dust, drizzles of sauce/chocolate — the mess IS the story. The viewer must physically CRAVE this.`,
    skincare: `GLOW RITUAL. Techniques: TEXTURE SHOT + BOTANICAL SCATTER + DEWY SURFACE. Product being squeezed mid-drip onto a backlit glass or marble surface, showing its texture (gel, cream, serum). Fresh-cut botanical ingredients arranged around it (aloe leaf, citrus slice, flower petals, turmeric root) — all misted with water droplets looking fresh. Soft 4000K directional light from one side. Viewer feels: "I want this in my morning routine."`,
    jewellery: `INTIMATE DESIRE. Techniques: WARM CHIAROSCURO + FABRIC TEXTURE + MIRROR REFLECTION. Jewelry resting on draped raw silk or crushed velvet on a vanity surface. A small mirror reflects the piece from a different angle. One prop only — dried flower stem or ceramic dish. Warm directional side-light making gems catch fire. NO person, NO hands, NO body parts. Extreme shallow DOF. The viewer imagines putting this on.`,
    electronics: `CREATIVE ENERGY. Techniques: DESK SCENE + WARM-COOL CONTRAST + DEPTH LAYERING. Product in a curated workspace — warm desk lamp on one side, cool screen glow on the other. Coffee cup, plant, notebook as foreground blur elements. The product is in sharp focus at the intersection of warm and cool light. Productive, aspirational energy.`,
    garment: `CURATED FLAT LAY. Techniques: OVERHEAD COMPOSITION + COLOR STORY + CONTEXTUAL PROPS. The garment laid flat on light linen as centerpiece of a styled arrangement. 1-2 complementary accessories (watch, sunglasses, belt), a coffee cup at edge, one plant sprig. Overhead natural light. Color palette limited to 3 tones max. The viewer imagines wearing this today.`,
    candle: `COZY EVENING. Techniques: FLAME AS KEY LIGHT + ENVIRONMENTAL STORYTELLING + DEPTH LAYERING. The candle IS LIT — its flame is the primary light source creating a warm pool of amber glow. An open book, ceramic tea mug, knit blanket as context. Rain-streaked window in background with twilight blue. Foreground objects slightly blurred. The viewer wants to be in this room RIGHT NOW.`,
    bag: `WANDERLUST. Techniques: ADVENTURE CONTEXT + DEPTH LAYERING + GOLDEN LIGHT. The bag packed and ready — passport peeking out, sunglasses, boarding pass. Warm golden light from one side. Blurred travel context behind (airport, hotel, map). The viewer feels wanderlust.`,
    default: `LIFESTYLE MOMENT. Techniques: ENVIRONMENTAL STORYTELLING + WARM DIRECTIONAL LIGHT + CONTEXTUAL PROPS. Product caught in an inviting scene with 2-3 props that tell a story. Natural window light from one side, 3200-4500K. Shallow DOF with blurred background. NO people, NO hands. The viewer imagines this product in THEIR life.`,
  },

  style_gradient: {
    food: `SINFUL INDULGENCE. Techniques: INGREDIENT EXPLOSION + DARK REFLECTIVE SURFACE + DUAL RIM LIGHTING. Pitch black background. Product on polished black acrylic creating a mirror reflection below. Raw ingredients EXPLODING outward from the product — nuts, chocolate shards, fruit slices, spice particles frozen mid-air in the rim light. Two strip softbox rim lights from behind-left and behind-right creating razor-sharp glowing edges. The food looks sinful, premium, irresistible. Dust particles and powder caught floating in the light beams.`,
    skincare: `LIQUID LUXURY. Techniques: DARK REFLECTIVE SURFACE + PRODUCT DROP MID-FALL + CHROMATIC SPLIT LIGHT. Glossy black surface with perfect product reflection. A single drop or stream of the product (serum, cream) caught mid-fall, lit from one side warm and the other cool. Split warm-cool lighting creating chromatic drama on packaging. Elegant, exclusive, expensive.`,
    jewellery: `PRECIOUS FIRE. Techniques: SPOTLIGHT CONE + GEM REFRACTION + FLOATING PARTICLES. Single hard spotlight creating a cone of light against total darkness. Product on dark velvet. A second small point source aimed specifically to create rainbow refraction "fire" inside gemstones. Fine gold dust particles floating in the rim light like tiny stars. Dark card opposite the key light to increase contrast within gems. NO person, NO hands. The jewelry burns with its own light.`,
    electronics: `FUTURISTIC POWER. Techniques: DARK REFLECTIVE SURFACE + COLORED ACCENT LIGHTING + FOG/MIST. Product on matte black surface with mirror reflection. Cool blue-white rim lights from behind. Thin colored LED accent glow matching the product's brand color. Low-lying fog at the base. The product looks like it costs 10x its price.`,
    candle: `ATMOSPHERIC GLOW. Techniques: FLAME AS SOLE LIGHT + SMOKE WISPS + DARK SURFACE. The candle flame IS the only light source. Warm glow pool spreading across dark polished surface. Thin smoke wisps caught by rim light against darkness. Intimate and atmospheric.`,
    default: `DRAMATIC HERO. Techniques: DARK REFLECTIVE SURFACE + DUAL RIM LIGHT + DYNAMIC ELEMENTS. Product on polished black acrylic with mirror reflection below. Two strip softbox rim lights from behind creating glowing edges. Water droplets, ice shards, gold dust, or ingredient particles frozen mid-air around the product, caught in the rim light. Atmospheric mist at the base. Premium, cinematic, desire-inducing.`,
  },

  style_outdoor: {
    food: `HARVEST FRESH. Techniques: GOLDEN HOUR BACKLIGHT + INGREDIENT SCATTER + NATURAL SURFACE. Product on rustic weathered wood outdoors. Golden hour sun LOW behind the product creating a warm rim glow on every edge. Raw herbs, produce, spices scattered around. Dew on leaves catching sunlight. Lush green foliage visible in soft bokeh background. Fresh, alive, natural.`,
    skincare: `BOTANICAL ORIGIN. Techniques: INGREDIENT GARDEN + GOLDEN RIM LIGHT + DEWY TEXTURE. Product surrounded by its actual botanical ingredients OUTDOORS — fresh aloe leaves, flower petals, turmeric root, all with morning dew. Golden hour backlight. Greenhouse glass or garden foliage blurred behind. The product grew from this garden.`,
    jewellery: `NATURE'S TREASURE. Techniques: NATURAL SURFACE + GOLDEN HOUR BACKLIGHT + EXTREME SHALLOW DOF. Product draped over sun-warmed river stone or weathered driftwood OUTDOORS. MUST show real outdoor environment — visible sky, trees, green foliage, or stream in the soft bokeh background. Morning dew droplets on the stone catching golden sunlight. One small wildflower (not groomed). f/1.4 DOF so the nature melts into green-gold bokeh. NO person, NO hands. The jewelry looks like treasure discovered in nature.`,
    default: `GOLDEN HOUR. Techniques: BACKLIGHT RIM GLOW + NATURAL SURFACE + DEPTH LAYERING. Product OUTDOORS on weathered wood, moss-covered stone, or earthy surface. MUST have visible outdoor environment in background — foliage, trees, sky, garden dissolving into golden bokeh. Golden hour backlight creating rim glow on every edge. 1-2 natural props (leaves, wildflowers, pebbles) as foreground blur. NOT an indoor shot. Fresh, alive, authentic.`,
  },

  style_festive: {
    food: `DIWALI HAMPER. Techniques: WARM MULTI-POINT LIGHT + CULTURAL PROPS + GOLDEN BOKEH. Product as gift centerpiece on brass thali. Dry fruits in small bowls, gold ribbon, scattered marigold petals. Multiple lit diyas creating layered warm point sources at different distances — each one a golden bokeh circle at a different depth. Fairy lights in background. "Buy this as a gift RIGHT NOW."`,
    jewellery: `DHANTERAS TREASURE. Techniques: DIYA GLOW + CULTURAL SURFACE + GOLDEN PARTICLES. Product on red velvet atop brass thali. Gold coins scattered around. Lit diyas flanking the jewelry — their warm glow creating the primary lighting. Rich golden bokeh from fairy lights at multiple depths. Fine kumkum powder or gold dust in the air. NO person, NO hands. Auspicious, precious, celebratory.`,
    default: `FESTIVE CELEBRATION. Techniques: MULTI-SOURCE WARM LIGHT + CULTURAL STYLING + DEPTH BOKEH. Product on embroidered silk with gold zari. Lit diyas as primary light sources creating warm pools. Marigold garland, brass elements. Golden fairy light bokeh at 3+ different depths behind. Celebration, warmth, tradition.`,
  },

  style_clean_white: {
    default: `PREMIUM PRECISION. Techniques: SEAMLESS WHITE + MIRROR REFLECTION + OVERHEAD ACCENT. Apple-product-page level purity. Seamless white background. Product sits on white acrylic with a subtle mirror reflection of its underside visible. One overhead strip softbox creating a clean specular highlight line across the product. Nothing else — the product and its reflection only. Premium, trustworthy, detail-obsessed.`,
  },

  style_studio: {
    food: `BOLD ENERGY. Techniques: COMPLEMENTARY COLOR BACKDROP + INGREDIENT EXPLOSION + DRAMATIC SIDE-LIGHT. Saturated colored seamless paper that POPS against the product packaging (warm product = cool backdrop, cool product = warm backdrop). Product's raw ingredients frozen mid-burst around it — ice chips, spice powder cloud, fruit slices, condensation droplets. Hard key light from 45° left creating dramatic shadows on the colored surface. NO people, NO hands. The color + flying ingredients = visual energy.`,
    jewellery: `JEWEL BOX. Techniques: DEEP COLOR BACKDROP + SPECULAR SPARKLE + VELVET SURFACE. Rich deep colored backdrop (navy, burgundy, or emerald) chosen to complement the metal and gems. Product on small velvet cushion or polished dark surface. One hard point light source specifically aimed to create sparkle/fire in every gemstone. A second soft fill preserves detail. Fine gold dust or a single silk ribbon as accent. NO people, NO hands. The deep color makes the jewelry POP.`,
    default: `COLOR CAMPAIGN. Techniques: COMPLEMENTARY COLOR BACKDROP + DRAMATIC SHADOW PLAY + CONTEXTUAL ELEMENT. Bold colored seamless paper that creates maximum contrast with the product. Three-point studio lighting with hard key light creating a dramatic shadow cast on the colored surface. One small contextual element at the base that tells the product's story (not random — related to the product's use). NO people, NO hands. This is a CAMPAIGN shot, not a background swap.`,
  },

  style_minimal: {
    default: `ARCHITECTURAL STILLNESS. Techniques: SINGLE DIRECTIONAL LIGHT + DRAMATIC SHADOW + NEGATIVE SPACE. One hard light source from 60-80° creating a long, dramatic shadow that IS the compositional element. Product on white marble or raw concrete. 60-70% of the frame is intentional empty space. Rule-of-thirds placement. NO people, NO hands. The shadow and emptiness create tension. Zen, sophisticated, architectural.`,
  },

  style_with_model: {
    food: `CAUGHT IN THE ACT OF ENJOYING — PERSON IS MANDATORY. Think about HOW this specific food is eaten and show THAT moment. Chips/snacks: person reaching into the bag, one chip near mouth, satisfied crunch expression. Cookies/sweets: person biting into one, eyes closed in satisfaction, crumbs on fingers. Drinks/beverages: person HOLDING the sealed product (cap ON) near face level, showing anticipation. If the product has a cap or lid in the input photo, it MUST remain attached — do NOT show the product open, mid-sip, or uncapped. Spices/cooking ingredients: person cooking, tasting from a spoon, steam rising. Protein bars/health food: person in gym clothes, post-workout, unwrapping it. The product AND its packaging must be clearly visible. NOT a posed smile — a REAL moment of enjoyment. Warm light, shallow DOF, contextual environment matching how the food is consumed.`,
    skincare: `BEAUTY RITUAL IN ACTION — PERSON IS MANDATORY. Show the EXACT moment of using THIS specific product. Serum: person applying drops to face with the dropper, dewy skin glowing. Face cream: fingertips scooping from the jar, mid-application on cheek. Face wash: person at sink, foam on face, eyes closed. Sunscreen: person applying on arm/face before going outside. Lip product: person applying in front of mirror. Hair oil: person working it through hair. The product container MUST be prominently visible — either in hand or placed nearby on the vanity. Soft bathroom/vanity light. The viewer thinks "I want that glow."`,
    jewellery: `ADORNED ELEGANCE — PERSON IS MANDATORY. Show the intimate moment of WEARING this jewelry. Necklace: Indian woman touching it at collarbone, looking down admiringly, tight crop collarbone-to-chin. Earrings: side profile or 3/4 view, tucking hair behind ear to reveal the earring. Ring: hand resting on a surface, ring catching light, or adjusting it. Bracelet/bangles: wrist visible while pouring chai or arranging flowers. The jewelry MUST be the brightest, sharpest element — hard accent light creating sparkle on gems. Soft key light on skin. Warm skin tones. Confidence, desire, beauty.`,
    electronics: `IN THE ZONE — PERSON IS MANDATORY. Show the person ACTIVELY USING this specific device in its natural context. Headphones/earbuds: person with eyes closed, lost in music, slight head bob. Phone: person scrolling with a soft smile, screen glow on face. Speaker: person in living room, dancing or swaying to music. Fitness tracker/watch: person mid-workout, glancing at wrist. Laptop: person typing intently at a café, coffee nearby. Power bank: person charging phone at airport, waiting. Keyboard/mouse: person gaming or working, focused expression. The product enabling a genuine MOMENT. Warm-cool light contrast, shallow DOF.`,
    garment: `WEARING IT AND LIVING IN IT — PERSON IS MANDATORY. Show the person in this garment caught in a REAL MOMENT of their life — not a fashion pose. Casual wear: person laughing with friends, walking on street, grabbing coffee. Ethnic wear (kurti/saree/lehenga): person adjusting dupatta, walking through a doorway, touching jewelry. Formal wear: person adjusting cuff, walking confidently, at a restaurant. Gym/activewear: person mid-exercise, stretching, running. Fabric catching natural movement — a slight breeze, a turn, a step. Blurred lifestyle background. Confidence and ease.`,
    candle: `COZY MOMENT — PERSON IS MANDATORY. Show an Indian person in a cozy evening moment WITH the lit candle. Person curled up reading a book on the couch, candle glowing on the side table. Or person meditating with eyes closed, candle in foreground blur. Or person taking a relaxing bath, candle on the tub edge. The candle flame creates the warm ambient glow. Person looks peaceful, content, present. The viewer wants this exact evening.`,
    bag: `ON THE MOVE — PERSON IS MANDATORY. Show the person CARRYING this bag in a real-life context. Backpack: person walking through a campus or hiking trail, looking over shoulder. Handbag: person walking in a market or café, bag on shoulder, reaching for something. Travel bag: person at airport, pulling it, with boarding pass visible. Laptop bag: person entering an office, bag slung over shoulder, coffee in hand. Clutch: person at an evening event, holding it while laughing. The bag is the style statement. Motion, energy, aspiration.`,
    default: `PERSON USING THIS PRODUCT IS MANDATORY — AN IMAGE WITHOUT A PERSON IS A FAILURE FOR THIS STYLE.

Think creatively about HOW this specific product is used in real life, and show THAT exact moment:
- Perfume/fragrance: person spraying on wrist or neck, eyes closed savoring the scent, dresser/mirror behind
- Dumbbells/gym equipment: person mid-exercise with the equipment, sweat, gym environment
- Water bottle: person drinking after a run, wiping sweat
- Notebook/stationery: person writing, café setting, pen in hand
- Kitchenware: person cooking with it, steam rising, ingredients around
- Toys: child playing with it, joy on face, living room floor
- Tools: person using the tool, workshop environment
- Home decor: person arranging it on a shelf, stepping back to admire
- Sunglasses: person wearing them outdoors, golden hour light

The scene must match WHERE and HOW the product is naturally used. The person's expression must match the EMOTION of using it (satisfaction, focus, joy, confidence, relaxation). The product MUST be clearly visible and recognizable. Candid asymmetric expression. Shallow DOF. The person provides context and aspiration.`,
  },
};

// ---------------------------------------------------------------------------
// Style briefs — kept from V2 for photography specs (secondary to narrative)
// ---------------------------------------------------------------------------

const PHOTOGRAPHY_SPECS: Record<string, string> = {
  style_clean_white: `PHOTOGRAPHY: Seamless white acrylic, mirror reflection of product underside. Key — 120cm octabox 45° front-left. Fill — white V-flat opposite 2:1. Accent — overhead strip softbox. 5600K daylight. Hasselblad X2D 100C, 90mm f/3.2, ISO 64.`,

  style_studio: `PHOTOGRAPHY: Colored seamless paper backdrop (choose complement to product). Three-point studio setup. Key — softbox 45° front-left. Fill — reflector 3:1. Rim light for edge separation. 5500K daylight. Hasselblad X2D 100C, 90mm f/3.2, ISO 64.`,

  style_gradient: `PHOTOGRAPHY: Polished black acrylic with mirror reflection. Two strip softbox rim lights behind-left and behind-right. Minimal fill 8:1+. Deep intentional shadows. Eye level to slightly below. Sony A7 IV, 50mm f/1.2, ISO 400.`,

  style_lifestyle: `PHOTOGRAPHY: Natural window light from one side, 3200-4500K, 3:1-4:1 ratio. Shallow DOF f/2.0-2.8. Canon EOS R5, 85mm f/1.4L, ISO 100. 25-40° above, rule-of-thirds.`,

  style_outdoor: `PHOTOGRAPHY: Golden hour backlight PRIMARY — 3000-3500K sun low behind product creating golden rim. Open shade fill. 4:1 ratio. DOF f/1.4-2.0 MANDATORY. Fujifilm X-T5, 56mm f/1.2, Classic Chrome.`,

  style_festive: `PHOTOGRAPHY: Primary warm diya glow 2700-3000K. Multiple warm point sources at varying distances creating layered golden bokeh. 3:1 ratio. 25-40° above. Canon EOS R5, 85mm f/1.4L, ISO 400.`,

  style_minimal: `PHOTOGRAPHY: Single strong directional source 60-80° from camera creating LONG dramatic shadow. 5000K neutral. 4:1-5:1 ratio. Product 30-40% of frame, rest is intentional negative space. Hasselblad X2D 100C, 90mm f/3.2, ISO 64.`,

  style_with_model: `PHOTOGRAPHY: Key light 45° front-left, 5000-5600K. Product and person MUST have matching shadows. Shallow DOF f/2.0-2.8 with blurred contextual background. Canon EOS R5, 85mm f/1.4L, ISO 100.

MODEL: Indian/South Asian person, candid expression caught mid-action. Natural skin (visible pores, subtle blemishes, slightly asymmetric smile). Hair with soft wispy edges and flyaway strands. ONE person only. Clothing: solid neutral colors, no competing logos.

ANATOMY (CRITICAL): Exactly 2 arms, 2 legs, 2 feet, 2 hands. Each hand has exactly 5 fingers. When seated or in complex poses, every limb must be CLEARLY distinguishable — no ambiguous merged legs or phantom limbs. Natural body proportions throughout.

GRIP: Match product size/weight — pinch for flat items, wrap for bottles, cup for jars. NEVER pose for camera.`,
};

// ---------------------------------------------------------------------------
// Few-shot creative concept examples
// ---------------------------------------------------------------------------

const FEW_SHOT_EXAMPLES = `
## EXAMPLES OF SCROLL-STOPPING CREATIVE CONCEPTS

Example 1 — Masala Chips Pack (style_gradient — INGREDIENT EXPLOSION):
{
  "heroMoment": "The explosive burst of spice and crunch when you rip open a fresh pack",
  "dynamicElements": ["chips and spice particles EXPLODING outward from the pack in a halo", "red chili powder cloud suspended mid-air", "one chip frozen mid-flight showing seasoning crystals catching rim light", "crushed peanuts and curry leaves scattered at the base"],
  "emotionalTrigger": "craving",
  "storyScene": "Pitch black background. The masala chips pack stands on polished black acrylic, its surface reflecting below. An EXPLOSION of chips, chili powder, curry leaves, and peanut fragments erupts outward from the opened top — each chip frozen mid-flight, each spice particle caught in the dual rim lights. Red chili powder forms a dramatic cloud around the pack. The label is sharply lit and legible.",
  "creativeBrief": "Editorial product advertisement. Against total darkness, the masala chips pack stands center-frame on wet black acrylic, its mirror reflection visible below. Two strip softbox rim lights from behind-left and behind-right create razor-sharp glowing edges on the metallic packaging. From the torn-open top, an explosion of chips, red chili powder, crushed peanuts, and curry leaves erupts outward in a frozen burst — each element suspended mid-air, lit by the rim lights. Individual chili powder particles form a red-orange cloud around the upper half of the pack. One large chip is frozen at the peak of its arc, its seasoning crystals catching individual specks of light. At the base, scattered curry leaves and peanut fragments rest on the wet black surface among the reflection. Hard key light from front-left at 45° illuminates the pack label. The acrylic surface shows authentic wet sheen. Subtle film grain. Square format, 1:1 aspect ratio."
}

Example 2 — Energy Drink Can (style_gradient — SPLASH + ICE):
{
  "heroMoment": "The adrenaline rush of ice-cold energy exploding in your hand",
  "dynamicElements": ["massive water and ice splash erupting from behind the can", "ice chunks and shards frozen mid-explosion at the base", "condensation droplets beading on the can surface", "low-lying cold mist rolling across the dark surface", "colored accent rim light matching the can's flavor color"],
  "emotionalTrigger": "energy",
  "storyScene": "Pure black void. The energy can sits on wet black obsidian. A violent explosion of water, crushed ice, and ice shards erupts from behind and around the can, frozen at its peak. The can is covered in beaded condensation. Cold mist rolls at the base. Dual rim lights from behind — one matching the can's brand color (green, orange, or blue), the other cool white — create a chromatic glow on every water droplet.",
  "creativeBrief": "Editorial product advertisement. Against pure black, the energy can stands on polished black obsidian with its reflection visible below. Behind the can, a massive crown-shaped splash of water and crushed ice erupts upward and outward, frozen at 1/8000s — individual droplets razor-sharp against the darkness. Two strip softbox rim lights: one in the can's brand accent color, one cool white, create dual-colored edges on every surface. Ice chunks and shards scatter at the base, some caught mid-bounce. The can surface is covered in beaded condensation, each droplet acting as a tiny lens. Low-lying cold mist rolls across the obsidian surface. The can label is sharply legible, illuminated by a subtle warm key from front-left. The wet surface reflects the chaos of the splash. Subtle vignetting at edges. Square format, 1:1 aspect ratio."
}

Example 3 — Diamond Necklace (style_festive — DIYA GLOW):
{
  "heroMoment": "The auspicious radiance of precious jewelry lit by sacred flames",
  "dynamicElements": ["lit diyas creating warm pools of golden light from multiple points", "each gemstone refracting a different color of firelight", "scattered marigold petals catching the warm glow", "fine kumkum dust particles floating in the diya light"],
  "emotionalTrigger": "desire",
  "storyScene": "A brass thali on red velvet. The diamond necklace is arranged in a horseshoe arc, flanked by two lit brass diyas whose flames create the primary warm lighting. Marigold petals scattered around. Gold coins at the edges. Each diamond catches the diya firelight at a different angle, creating multiple sparkle points. Fine kumkum particles float in the warm air. Golden fairy light bokeh at three depths behind. NO person, NO hands.",
  "creativeBrief": "Editorial product advertisement. On deep red velvet draped over a brass thali, the diamond necklace is arranged in an elegant arc. Two lit brass diyas flank the piece — their 2700K flames are the primary light source, creating warm golden pools that illuminate the gems. Each diamond facet catches the flickering firelight at a unique angle — some producing white fire, others warm amber. Matching earrings placed symmetrically below. Scattered marigold petals and gold coins at the edges catch individual specks of firelight. Fine kumkum dust particles are visible in the warm air. Behind, golden fairy light bokeh circles at three different depths create layered warmth. The red velvet shows its pile texture. Subtle film grain. NO person, NO hands, NO body parts. Square format, 1:1 aspect ratio."
}

Example 4 — Face Serum Bottle (style_lifestyle — TEXTURE + BOTANICAL):
{
  "heroMoment": "The glowing, dewy-skin promise of a perfect morning skincare ritual",
  "dynamicElements": ["serum drop caught mid-fall from the dropper, backlit like liquid gold", "fresh-cut citrus and botanical ingredients arranged around with visible dew", "product swatch smeared on a glass surface showing translucent gel texture"],
  "emotionalTrigger": "freshness",
  "storyScene": "A marble bathroom vanity in soft morning light. The serum bottle stands with its dropper lifted, a single golden drop caught mid-fall, backlit. Around the base: a halved orange, fresh aloe leaf, rosemary sprig — all misted with water droplets looking fresh-picked. A smear of the serum on the marble surface catches light, showing its gel consistency. Warm directional light from a window on the left.",
  "creativeBrief": "Editorial product advertisement. On a white marble vanity surface, the face serum bottle stands slightly left of center. The glass dropper is lifted above the bottle — a single luminous drop of golden serum is caught mid-fall, backlit by soft 4000K window light from the left that makes it glow like liquid amber. Around the bottle base: a halved blood orange, a fresh-cut aloe leaf showing its gel interior, and a rosemary sprig — all misted with fine water droplets that catch individual specks of light. On the marble surface near the bottle, a small swatch of serum is smeared, showing its translucent gel texture. The marble shows natural veining. A small white ceramic dish and folded linen towel provide context. Shot on Canon EOS R5, 85mm f/1.4, shallow DOF with the bathroom blurred into soft warm tones. Square format, 1:1 aspect ratio."
}

Example 5 — Kurti/Ethnic Dress (style_studio — FABRIC MOTION + COLOR):
{
  "heroMoment": "The flowing elegance of fabric that makes you feel beautiful",
  "dynamicElements": ["fabric edge caught mid-flow as if a gentle breeze just passed", "rich colored backdrop complementing the garment's palette", "dramatic shadow of the garment cast on the colored surface"],
  "emotionalTrigger": "confidence",
  "storyScene": "A deep teal seamless paper backdrop. The embroidered kurti is displayed on an invisible form, its fabric edge caught mid-ripple as if touched by wind. The garment's embroidery details catch the hard key light. A dramatic shadow of the garment falls on the teal surface, creating a second compositional element. One small prop at the base: a pair of jhumka earrings or mojari shoes.",
  "creativeBrief": "Editorial product advertisement. Against a rich deep teal seamless paper backdrop, the embroidered kurti is displayed showing its full silhouette. The fabric's bottom edge is caught mid-ripple, creating dynamic movement. Hard key light from 45° front-left at 5500K creates a dramatic shadow of the garment on the teal surface — the shadow becomes a compositional element, stretching to the right. Fill light from a reflector at 3:1 ratio preserves embroidery detail in the shadows. The embroidery thread catches specular highlights. At the base, a pair of brass jhumka earrings provides scale and cultural context. The teal backdrop was chosen to complement the garment's warm tones — maximum color contrast. Shot on Hasselblad X2D 100C, 90mm f/3.2 for razor-sharp textile detail. Square format, 1:1 aspect ratio."
}

Example 6 — Leather Handbag (style_outdoor — GOLDEN HOUR):
{
  "heroMoment": "The adventurous spirit of a bag that's ready to go anywhere",
  "dynamicElements": ["golden hour backlight creating a warm rim glow on every leather edge", "sun-warmed stone surface with visible lichen texture", "wildflower stem in foreground creating depth blur"],
  "emotionalTrigger": "joy",
  "storyScene": "OUTDOORS on a flat sun-warmed stone surface beside a trail. The leather bag sits with its flap open, a map peeking out. Golden hour sun is LOW and behind, creating a golden rim on every leather edge and brass buckle. A single wildflower stem in the left foreground is blurred. Behind the bag, a hiking trail dissolves into green-gold foliage bokeh. The viewer feels wanderlust.",
  "creativeBrief": "Editorial product advertisement. OUTDOORS: the leather bag sits on a flat, sun-warmed sandstone surface beside a trail. The bag's flap is casually open with a folded map peeking out. Golden hour sun at 3200K is positioned low behind the bag, creating a warm golden rim on every leather edge, stitch line, and brass buckle — the rim glow is the hero effect. A single wildflower stem enters from the bottom-left, its petals in soft foreground blur creating depth. Behind the bag, a hiking trail curves away and dissolves into lush green-gold foliage in extreme bokeh at f/1.4. The stone surface shows natural lichen and mineral variation. The leather shows authentic grain texture and patina. Shot on Fujifilm X-T5, 56mm f/1.2, Classic Chrome film simulation. Square format, 1:1 aspect ratio."
}

Example 7 — Eau de Parfum Bottle (style_with_model — PERSON USING PRODUCT):
{
  "heroMoment": "The intoxicating confidence of a final spritz before stepping out for the evening",
  "dynamicElements": ["mist of perfume frozen mid-spray catching the warm light", "person's eyes closed savoring the fragrance", "dresser mirror reflecting the scene from a second angle"],
  "emotionalTrigger": "confidence",
  "storyScene": "An Indian man in a fitted charcoal shirt stands at a bedroom dresser. He holds the perfume bottle in his right hand, spraying it on his left wrist — the fine mist is frozen mid-spray, catching warm side-light. His eyes are closed, chin slightly lifted, savoring the scent. The perfume bottle label is clearly visible. Behind him, a dresser mirror reflects the bottle from another angle. Warm evening light from a lamp.",
  "creativeBrief": "Editorial product advertisement. An Indian man in a charcoal linen shirt at a bedroom dresser, spraying the Eau de Parfum on his left wrist. Fine perfume mist frozen mid-spray catches warm 3200K lamp light from the right. His eyes are closed, chin slightly raised, savoring the fragrance. The bottle label faces camera, clearly legible. Dresser mirror behind reflects the scene. Warm amber tones throughout. Shot on Canon EOS R5, 85mm f/1.4, shallow DOF blurring the bedroom. Square format, 1:1 aspect ratio."
}

Example 8 — Protein Bar (style_with_model — PERSON IN CONTEXT):
{
  "heroMoment": "The satisfying refuel after pushing your body to its limits",
  "dynamicElements": ["person unwrapping the bar, foil peeling back revealing the texture inside", "slight sheen of sweat on forehead from workout", "gym equipment blurred in background"],
  "emotionalTrigger": "energy",
  "storyScene": "An Indian woman in gym clothes sits on a bench in a gym, unwrapping the protein bar. She's mid-bite — the bar is broken to show the textured interior. A light sheen of post-workout sweat on her forehead. A water bottle sits beside her. Gym equipment dissolves into warm bokeh behind. The product wrapper is clearly visible with branding facing camera.",
  "creativeBrief": "Editorial product advertisement. Indian woman in black athletic wear sitting on a gym bench post-workout. She holds the protein bar in her right hand, mid-bite, bar broken to show interior texture. Left hand holds the wrapper with branding facing camera. Light sheen of sweat on forehead. Water bottle beside her on bench. Gym equipment in warm bokeh behind. Warm overhead gym lighting. Shot on Canon EOS R5, 85mm f/1.4, ISO 400. Square format, 1:1 aspect ratio."
}
`;

// ---------------------------------------------------------------------------
// Style Mandate Helper
// ---------------------------------------------------------------------------

function getStyleMandate(style: string): string {
  const mandates: Record<string, string> = {
    style_festive: 'FESTIVE/DIWALI SCENE: Warm diya glow (2700-3000K), cultural props (brass thali, marigold petals, rangoli), golden bokeh, rich jewel tones. Scene must feel like an Indian celebration/festival. NO modern/gym/office settings.',
    style_gradient: 'DARK LUXURY: Deep black or dark gradient background, dramatic rim lighting, reflective surface, minimal props. Moody, premium, cinematic feel. NO bright/outdoor/festive settings.',
    style_outdoor: 'NATURAL OUTDOOR: Golden-hour natural light, organic textures (wood, stone, leaves), real outdoor environment. NO studio/indoor settings.',
    style_lifestyle: 'LIFESTYLE SETTING: Warm home/cafe/workspace environment, natural light, lived-in feel with contextual props. Aspirational but relatable.',
    style_studio: 'COLORED STUDIO: Clean colored backdrop (not white), professional studio lighting, product-focused with minimal props.',
    style_clean_white: 'CLEAN WHITE: Pure white background, soft even lighting, product floating or on minimal surface. E-commerce style.',
    style_minimal: 'MINIMAL & CLEAN: Muted neutral tones, very few props, lots of negative space, calm and elegant composition.',
    style_with_model: 'WITH HUMAN MODEL: An Indian person naturally interacting with the product. Lifestyle context appropriate to the product category.',
  };
  return mandates[style] ?? 'Follow the selected style closely.';
}

// ---------------------------------------------------------------------------
// V3 Prompt Builder
// ---------------------------------------------------------------------------

function buildV3Prompt(style?: string, voiceInstructions?: string): string {
  const styleKey = style ?? 'style_lifestyle';

  // Get the narrative for this style + we'll let Gemini pick category dynamically
  const narrativeMap = STYLE_NARRATIVES[styleKey] ?? STYLE_NARRATIVES['style_lifestyle']!;
  const narrativeEntries = Object.entries(narrativeMap)
    .map(([cat, narrative]) => `- IF ${cat.toUpperCase()}: ${narrative}`)
    .join('\n');

  const photoSpec = PHOTOGRAPHY_SPECS[styleKey] ?? PHOTOGRAPHY_SPECS['style_lifestyle']!;

  let prompt = `You are an elite advertising creative director AND product photographer. Your job is to conceive a COMPELLING advertisement concept — not just a nice photo, but an image that makes someone STOP SCROLLING and WANT this product.

Your response MUST be valid JSON only — no markdown, no explanation.

== MANDATORY STYLE: ${styleKey} ==
Every field you return — heroMoment, storyScene, creativeBrief, dynamicElements — MUST match this style.
${getStyleMandate(styleKey)}
Do NOT override this style based on product type. The user chose this style explicitly.

## STEP 1: Input Quality Assessment
- Is this photo usable? Reject only if: no product visible, extremely blurry (<100px), corrupted
- Accept messy backgrounds, poor lighting, bad angles — we fix everything
- "hasGlare": true if visible specular reflections or flash hotspots on product
- "inputAngleQuality": "good"/"suboptimal"/"unusable"

## STEP 2: Product Identification (be EXTREMELY specific)
Full brand name, product type, variant, size. NOT "speaker" but "Anker SoundCore 2 Portable Bluetooth Speaker, black mesh front, ANKER logo on face."
- productComponents: List EVERY visible physical sub-component of the product (cap, lid, straw, cable, stand, box, tag, applicator, tube, wrapper). Be exhaustive — if you can see it, list it.

## STEP 2.5: Physical Characteristics
- "productPhysicalSize": "tiny" (palm-sized) | "small" (hand-sized) | "medium" (forearm-sized) | "large" (bigger)
- "productDimensionality": "flat_2d" | "shallow_3d" | "deep_3d"
- "recommendedCanvasFill": 0.3-0.95 (tiny+flat=0.85, large=0.60)

## STEP 3: Branding Detection
- "hasBranding": true if ANY brand text/logo/mark visible
- "brandingConfidence": 0.0-1.0 (when uncertain, err HIGH — better to preserve than destroy)
- "brandElements": list every visible brand element

## STEP 4: Full Product Analysis
Deep analysis: colors, materials, textures, target audience, price segment, scene, ad best practices.

## STEP 5: CREATIVE CONCEPT (THIS IS THE MOST IMPORTANT STEP)

You are now the creative director. Your job is to design an advertisement that makes people WANT this product.

### 5a: Hero Moment
What single EMOTIONAL MOMENT should this ad capture? Not "product on a nice background" but a specific human moment that triggers desire. Examples: "the first sip of ice-cold lemonade on a hot day", "the satisfaction of biting into a warm cookie", "the quiet confidence of clasping on a precious necklace."

### 5b: Dynamic Elements
What specific MOTION, TEXTURE, or ACTION elements make this ad come alive? These are the details that separate a boring product photo from a COMPELLING advertisement. Examples: water splashes, crumbs scattered, steam rising, condensation droplets, ingredients mid-fall, fabric draping, sparkle on gems, smoke wisps, liquid pouring.

The style is FIXED as ${styleKey}. You MUST use ONLY these elements — do NOT invent a different setting or context:
${narrativeEntries}

### 5c: Emotional Trigger
What should the viewer FEEL? One of: craving, desire, energy, comfort, luxury, freshness, joy, confidence

### 5d: Story Scene
Describe what is HAPPENING in this image in 2-3 sentences. Not camera specs — the SCENE. What objects are where? What action is frozen? What's the setting?

### 5e: Creative Brief
Write a 60-100 word TIGHT scene description for the AI image generator. Start with "Editorial product advertisement." then describe the physical scene: surface, product position, dynamic elements, lighting direction and color temperature, lens/DOF. Be SPECIFIC about what is WHERE — not flowery prose. This goes directly to the image generator.

IMPORTANT: The product must look like a PHOTOGRAPHED physical object — NOT a 3D render. Include material cues in the brief: "packaging catches key light with specular highlights", "slight dimensional bulging from contents", "visible crinkle texture on foil/plastic", "glass surface shows reflections", "metal has natural sheen". The product should look premium and beautiful but REAL — like a high-end photoshoot, not a CGI illustration.

${photoSpec}

${FEW_SHOT_EXAMPLES}

### 5f: Scene Prompt (40-70 words)
A concise creative ad scene description for image generation. Focus on the STORY and DYNAMIC ELEMENTS, not camera specs.

### 5g: Background-Only Prompt (40-70 words)
An EMPTY scene matching the style with NO product. "no products, no objects in center, clear negative space."

## RULES FOR THE CREATIVE BRIEF:
- EXACTLY ONE product in the image — NEVER duplicate or clone
- Product is the HERO — fills the recommended canvas percentage
- Product MUST obey gravity (lies flat, leans, or stands on base)
- Product matches original photo EXACTLY — same shape, colors, text, logos
- The image is EDGE TO EDGE — NO borders, frames, picture-frame effects, or decorative edges anywhere
- Do NOT add ANY text, watermarks, labels, attribution text, "AI Generated" text, or copyright notices ANYWHERE
- No illustrated or cartoon elements — everything is photorealistic
- Include natural photographic imperfections: "subtle film grain at full resolution", "dust motes in rim light", "slight vignetting at edges", "surfaces show micro-texture and real-world wear"
- Frame as describing a photograph that ALREADY EXISTS
- End with: "Square format, 1:1 aspect ratio."
- CRITICAL PERSON RULE:
  - If style is "style_with_model": You MUST include exactly ONE Indian person actively interacting with the product. This is MANDATORY — the creative brief, story scene, and hero moment MUST describe a person using/wearing/holding the product. Describe their age, gender, expression, clothing, skin tone, and how they interact with the product. Realistic features: visible pores, asymmetric candid smile, flyaway hair strands. Grip matches product size/weight.
  - For ALL other styles (style_studio, style_gradient, style_lifestyle, style_outdoor, style_festive, style_clean_white, style_minimal): ZERO people, ZERO hands, ZERO body parts, ZERO mannequins. The product sits on a surface or in an environment — NEVER on a person.

`;

  if (voiceInstructions && voiceInstructions.trim().length > 0) {
    const sanitizedInstructions = voiceInstructions
      .trim()
      .slice(0, 500)
      .replace(/[\x00-\x1F\x7F]/g, '') // strip control characters
      .replace(/\n{3,}/g, '\n\n'); // collapse excessive newlines
    prompt += `\nUser's additional instructions (incorporate into concept): ${sanitizedInstructions}\n\n`;
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
  "productPhysicalSize": "tiny" | "small" | "medium" | "large",
  "productDimensionality": "flat_2d" | "shallow_3d" | "deep_3d",
  "recommendedCanvasFill": number,
  "analysis": {
    "productName": string,
    "brandName": string | null,
    "productType": string,
    "specificDescription": string,
    "dominantColors": string[],
    "material": string,
    "shape": string,
    "keyVisualElements": string[],
    "productComponents": string[],
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
  "backgroundOnlyPrompt": string,
  "heroMoment": string,
  "dynamicElements": string[],
  "emotionalTrigger": "craving" | "desire" | "energy" | "comfort" | "luxury" | "freshness" | "joy" | "confidence",
  "storyScene": string,
  "creativeBrief": string
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
// V3 Consolidated Analysis
// ---------------------------------------------------------------------------

export async function analyzeAndPlanV3(
  imageBuffer: Buffer,
  voiceInstructions?: string,
  style?: string
): Promise<AnalyzeAndPlanV3Result> {
  const startMs = Date.now();

  const genai = new GoogleGenAI({
    apiKey: process.env['GOOGLE_AI_API_KEY'] ?? process.env['GOOGLE_GENAI_API_KEY'] ?? '',
  });

  const base64Image = imageBuffer.toString('base64');
  const mimeType = detectMime(imageBuffer);

  const prompt = buildV3Prompt(style, voiceInstructions);

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('analyzeAndPlanV3 timed out after 60s')), 60_000)
  );
  const response = await Promise.race([
    genai.models.generateContent({
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
    }),
    timeoutPromise,
  ]);

  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemini returned non-JSON for analyzeAndPlanV3: ${rawText.slice(0, 300)}`);
  }

  const result = AnalyzeAndPlanV3Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`analyzeAndPlanV3 schema validation failed: ${result.error.message}`);
  }

  console.info(JSON.stringify({
    event: 'v3_analyze_and_plan_complete',
    usable: result.data.usable,
    productName: result.data.analysis.productName,
    category: result.data.productCategory,
    hasBranding: result.data.hasBranding,
    brandingConfidence: result.data.brandingConfidence,
    heroMoment: result.data.heroMoment.slice(0, 80),
    emotionalTrigger: result.data.emotionalTrigger,
    dynamicElementCount: result.data.dynamicElements.length,
    storyScenePreview: result.data.storyScene.slice(0, 100),
    creativeBriefPreview: result.data.creativeBrief.slice(0, 100),
    style: style ?? 'default',
    durationMs: Date.now() - startMs,
  }));

  return result.data;
}
