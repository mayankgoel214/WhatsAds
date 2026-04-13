/**
 * AWAITING_EDIT and EDIT_PROCESSING handlers.
 *
 * Handles edit requests after image delivery:
 * - Background change (reuses stored cutout — fast, $0.003)
 * - Brightness/lighting adjustment
 * - Full style change
 * - Custom voice/text instruction
 *
 * Checks revision limits (2 free per order, Rs 29 after).
 */

import type { WhatsAppClient } from '@whatsads/whatsapp';
import { prisma } from '@whatsads/db';
import type { Session, User } from '@whatsads/db';
import { getImageQueue, getPaymentCheckQueue } from '@whatsads/queue';
import { downloadMedia } from '@whatsads/whatsapp';
import { uploadFile, Buckets } from '@whatsads/storage';
import { transcribeVoiceNote } from '@whatsads/ai';
import { parseEditInstructions } from '@whatsads/ai';
import { createPaymentLink } from '@whatsads/payment';
import { transitionTo } from '../db-helpers.js';
import {
  msgEditProcessing,
  msgRevisionLimitReached,
  msgGenericError,
} from '../messages.js';
import {
  FREE_REDOS_PER_STYLE,
  OUTPUT_STYLES_PER_ORDER,
  EDIT_REVISION_PAISE,
  PAYMENT_CHECK_DELAY_MS,
} from '../types.js';
import type { MessageContext } from '../types.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// AWAITING_EDIT — user picked an edit option or sent free-form instructions
// ---------------------------------------------------------------------------

export async function handleAwaitingEdit(
  session: Session,
  user: User,
  message: MessageContext,
  wa: WhatsAppClient,
): Promise<void> {
  const lang = (user.language as 'hi' | 'en') || 'hi';

  if (!session.currentOrderId) {
    logger.error('No current order in AWAITING_EDIT', { phoneNumber: session.phoneNumber });
    await wa.sendText(session.phoneNumber, msgGenericError(lang));
    await transitionTo(session.phoneNumber, 'IDLE');
    return;
  }

  const order = await prisma.order.findUnique({ where: { id: session.currentOrderId } });
  if (!order) {
    await wa.sendText(session.phoneNumber, msgGenericError(lang));
    await transitionTo(session.phoneNumber, 'IDLE');
    return;
  }

  let editStyle: string | null = null;
  let editInstructions: string | null = null;

  // Handle list/button replies for edit type
  if (message.messageType === 'interactive') {
    const replyId = message.buttonReplyId || message.listReplyId;

    switch (replyId) {
      case 'edit_background':
        editInstructions = 'Change the background to something completely different while keeping the product exactly the same. Make the new background complement the product.';
        break;

      case 'edit_style':
        // Show style selection — keep currentOrderId so style.ts knows to reprocess
        await transitionTo(session.phoneNumber, 'SETUP_STYLE', {
          // Keep currentOrderId — signals style.ts this is a style-change edit
          voiceInstructions: null,
        });
        {
          const { sendStyleList } = await import('./onboarding.js');
          await sendStyleList(session.phoneNumber, lang, wa, user.businessType ?? undefined);
        }
        return;

      case 'edit_lighting':
        editInstructions = 'Make it brighter with better lighting';
        break;

      case 'edit_crop':
        editInstructions = 'Zoom in on the product, make it larger in frame';
        break;

      case 'edit_other':
        // Ask user to send text/voice — stay in DELIVERED, next text/voice will route back here
        await wa.sendText(
          session.phoneNumber,
          lang === 'hi'
            ? 'Batao kya chahiye — text ya voice note mein.'
            : 'Send text or voice note with what you want.',
        );
        return;

      default:
        if (replyId && replyId.startsWith('style_')) {
          editStyle = replyId.replace('style_', '');
        }
    }
  }

  // Handle voice note edit instructions
  if (message.messageType === 'audio' && message.mediaId) {
    try {
      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? process.env['WHATSAPP_ACCESS_TOKEN'] ?? '';
      if (!accessToken) {
        console.error(JSON.stringify({ event: 'missing_whatsapp_access_token' }));
        throw new Error('WHATSAPP_ACCESS_TOKEN is not configured');
      }
      const { buffer, mimeType } = await downloadMedia(message.mediaId, accessToken);

      const storagePath = `${session.phoneNumber}/${Date.now()}-edit.ogg`;
      await uploadFile(Buckets.VOICE_NOTES, storagePath, buffer, mimeType);

      const transcription = await transcribeVoiceNote(buffer, mimeType);
      if (transcription.text) {
        const parsed = await parseEditInstructions(transcription.text);
        editInstructions = transcription.text.slice(0, 500);
        if (parsed.backgroundStyle) {
          editStyle = parsed.backgroundStyle;
        }
      }
    } catch (err) {
      logger.error('Failed to process edit voice note', { error: String(err), phoneNumber: session.phoneNumber });
    }
  }

  // Handle text edit instructions
  if (message.messageType === 'text' && message.text) {
    try {
      const parsed = await parseEditInstructions(message.text);
      editInstructions = message.text.slice(0, 500);
      if (parsed.backgroundStyle) {
        editStyle = parsed.backgroundStyle;
      }
    } catch {
      editInstructions = message.text.slice(0, 500);
    }
  }

  // Check revision limits: each image gets FREE_REDOS_PER_IMAGE free redo(s).
  // Total free redos for the order = imageCount * FREE_REDOS_PER_IMAGE.
  // We check AFTER parsing the intent so we can store the pending edit in session
  // if the user needs to pay Rs 29 for an additional edit.
  const totalFreeRedos = (order.outputStyleCount || (order.stylesOrdered as string[]).length || OUTPUT_STYLES_PER_ORDER) * FREE_REDOS_PER_STYLE;
  if (order.revisionsUsed >= totalFreeRedos) {
    try {
      const revisionRef = `${order.id}-rev-${order.revisionsUsed + 1}`;
      const link = await createPaymentLink({
        orderId: revisionRef,
        customerPhone: session.phoneNumber.replace(/^\+/, ''),
        customerName: user.name ?? undefined,
        amount: EDIT_REVISION_PAISE,
        description: `Clickkar Edit - Order ${order.id.slice(0, 8)}`,
        expiresInMinutes: 30,
      });

      await prisma.order.update({
        where: { id: order.id },
        data: {
          razorpayRevisionLinkId: link.id,
          razorpayRevisionLinkUrl: link.shortUrl,
        },
      });

      await transitionTo(session.phoneNumber, 'AWAITING_REVISION_PAYMENT', {
        pendingEditStyle: editStyle ?? session.styleSelection,
        pendingEditInstructions: editInstructions,
        currentOrderId: order.id,
      });

      const payMsg = lang === 'hi'
        ? `Aapke free edits khatam ho gaye. Ek aur edit ke liye Rs 29 pay karein:\n${link.shortUrl}`
        : `You've used your free edits. Pay Rs 29 for another edit:\n${link.shortUrl}`;
      await wa.sendText(session.phoneNumber, payMsg);

      const paymentQueue = getPaymentCheckQueue();
      await paymentQueue.add(
        'check_payment',
        {
          orderId: order.id,
          phoneNumber: session.phoneNumber,
          paymentLinkId: link.id,
          attempt: 0,
        },
        {
          delay: PAYMENT_CHECK_DELAY_MS,
          jobId: `revision_check_${order.id}_${order.revisionsUsed + 1}`,
        },
      );
    } catch (err) {
      console.error(JSON.stringify({ event: 'revision_payment_link_failed', error: String(err) }));
      await wa.sendText(session.phoneNumber, msgRevisionLimitReached(lang, order.imageCount));
      await transitionTo(session.phoneNumber, 'DELIVERED');
    }
    return;
  }

  // If we have something to work with, enqueue the edit job
  if (editStyle || editInstructions) {
    const imageUrls = (order.inputImageUrls as string[]) ?? [];

    // Multi-photo edit: parse per-photo instructions when there are multiple photos
    if (imageUrls.length > 1 && editInstructions) {
      try {
        const { parsePerPhotoInstructions } = await import('@whatsads/ai');
        const parseResult = await parsePerPhotoInstructions({
          imageUrls,
          rawInstructions: editInstructions,
        });

        if (parseResult.confidence >= 0.25) {
          const cutoutUrls = (order.cutoutUrls as string[]) ?? [];
          let jobsCreated = 0;

          // Set order to processing before starting any edit jobs
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'processing', processingStartedAt: new Date() },
          });

          // When confidence is low but assignments exist, fall back to global instruction for all photos
          const useGlobalFallback =
            parseResult.confidence < 0.4 &&
            Object.keys(parseResult.assignments).length > 0;

          for (let i = 0; i < imageUrls.length; i++) {
            const instruction = useGlobalFallback
              ? parseResult.globalInstruction
              : (parseResult.assignments[String(i)] ?? parseResult.globalInstruction);
            if (!instruction) continue;

            const editUrl = cutoutUrls[i] || imageUrls[i] || '';
            if (!editUrl) continue;

            const imageJob = await prisma.imageJob.create({
              data: {
                id: crypto.randomUUID(),
                orderId: order.id,
                inputImageUrl: editUrl,
                style: editStyle || order.style || 'style_clean_white',
                status: 'queued',
              },
            });

            const imageQueue = getImageQueue();
            await imageQueue.add('process_image', {
              orderId: order.id,
              imageJobId: imageJob.id,
              phoneNumber: session.phoneNumber,
              inputImageUrl: editUrl,
              style: editStyle || order.style || 'style_clean_white',
              voiceInstructions: instruction,
              productCategory: order.productCategory ?? undefined,
              pipeline: cutoutUrls[i] ? 'fallback' : 'primary',
            });

            jobsCreated++;
          }

          if (jobsCreated > 0) {
            // Each image processed consumes one free redo — increment by jobsCreated
            await prisma.order.update({
              where: { id: order.id },
              data: { revisionsUsed: { increment: jobsCreated } },
            });
            await transitionTo(session.phoneNumber, 'EDIT_PROCESSING');
            await wa.sendText(session.phoneNumber, lang === 'hi'
              ? `${jobsCreated} photos edit ho rahe hain... thodi der mein ready!`
              : `Editing ${jobsCreated} photos... ready shortly!`);
            return;
          }
        }
      } catch (err) {
        console.warn(JSON.stringify({
          event: 'edit_per_photo_parse_failed',
          error: err instanceof Error ? err.message : String(err),
        }));
        // Fall through to single-photo edit (existing behavior)
      }
    }

    // Single-photo edit (fallback or single-photo order)
    await wa.sendText(session.phoneNumber, msgEditProcessing(lang));

    // Increment revision count and reset order status to 'processing'
    // so the worker's delivery logic (which checks for 'processing' status) works
    await prisma.order.update({
      where: { id: order.id },
      data: {
        revisionsUsed: { increment: 1 },
        status: 'processing',
        processingStartedAt: new Date(),
        processingCompletedAt: null,
      },
    });

    // Pick the most recently processed photo (last index) instead of always the first
    const lastIdx = Math.max(0, imageUrls.length - 1);
    const editImageUrl = (order.cutoutUrls as string[])?.[lastIdx] || imageUrls[lastIdx] || imageUrls[0] || '';

    // Create ImageJob record for the edit
    const editJobId = crypto.randomUUID();
    await prisma.imageJob.create({
      data: {
        id: editJobId,
        orderId: order.id,
        inputImageUrl: editImageUrl,
        style: editStyle || order.style || 'style_clean_white',
        status: 'queued',
      },
    });

    // Enqueue re-processing job
    const queue = getImageQueue();
    await queue.add('process_image', {
      orderId: order.id,
      imageJobId: editJobId,
      phoneNumber: session.phoneNumber,
      inputImageUrl: editImageUrl,
      style: editStyle || order.style || 'style_clean_white',
      voiceInstructions: editInstructions ?? undefined,
      productCategory: order.productCategory ?? undefined,
      pipeline: (order.cutoutUrls as string[])?.[lastIdx] ? 'fallback' : 'primary',
    });

    await transitionTo(session.phoneNumber, 'EDIT_PROCESSING');
    return;
  }

  // No actionable instruction — ask again
  await wa.sendText(
    session.phoneNumber,
    lang === 'hi'
      ? 'Kya badlana hai? Background, roshni, ya kuch aur — batayein.'
      : 'What would you like to change? Background, lighting, or something else?',
  );
}

// ---------------------------------------------------------------------------
// EDIT_PROCESSING — image is being re-processed
// ---------------------------------------------------------------------------

export async function handleEditProcessing(
  session: Session,
  user: User,
  message: MessageContext,
  wa: WhatsAppClient,
): Promise<void> {
  const lang = (user.language as 'hi' | 'en') || 'hi';

  // User sent a message while edit is processing — acknowledge
  await wa.sendText(
    session.phoneNumber,
    lang === 'hi'
      ? 'Aapka edit ho raha hai — bas thoda sa wait karein!'
      : 'Your edit is being processed — just a moment!',
  );
}
