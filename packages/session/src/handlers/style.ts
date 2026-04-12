/**
 * SETUP_STYLE handler — V3 streamlined flow.
 *
 * After style pick → straight to AWAITING_PHOTO.
 * Instructions merged into photo step (caption).
 */

import type { WhatsAppClient } from '@whatsads/whatsapp';
import type { Session, User } from '@whatsads/db';
import { prisma } from '@whatsads/db';
import { getImageQueue } from '@whatsads/queue';
import { transitionTo } from '../db-helpers.js';
import { styleDisplayName, msgSendPhoto, msgRevisionLimitReached, msgStylePicked, msgAllStylesReady, msgSendProductPhotos } from '../messages.js';
import { ListIds, ButtonIds, FREE_REDOS_PER_IMAGE, OUTPUT_STYLES_PER_ORDER } from '../types.js';
import type { MessageContext } from '../types.js';
import { logger } from '../logger.js';

export async function handleSetupStyle(
  session: Session,
  user: User,
  message: MessageContext,
  wa: WhatsAppClient,
): Promise<void> {
  const lang = (user.language === 'en' ? 'en' : 'hi') as 'hi' | 'en';
  const phoneNumber = session.phoneNumber;

  let styleId: string | null = null;

  // List reply (normal flow)
  if (message.messageType === 'interactive' && message.listReplyId) {
    if (VALID_STYLE_IDS.has(message.listReplyId)) {
      styleId = message.listReplyId;
    }
  }

  // User typed a style name
  if (!styleId && message.messageType === 'text' && message.text) {
    styleId = resolveStyleFromText(message.text.trim().toLowerCase());
  }

  // Returning user: same/new style buttons
  if (!styleId && message.messageType === 'interactive' && message.buttonReplyId) {
    if (message.buttonReplyId === ButtonIds.SAME_STYLE && user.lastStyleUsed) {
      styleId = user.lastStyleUsed;
    }
    if (message.buttonReplyId === ButtonIds.NEW_STYLE) {
      const { sendStyleList } = await import('./onboarding.js');
      await sendStyleList(phoneNumber, lang, wa, user.businessType ?? undefined);
      return;
    }
  }

  // Fallback: buttonReplyId might contain a style ID (some WhatsApp clients send list selections as button replies)
  if (!styleId && message.buttonReplyId) {
    if (VALID_STYLE_IDS.has(message.buttonReplyId)) {
      styleId = message.buttonReplyId;
    }
  }

  if (!styleId) {
    console.warn(JSON.stringify({
      event: 'style_resolution_failed',
      phoneNumber: session.phoneNumber,
      messageType: message.messageType,
      listReplyId: message.listReplyId,
      buttonReplyId: message.buttonReplyId,
      text: message.text,
    }));
    const { sendStyleList } = await import('./onboarding.js');
    const alreadyPicked = (session.styleSelections as string[]) ?? [];
    await sendStyleList(phoneNumber, lang, wa, user.businessType ?? undefined, alreadyPicked);
    return;
  }

  // --- Smart Pack: auto-select 3 styles and go straight to AWAITING_PHOTO ---
  if (styleId === ListIds.SMART_PACK) {
    const smartStyles = resolveSmartPack(user.businessType ?? null);
    logger.info(JSON.stringify({ event: 'smart_pack_selected', category: user.businessType, styles: smartStyles }));

    const styleNames = smartStyles.map(s => styleDisplayName(s, lang));
    await wa.sendText(phoneNumber, msgAllStylesReady(lang, styleNames));

    await transitionTo(phoneNumber, 'AWAITING_PHOTO', {
      styleSelection: smartStyles[0],
      styleSelections: smartStyles,
      stylePickStep: 0,
      imageMediaIds: [],
      imageStorageUrls: [],
      voiceInstructions: null,
      currentOrderId: null,
      earlyPhotoMediaId: null,
    });

    await wa.sendText(phoneNumber, msgSendProductPhotos(lang));
    return;
  }

  const styleName = styleDisplayName(styleId, lang);

  // Check if this is a style-change edit (currentOrderId preserved from edit.ts)
  if (session.currentOrderId) {
    const order = await prisma.order.findUnique({ where: { id: session.currentOrderId } });
    if (order && order.inputImageUrls.length > 0) {
      // Check revision limits: each image gets FREE_REDOS_PER_IMAGE free redo(s).
      // Total free redos for the order = imageCount * FREE_REDOS_PER_IMAGE.
      const totalFreeRedos = order.imageCount * FREE_REDOS_PER_IMAGE;
      if (order.revisionsUsed >= totalFreeRedos) {
        await wa.sendText(phoneNumber, msgRevisionLimitReached(lang, order.imageCount));
        await transitionTo(phoneNumber, 'DELIVERED');
        return;
      }

      // Style-change edit: reuse existing photos, enqueue reprocessing immediately
      await wa.sendText(
        phoneNumber,
        lang === 'hi'
          ? `*${styleName}* mein bana rahe hain — bas thoda wait karein!`
          : `Reprocessing in *${styleName}* — just a moment!`,
      );

      const inputImageUrls = (order.inputImageUrls as string[]) ?? [];
      const cutoutUrls = (order.cutoutUrls as string[]) ?? [];

      // A style-change reprocesses every image — each consumes one free redo,
      // so increment revisionsUsed by the number of images being reprocessed.
      await prisma.order.update({
        where: { id: order.id },
        data: {
          style: styleId,
          revisionsUsed: { increment: inputImageUrls.length },
          status: 'processing',
          processingStartedAt: new Date(),
          processingCompletedAt: null,
        },
      });

      // Create an ImageJob and enqueue a processing job for EVERY image in the order
      const queue = getImageQueue();
      let jobsEnqueued = 0;

      for (let i = 0; i < inputImageUrls.length; i++) {
        const inputUrl = cutoutUrls[i] || inputImageUrls[i] || '';
        if (!inputUrl) continue;

        const editJobId = crypto.randomUUID();
        await prisma.imageJob.create({
          data: {
            id: editJobId,
            orderId: order.id,
            inputImageUrl: inputUrl,
            style: styleId,
            status: 'queued',
          },
        });

        await queue.add('process_image', {
          orderId: order.id,
          imageJobId: editJobId,
          phoneNumber: phoneNumber,
          inputImageUrl: inputUrl,
          style: styleId,
          productCategory: order.productCategory ?? undefined,
          pipeline: cutoutUrls[i] ? 'fallback' : 'primary',
        });

        jobsEnqueued++;
      }

      await transitionTo(phoneNumber, 'EDIT_PROCESSING', {
        styleSelection: styleId,
      });

      logger.info('Style-change edit: reprocessing all images with new style', {
        phoneNumber,
        styleId,
        orderId: order.id,
        jobsEnqueued,
        imageCount: inputImageUrls.length,
      });
      return;
    }
  }

  // --- 3-step style picker flow ---
  const currentPicked = (session.styleSelections as string[]) ?? [];
  const currentStep = typeof session.stylePickStep === 'number' ? session.stylePickStep : 0;
  const updatedSelections = [...currentPicked, styleId];
  const newStep = currentStep + 1;

  logger.info('Style step picked', { phoneNumber, styleId, newStep, total: OUTPUT_STYLES_PER_ORDER });

  if (newStep < OUTPUT_STYLES_PER_ORDER) {
    // More styles to pick — save progress and show next list
    await prisma.session.update({
      where: { phoneNumber },
      data: {
        styleSelections: updatedSelections,
        stylePickStep: newStep,
        // Keep styleSelection as first pick for backward compat
        styleSelection: updatedSelections[0] ?? null,
      },
    });

    await wa.sendText(phoneNumber, msgStylePicked(lang, styleName, newStep));

    const { sendStyleList } = await import('./onboarding.js');
    await sendStyleList(phoneNumber, lang, wa, user.businessType ?? undefined, updatedSelections);
    return;
  }

  // All 3 styles picked — transition to AWAITING_PHOTO
  const styleNames = updatedSelections.map(s => styleDisplayName(s, lang));
  await wa.sendText(phoneNumber, msgAllStylesReady(lang, styleNames));

  await transitionTo(phoneNumber, 'AWAITING_PHOTO', {
    styleSelection: updatedSelections[0],
    styleSelections: updatedSelections,
    stylePickStep: 0,
    imageMediaIds: [],
    imageStorageUrls: [],
    voiceInstructions: null,
    currentOrderId: null,
    earlyPhotoMediaId: null,
  });

  await wa.sendText(phoneNumber, msgSendProductPhotos(lang));

  logger.info('All 3 styles selected, awaiting photo', { phoneNumber, styles: updatedSelections });
}

// ---------------------------------------------------------------------------

// smart_pack is intentionally included so the list reply is accepted;
// it is resolved to 3 concrete styles before being saved to the session.
const VALID_STYLE_IDS = new Set<string>(
  [...Object.values(ListIds).filter(id => id.startsWith('style_')), ListIds.SMART_PACK],
);

/**
 * Resolves Smart Pack to the 3 best concrete styles for the given product category.
 */
function resolveSmartPack(category: string | null): string[] {
  const mapping: Record<string, string[]> = {
    cat_jewellery: ['style_gradient', 'style_lifestyle', 'style_clean_white'],
    cat_food: ['style_lifestyle', 'style_outdoor', 'style_studio'],
    cat_garment: ['style_lifestyle', 'style_with_model', 'style_clean_white'],
    cat_skincare: ['style_clean_white', 'style_lifestyle', 'style_gradient'],
    cat_candle: ['style_lifestyle', 'style_festive', 'style_gradient'],
    cat_bag: ['style_lifestyle', 'style_outdoor', 'style_studio'],
  };
  return mapping[category ?? ''] ?? ['style_lifestyle', 'style_studio', 'style_gradient'];
}

function resolveStyleFromText(text: string): string | null {
  if (text.includes('white') || text.includes('safed') || text.includes('clean')) return ListIds.STYLE_CLEAN_WHITE;
  if (text.includes('lifestyle') || text.includes('life')) return ListIds.STYLE_LIFESTYLE;
  if (text.includes('gradient') || text.includes('color') || text.includes('colour')) return ListIds.STYLE_GRADIENT;
  if (text.includes('outdoor') || text.includes('bahar') || text.includes('nature')) return ListIds.STYLE_OUTDOOR;
  if (text.includes('studio') || text.includes('professional')) return ListIds.STYLE_STUDIO;
  if (text.includes('festive') || text.includes('tyohar') || text.includes('festival')) return ListIds.STYLE_FESTIVE;
  if (text.includes('minimal') || text.includes('simple')) return 'style_minimal';
  if (text.includes('model') || text.includes('person') || text.includes('human')) return ListIds.STYLE_WITH_MODEL;
  return null;
}
