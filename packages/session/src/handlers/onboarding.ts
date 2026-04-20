/**
 * Onboarding handlers — styles-first flow.
 *
 * New users: IDLE → SETUP_LANGUAGE → SETUP_NAME → SETUP_CATEGORY → SETUP_STYLE → AWAITING_PHOTO → payment
 * Returning users: IDLE → (confirm style or SETUP_STYLE) → AWAITING_PHOTO → payment
 */

import type { WhatsAppClient } from '@autmn/whatsapp';
import type { Session, User } from '@autmn/db';
import { prisma } from '@autmn/db';
import { uploadFile, Buckets } from '@autmn/storage';
import { transitionTo, updateUser } from '../db-helpers.js';
import { downloadWhatsAppMedia, mimeToExt } from './instructions.js';
import {
  styleDisplayName,
  msgAllStylesReady,
  msgSendProductPhotos,
  msgPickStylePack,
} from '../messages.js';
import { ListIds, ButtonIds, CATEGORY_STYLE_RECOMMENDATION, OUTPUT_STYLES_PER_ORDER } from '../types.js';
import type { Language } from '../types.js';
import type { MessageContext } from '../types.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// IDLE — entry point
// ---------------------------------------------------------------------------

export async function handleIdle(
  session: Session,
  user: User,
  message: MessageContext,
  wa: WhatsAppClient,
): Promise<void> {
  // Guard against stale dispatches — re-read state to ensure we're still IDLE.
  // Race condition: a button tap queued before payment completes can arrive while
  // the session is already in PROCESSING, causing phantom "Send your photo" messages.
  const fresh = await prisma.session.findUnique({
    where: { phoneNumber: session.phoneNumber },
    select: { state: true },
  });
  if (fresh && fresh.state !== 'IDLE') {
    console.info(JSON.stringify({
      event: 'handleIdle_stale_dispatch',
      phoneNumber: session.phoneNumber,
      currentState: fresh.state,
    }));
    return; // Session has moved past IDLE — don't show returning user prompts
  }

  const lang = user.language as Language;
  const isReturning = Boolean(user.name);

  logger.info('handleIdle called', { phoneNumber: session.phoneNumber, isReturning, lastStyleUsed: user.lastStyleUsed, lang });

  // Handle button replies from returning user style confirmation
  // This prevents an infinite loop where button taps re-enter handleIdle in IDLE state
  if (message.messageType === 'interactive' && message.buttonReplyId) {
    const buttonId = message.buttonReplyId;

    if (buttonId === ButtonIds.SAME_STYLE && user.lastStyleUsed) {
      // Restore the previous styleSelections if available, otherwise fall back to lastStyleUsed.
      // If fewer than OUTPUT_STYLES_PER_ORDER styles are saved, fill remaining slots from the
      // Smart Pack for the user's category (no style repeated).
      const prevSession = await prisma.session.findUnique({
        where: { phoneNumber: session.phoneNumber },
        select: { styleSelections: true },
      });
      const prevSelections = (prevSession?.styleSelections ?? []) as string[];

      let selections: string[];
      if (prevSelections.length >= OUTPUT_STYLES_PER_ORDER) {
        selections = prevSelections.slice(0, OUTPUT_STYLES_PER_ORDER);
      } else {
        const saved = prevSelections.length > 0 ? prevSelections : [user.lastStyleUsed];
        selections = fillWithSmartPack(saved, user.businessType ?? null, OUTPUT_STYLES_PER_ORDER);
      }

      // Atomic guard: only the first handler to claim IDLE→AWAITING_PHOTO proceeds
      const claimed = await prisma.session.updateMany({
        where: { phoneNumber: session.phoneNumber, state: 'IDLE' },
        data: {
          state: 'AWAITING_PHOTO',
          stateEnteredAt: new Date(),
          styleSelection: selections[0] ?? user.lastStyleUsed,
          styleSelections: selections,
          stylePickStep: 0,
          imageMediaIds: [],
          imageStorageUrls: [],
          voiceInstructions: null,
          currentOrderId: null,
          earlyPhotoMediaId: null,
        },
      });
      if (claimed.count === 0) return; // another handler already transitioned

      const styleNames = selections.map(s => styleDisplayName(s, lang));
      await wa.sendText(session.phoneNumber, msgAllStylesReady(lang, styleNames));
      await wa.sendText(session.phoneNumber, msgSendProductPhotos(lang));
      return;
    }

    if (buttonId === ButtonIds.NEW_STYLE || buttonId === 'try_new_style') {
      // Atomic guard: only the first handler to claim IDLE→SETUP_STYLE proceeds
      const claimed = await prisma.session.updateMany({
        where: { phoneNumber: session.phoneNumber, state: 'IDLE' },
        data: {
          state: 'SETUP_STYLE',
          stateEnteredAt: new Date(),
          styleSelection: null,
          styleSelections: [],
          stylePickStep: 0,
          currentOrderId: null,
          earlyPhotoMediaId: null,
        },
      });
      if (claimed.count === 0) return; // another handler already transitioned

      // Now send the style list (only runs once)
      await sendStyleList(session.phoneNumber, lang, wa, user.businessType ?? undefined, []);
      return;
    }
  }

  if (isReturning) {
    // --- Returning user with saved style: confirm ---
    if (user.lastStyleUsed) {
      const styleName = styleDisplayName(user.lastStyleUsed, lang);

      // We always resolve to 3 styles (filling from Smart Pack if needed), so label
      // is always "Same 3 styles" regardless of how many were previously saved.
      const prevSession = await prisma.session.findUnique({
        where: { phoneNumber: session.phoneNumber },
        select: { styleSelections: true },
      });
      const hasFullPack = (prevSession?.styleSelections ?? []).length >= OUTPUT_STYLES_PER_ORDER;
      const sameLabel = lang === 'hinglish' ? 'Same 3 styles' : 'Same 3 styles';

      // If they sent a photo directly, download + upload immediately, then ask style
      if (message.messageType === 'image' && message.mediaId) {
        let storageUrl: string | null = null;
        try {
          const { buffer, mimeType } = await downloadWhatsAppMedia(message.mediaId);
          const ext = mimeToExt(mimeType);
          const path = `${session.phoneNumber}/${Date.now()}_0${ext}`;
          storageUrl = await uploadFile(Buckets.RAW_IMAGES, path, buffer, mimeType);
        } catch (err) {
          logger.error('Failed to download/upload early photo in IDLE', {
            phoneNumber: session.phoneNumber,
            mediaId: message.mediaId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        await prisma.session.update({
          where: { phoneNumber: session.phoneNumber },
          data: {
            state: 'AWAITING_PHOTO',
            stateEnteredAt: new Date(),
            imageMediaIds: storageUrl ? [message.mediaId] : [],
            imageStorageUrls: storageUrl ? [storageUrl] : [],
            earlyPhotoMediaId: null,
            styleSelection: null,
            voiceInstructions: message.caption?.trim() || null,
            currentOrderId: null,
          },
        });
        const bodyText = hasFullPack
          ? (lang === 'hinglish'
            ? `Photo mil gayi, ${user.name} ji!\nPehle ke 3 styles use karein?`
            : `Got your photo, ${user.name}!\nUse your previous 3 styles?`)
          : (lang === 'hinglish'
            ? `Photo mil gayi, ${user.name} ji!\n${styleName} style lagayein?`
            : `Got your photo, ${user.name}!\nUse ${styleName} style?`);
        try {
          await wa.sendButtons(
            session.phoneNumber,
            bodyText,
            [
              { id: ButtonIds.SAME_STYLE, title: sameLabel },
              { id: ButtonIds.NEW_STYLE, title: lang === 'hinglish' ? 'Naye styles' : 'New styles' },
            ],
          );
        } catch (btnErr) {
          logger.error('sendButtons failed in handleIdle (photo path), falling back to sendText', { phoneNumber: session.phoneNumber, error: String(btnErr) });
          await wa.sendText(session.phoneNumber, lang === 'hinglish'
            ? `Photo mil gayi, ${user.name} ji! Kaunsa style: "${styleName}" ya naya?`
            : `Got your photo, ${user.name}! Use "${styleName}" style or pick new ones?`);
        }
        return;
      }

      // Text message: show style confirmation
      logger.info('Sending returning-user style confirmation buttons', { phoneNumber: session.phoneNumber, styleName, hasFullPack });
      const confirmBody = hasFullPack
        ? (lang === 'hinglish'
          ? `${user.name} ji! Photo bhejiye — pehle ke 3 styles mein banayenge.\nStyles badalne hain?`
          : `${user.name}! Send your photo — we'll use your previous 3 styles.\nWant different styles?`)
        : (lang === 'hinglish'
          ? `${user.name} ji! Photo bhejiye — ${styleName} mein banayenge.\nStyle badlana hai?`
          : `${user.name}! Send your photo — we'll use ${styleName}.\nWant a different style?`);
      try {
        await wa.sendButtons(
          session.phoneNumber,
          confirmBody,
          [
            { id: ButtonIds.SAME_STYLE, title: sameLabel },
            { id: ButtonIds.NEW_STYLE, title: lang === 'hinglish' ? 'Naye styles' : 'New styles' },
          ],
        );
        logger.info('sendButtons succeeded', { phoneNumber: session.phoneNumber });
      } catch (btnErr) {
        logger.error('sendButtons failed in handleIdle, falling back to sendText', { phoneNumber: session.phoneNumber, error: String(btnErr) });
        await wa.sendText(
          session.phoneNumber,
          lang === 'hinglish'
            ? `Wapas aao, ${user.name} ji! Photo bhejiye, "${styleName}" mein banayenge.`
            : `Welcome back, ${user.name}! Send your product photo — we'll use "${styleName}".`,
        );
      }
      return;
    }

    // --- Returning user without saved style: go to SETUP_STYLE (styles before photos) ---
    logger.info('Returning user — no lastStyleUsed, transitioning to SETUP_STYLE', { phoneNumber: session.phoneNumber });
    await transitionTo(session.phoneNumber, 'SETUP_STYLE', {
      imageMediaIds: [],
      imageStorageUrls: [],
      styleSelection: null,
      styleSelections: [],
      stylePickStep: 0,
      voiceInstructions: null,
      currentOrderId: null,
      earlyPhotoMediaId: null,
    });
    try {
      await wa.sendText(
        session.phoneNumber,
        lang === 'hinglish' ? `Wapas aao, ${user.name} ji!` : `Welcome back, ${user.name}!`,
      );
    } catch (txtErr) {
      logger.error('sendText failed for welcome back message', { phoneNumber: session.phoneNumber, error: String(txtErr) });
    }
    await sendStyleList(session.phoneNumber, lang, wa, user.businessType ?? undefined, []);
    return;
  }

  // --- New user: welcome + language picker ---
  await transitionTo(session.phoneNumber, 'SETUP_LANGUAGE');
  try {
    await wa.sendButtons(
      session.phoneNumber,
      'Namaste! Welcome to Autmn.\nKaunsi bhasha? Which language?',
      [
        { id: ButtonIds.LANG_HINDI, title: 'Hindi' },
        { id: ButtonIds.LANG_ENGLISH, title: 'English' },
      ],
    );
  } catch (btnErr) {
    logger.error('sendButtons failed for new user language picker, falling back to sendText', { phoneNumber: session.phoneNumber, error: String(btnErr) });
    await wa.sendText(session.phoneNumber, 'Namaste! Welcome to Autmn.\nReply "Hindi" or "English" to continue.');
  }
}

// ---------------------------------------------------------------------------
// SETUP_LANGUAGE — user picks Hindi or English
// ---------------------------------------------------------------------------

export async function handleSetupLanguage(
  session: Session,
  user: User,
  message: MessageContext,
  wa: WhatsAppClient,
): Promise<void> {
  let lang: Language = 'en';

  if (message.messageType === 'interactive' && message.buttonReplyId) {
    lang = message.buttonReplyId === ButtonIds.LANG_HINDI ? 'hinglish' : 'en';
  } else if (message.messageType === 'text' && message.text) {
    const text = message.text.toLowerCase().trim() ?? '';
    const isHinglish = text === 'hindi' || text === '1' || text === 'हिंदी' || text === 'हिन्दी' ||
                    text.includes('hindi') || text.includes('हिं');
    lang = isHinglish ? 'hinglish' : 'en';
  }

  await updateUser(session.phoneNumber, { language: lang });
  await transitionTo(session.phoneNumber, 'SETUP_NAME');
  await wa.sendText(
    session.phoneNumber,
    lang === 'hinglish' ? 'Aapka naam bataiye?' : "What's your name?",
  );
}

// ---------------------------------------------------------------------------
// SETUP_NAME — user types their name
// ---------------------------------------------------------------------------

export async function handleSetupName(
  session: Session,
  user: User,
  message: MessageContext,
  wa: WhatsAppClient,
): Promise<void> {
  const lang = user.language as Language;
  const rawName = message.text?.trim();

  if (!rawName || rawName.length < 1) {
    await wa.sendText(
      session.phoneNumber,
      lang === 'hinglish' ? 'Naam likh ke bhejiye.' : 'Please type your name.',
    );
    return;
  }

  // Sanitize: strip non-printable characters, truncate to 50 chars
  // eslint-disable-next-line no-control-regex
  const sanitized = rawName.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 50);
  const name = sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
  await updateUser(session.phoneNumber, { name });

  // Go straight to category — no filler message
  await transitionTo(session.phoneNumber, 'SETUP_CATEGORY');
  await sendCategoryList(session.phoneNumber, lang, wa, name);
}

// ---------------------------------------------------------------------------
// SETUP_CATEGORY — user picks category, style list appears immediately
// ---------------------------------------------------------------------------

export async function handleSetupCategory(
  session: Session,
  user: User,
  message: MessageContext,
  wa: WhatsAppClient,
): Promise<void> {
  const lang = user.language as Language;

  if (message.messageType !== 'interactive' || !message.listReplyId) {
    await sendCategoryList(session.phoneNumber, lang, wa, user.name ?? undefined);
    return;
  }

  const categoryId = message.listReplyId;
  if (!VALID_CATEGORY_IDS.has(categoryId)) {
    await sendCategoryList(session.phoneNumber, lang, wa, user.name ?? undefined);
    return;
  }

  await updateUser(session.phoneNumber, { businessType: categoryId });

  // Styles-first: go to SETUP_STYLE so user picks style before sending photos
  await transitionTo(session.phoneNumber, 'SETUP_STYLE', {
    currentOrderId: null,
    styleSelection: null,
    styleSelections: [],
    stylePickStep: 0,
    imageMediaIds: [],
    imageStorageUrls: [],
    voiceInstructions: null,
    earlyPhotoMediaId: null,
  });
  await sendStyleList(session.phoneNumber, lang, wa, categoryId, []);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export async function sendCategoryList(
  phoneNumber: string,
  lang: Language,
  wa: WhatsAppClient,
  name?: string,
): Promise<void> {
  const greeting = name
    ? (lang === 'hinglish' ? `Shukriya, ${name} ji! Aap kaunsa product bechte hain?` : `Thanks, ${name}! What kind of product do you sell?`)
    : (lang === 'hinglish' ? 'Aap kaunsa product bechte hain?' : 'What kind of product do you sell?');

  await wa.sendList(
    phoneNumber,
    greeting,
    lang === 'hinglish' ? 'Chuniye' : 'Choose',
    [
      {
        title: lang === 'hinglish' ? 'Product type' : 'Product Type',
        rows: [
          { id: ListIds.CAT_JEWELLERY, title: lang === 'hinglish' ? 'Jewellery / Zewar' : 'Jewellery', description: 'Rings, necklaces, earrings...' },
          { id: ListIds.CAT_FOOD, title: lang === 'hinglish' ? 'Khaana / Food' : 'Food', description: 'Packaged food, sweets, snacks...' },
          { id: ListIds.CAT_GARMENT, title: lang === 'hinglish' ? 'Kapde / Garments' : 'Garments', description: 'Sarees, kurtas, shirts...' },
          { id: ListIds.CAT_SKINCARE, title: 'Skincare / Beauty', description: 'Creams, serums, cosmetics...' },
          { id: ListIds.CAT_CANDLE, title: 'Candle / Home Decor', description: 'Candles, diffusers, decor...' },
          { id: ListIds.CAT_BAG, title: 'Bag / Purse', description: 'Handbags, wallets, clutches...' },
          { id: ListIds.CAT_GENERAL, title: lang === 'hinglish' ? 'Kuch Aur' : 'Other', description: 'Electronics, toys, etc...' },
        ],
      },
    ],
  );
}

/**
 * Sends the style PACK picker — a single WhatsApp list where each row is a
 * pre-made 3-style bundle. Selecting one pack resolves all 3 styles at once.
 * "Custom" triggers the sequential 3-step individual style picker.
 *
 * Called from SETUP_STYLE state (after photos are already collected).
 */
export async function sendStylePackList(
  phoneNumber: string,
  lang: Language,
  wa: WhatsAppClient,
  categoryId?: string,
): Promise<void> {
  const headerText = msgPickStylePack(lang);

  const rows = [
    {
      id: ListIds.SMART_PACK,
      title: lang === 'hinglish' ? 'Smart Pack \u2728' : 'Smart Pack \u2728',
      description: lang === 'hinglish'
        ? 'AI aapke product ke liye 3 best styles chunega'
        : 'AI picks the best 3 styles for your product',
    },
    {
      id: ListIds.BESTSELLER_PACK,
      title: lang === 'hinglish' ? 'Best Seller Pack \ud83c\udfc6' : 'Best Seller Pack \ud83c\udfc6',
      description: lang === 'hinglish'
        ? 'Lifestyle + Studio + Dark Luxury'
        : 'Lifestyle + Studio + Dark Luxury',
    },
    {
      id: ListIds.FESTIVAL_PACK,
      title: lang === 'hinglish' ? 'Festival Pack \ud83c\udf89' : 'Festival Pack \ud83c\udf89',
      description: lang === 'hinglish'
        ? 'Tyohar + Lifestyle + Clean White'
        : 'Festive + Lifestyle + Clean White',
    },
    {
      id: ListIds.ACTION_PACK,
      title: lang === 'hinglish' ? 'Action Pack \ud83d\udcaa' : 'Action Pack \ud83d\udcaa',
      description: lang === 'hinglish'
        ? 'Model + Outdoor + Lifestyle'
        : 'With Model + Outdoor + Lifestyle',
    },
    {
      id: ListIds.CUSTOM_PACK,
      title: lang === 'hinglish' ? 'Custom \ud83c\udfa8' : 'Custom \ud83c\udfa8',
      description: lang === 'hinglish'
        ? 'Khud 3 styles chuniye'
        : 'Pick 3 styles yourself',
    },
  ];

  await wa.sendList(
    phoneNumber,
    headerText,
    lang === 'hinglish' ? 'Pack chuniye' : 'Choose pack',
    [{ title: lang === 'hinglish' ? 'Style Packs' : 'Style Packs', rows }],
  );
}

/**
 * Sends the individual style list for a specific step in the custom 3-step picker.
 * Only called when the user selects Custom pack.
 */
export async function sendStyleList(
  phoneNumber: string,
  lang: Language,
  wa: WhatsAppClient,
  categoryId?: string,
  alreadyPicked: string[] = [],
): Promise<void> {
  const recStyleId = categoryId ? (CATEGORY_STYLE_RECOMMENDATION[categoryId] ?? null) : null;
  const pickNumber = alreadyPicked.length + 1; // 1, 2, or 3
  const isFirstPick = pickNumber === 1;

  const makeDesc = (id: string, desc: string) => {
    return id === recStyleId ? `${desc} -- Recommended` : desc;
  };

  // All individual style rows (excluding already-picked styles)
  const individualRows = [
    { id: ListIds.STYLE_AUTMN_SPECIAL, title: styleDisplayName(ListIds.STYLE_AUTMN_SPECIAL, lang), description: makeDesc(ListIds.STYLE_AUTMN_SPECIAL, 'AI picks the best creative direction') },
    { id: ListIds.STYLE_CLEAN_WHITE, title: styleDisplayName(ListIds.STYLE_CLEAN_WHITE, lang), description: makeDesc(ListIds.STYLE_CLEAN_WHITE, 'Pure white background') },
    { id: ListIds.STYLE_STUDIO, title: styleDisplayName(ListIds.STYLE_STUDIO, lang), description: makeDesc(ListIds.STYLE_STUDIO, 'Colored backdrop studio') },
    { id: ListIds.STYLE_LIFESTYLE, title: styleDisplayName(ListIds.STYLE_LIFESTYLE, lang), description: makeDesc(ListIds.STYLE_LIFESTYLE, 'Real-life setting') },
    { id: ListIds.STYLE_OUTDOOR, title: styleDisplayName(ListIds.STYLE_OUTDOOR, lang), description: makeDesc(ListIds.STYLE_OUTDOOR, 'Natural outdoor scene') },
    { id: ListIds.STYLE_GRADIENT, title: styleDisplayName(ListIds.STYLE_GRADIENT, lang), description: makeDesc(ListIds.STYLE_GRADIENT, lang === 'hinglish' ? 'Dramatic dark aur cinematic' : 'Dramatic dark & cinematic') },
    { id: ListIds.STYLE_FESTIVE, title: styleDisplayName(ListIds.STYLE_FESTIVE, lang), description: makeDesc(ListIds.STYLE_FESTIVE, lang === 'hinglish' ? 'Tyohar ka mahaul' : 'Indian festival celebration') },
    { id: ListIds.STYLE_WITH_MODEL, title: styleDisplayName(ListIds.STYLE_WITH_MODEL, lang), description: makeDesc(ListIds.STYLE_WITH_MODEL, 'AI person with product') },
  ].filter(row => !alreadyPicked.includes(row.id));

  // Smart Pack is shown as the first option on step 1 — tapping it picks all 3 at once
  const allStyleRows = isFirstPick
    ? [
        {
          id: ListIds.SMART_PACK,
          title: lang === 'hinglish' ? 'Smart Pack \u2728' : 'Smart Pack \u2728',
          description: lang === 'hinglish'
            ? 'AI aapke product ke liye 3 best styles chunega'
            : 'AI picks the best 3 styles for your product',
        },
        ...individualRows,
      ]
    : individualRows;

  const headerText = lang === 'hinglish'
    ? `Style ${pickNumber} of ${OUTPUT_STYLES_PER_ORDER} chuniye:`
    : `Pick style ${pickNumber} of ${OUTPUT_STYLES_PER_ORDER}:`;

  await wa.sendList(
    phoneNumber,
    headerText,
    lang === 'hinglish' ? 'Chuniye' : 'Choose',
    [{ title: 'Styles', rows: allStyleRows }],
  );
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

const VALID_CATEGORY_IDS = new Set<string>(Object.values(ListIds).filter(id => id.startsWith('cat_')));

/**
 * Fills `existing` styles up to `target` count using the Smart Pack for the
 * given category, then falls back to a default pool. Never repeats a style.
 */
function fillWithSmartPack(existing: string[], category: string | null, target: number): string[] {
  const smartPackMapping: Record<string, string[]> = {
    cat_jewellery: ['style_autmn_special', 'style_gradient', 'style_lifestyle'],
    cat_food: ['style_autmn_special', 'style_lifestyle', 'style_festive'],
    cat_garment: ['style_autmn_special', 'style_lifestyle', 'style_with_model'],
    cat_skincare: ['style_autmn_special', 'style_clean_white', 'style_gradient'],
    cat_candle: ['style_autmn_special', 'style_gradient', 'style_festive'],
    cat_bag: ['style_autmn_special', 'style_lifestyle', 'style_gradient'],
    cat_electronics: ['style_autmn_special', 'style_gradient', 'style_studio'],
  };
  const smartPack = smartPackMapping[category ?? ''] ?? ['style_autmn_special', 'style_lifestyle', 'style_gradient'];

  const result = [...existing];
  const usedSet = new Set(result);

  for (const style of smartPack) {
    if (result.length >= target) break;
    if (!usedSet.has(style)) {
      result.push(style);
      usedSet.add(style);
    }
  }

  // Safety net: if Smart Pack didn't fully cover the gap, pull from a broad pool
  const fullPool = [
    'style_autmn_special', 'style_lifestyle', 'style_gradient',
    'style_outdoor', 'style_studio', 'style_festive', 'style_with_model', 'style_clean_white',
  ];
  for (const style of fullPool) {
    if (result.length >= target) break;
    if (!usedSet.has(style)) {
      result.push(style);
      usedSet.add(style);
    }
  }

  return result.slice(0, target);
}

export { logger };
