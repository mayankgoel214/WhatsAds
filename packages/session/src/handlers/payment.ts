/**
 * AWAITING_PAYMENT handler — V2 streamlined flow.
 *
 * - Creates a Razorpay Payment Link (amount from DB order — never client-supplied).
 * - Sends the link via WhatsApp CTA button.
 * - Enqueues a PaymentCheck delayed job (2 min) as webhook backup.
 * - onPaymentConfirmed() is called by the Razorpay webhook when payment.captured fires.
 * - enqueueImageJobs() is shared with free-trial path (called by instructions.ts).
 */

import type { WhatsAppClient } from '@whatsads/whatsapp';
import { prisma } from '@whatsads/db';
import type { Session, User, Order } from '@whatsads/db';
import { createPaymentLink } from '@whatsads/payment';
import { getPaymentCheckQueue, getImageQueue, getSessionTimeoutQueue } from '@whatsads/queue';
import { transitionTo } from '../db-helpers.js';
import {
  msgPaymentPending,
  msgPaymentConfirmed,
  msgGenericError,
} from '../messages.js';
import { PAYMENT_CHECK_DELAY_MS, ButtonIds } from '../types.js';
import type { MessageContext } from '../types.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleAwaitingPayment(
  session: Session,
  user: User,
  message: MessageContext,
  wa: WhatsAppClient,
): Promise<void> {
  const lang = (user.language === 'en' ? 'en' : 'hi') as 'hi' | 'en';
  const phoneNumber = session.phoneNumber;

  // ---- Internal trigger: send the payment link ----
  if (message.buttonReplyId === '__send_payment_link') {
    await sendPaymentLink(session, user, wa);
    return;
  }

  // ---- User tapped "Resend Link" ----
  if (message.buttonReplyId === 'resend_link') {
    await sendPaymentLink(session, user, wa);
    return;
  }

  // ---- User tapped "Cancel Order" ----
  if (message.buttonReplyId === ButtonIds.CANCEL_ORDER || message.buttonReplyId === 'cancel_order') {
    await transitionTo(phoneNumber, 'IDLE', { currentOrderId: null });
    await wa.sendText(
      phoneNumber,
      lang === 'hi'
        ? 'Order cancel ho gaya. Jab bhi ready hon, wapas aa jaana!'
        : 'Order cancelled. Come back whenever you are ready!',
    );
    return;
  }

  // ---- User messaged while payment is pending → remind ----
  await wa.sendButtons(
    phoneNumber,
    msgPaymentPending(lang),
    [
      { id: 'resend_link', title: lang === 'hi' ? 'Link dobara bhejo' : 'Resend Link' },
      { id: ButtonIds.CANCEL_ORDER, title: lang === 'hi' ? 'Cancel' : 'Cancel' },
    ],
  );
}

// ---------------------------------------------------------------------------
// Called by the Razorpay webhook handler when payment.captured fires
// ---------------------------------------------------------------------------

export async function onPaymentConfirmed(
  orderId: string,
  razorpayPaymentId: string,
  wa: WhatsAppClient,
): Promise<void> {
  // Idempotency guard — optimistic lock via updateMany so only one concurrent
  // caller (Razorpay webhook or payment-check poller) proceeds. The second
  // caller will see count === 0 and bail out safely.
  const guard = await prisma.order.updateMany({
    where: {
      id: orderId,
      status: { in: ['payment_pending', 'created'] },
    },
    data: { status: 'payment_confirmed', razorpayPaymentId },
  });

  if (guard.count === 0) {
    logger.info(JSON.stringify({ event: 'payment_already_confirmed', orderId }));
    return;
  }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    logger.error('onPaymentConfirmed: order not found after guard update', { orderId });
    return;
  }

  const phoneNumber = order.phoneNumber;
  const user = await prisma.user.findUnique({ where: { phoneNumber } });
  if (!user) {
    logger.error('onPaymentConfirmed: user not found', { phoneNumber });
    return;
  }

  const lang = (user.language === 'en' ? 'en' : 'hi') as 'hi' | 'en';

  try {
    // Status already set to payment_confirmed by the idempotency guard above.
    // Transition session state to PROCESSING.
    await transitionTo(phoneNumber, 'PROCESSING', {
      currentOrderId: order.id,
    });

    await wa.sendText(phoneNumber, msgPaymentConfirmed(lang));

    try {
      await enqueueImageJobs(orderId, phoneNumber, order);
    } catch (enqueueErr) {
      console.error(JSON.stringify({
        event: 'enqueue_after_payment_failed',
        orderId: order.id,
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      }));

      // Reset session so user can see their order history and retry
      await transitionTo(phoneNumber, 'DELIVERED', {
        currentOrderId: order.id,
      });

      await wa.sendText(phoneNumber, lang === 'hi'
        ? 'Kuch problem aayi. Kripya "hi" bhejein aur dobara try karein. Aapka payment safe hai.'
        : 'Something went wrong. Please send "hi" and try again. Your payment is safe.');

      return;
    }

    // Schedule a proactive delay notification at 90 seconds.
    // If the session is still in PROCESSING when it fires, sends msgProcessingDelay.
    try {
      const timeoutQueue = getSessionTimeoutQueue();
      await timeoutQueue.add(
        'session-timeout',
        {
          phoneNumber,
          expectedState: 'PROCESSING',
          action: 'nudge',
        },
        { delay: 90_000, jobId: `processing_nudge_${phoneNumber}_${Date.now()}` },
      );
    } catch (nudgeErr) {
      logger.warn('Failed to schedule processing nudge job', {
        phoneNumber,
        error: nudgeErr instanceof Error ? nudgeErr.message : String(nudgeErr),
      });
    }
  } catch (err) {
    logger.error('onPaymentConfirmed failed', {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    await wa.sendText(phoneNumber, msgGenericError(lang));
  }
}

// ---------------------------------------------------------------------------
// Enqueue image processing jobs (shared: used by payment confirmation + free trial)
// ---------------------------------------------------------------------------

export async function enqueueImageJobs(
  orderId: string,
  phoneNumber: string,
  order: Order,
): Promise<void> {
  const imageQueue = getImageQueue();
  const inputImageUrls = order.inputImageUrls as string[];
  const voiceInstructions = order.voiceInstructions as string | null;

  // V2 model: 1 job per OUTPUT STYLE (always OUTPUT_STYLES_PER_ORDER = 3).
  // Each job uses the primary input photo and one of the 3 ordered styles.
  // Fall back to the legacy single-style path for old orders where stylesOrdered is empty.
  const stylesOrdered = (order.stylesOrdered as string[]) ?? [];
  const primaryInputImageUrl = inputImageUrls[0] ?? '';

  const styleJobs: Array<{ styleId: string; styleIndex: number }> =
    stylesOrdered.length > 0
      ? stylesOrdered.map((styleId, i) => ({ styleId, styleIndex: i }))
      : [{ styleId: order.style ?? 'style_clean_white', styleIndex: 0 }]; // legacy single-job path

  console.info(JSON.stringify({
    event: 'enqueue_image_jobs_start',
    orderId,
    inputPhotoCount: inputImageUrls.length,
    outputJobCount: styleJobs.length,
    styles: styleJobs.map(j => j.styleId),
    hasInstructions: !!voiceInstructions,
  }));

  for (const { styleId, styleIndex } of styleJobs) {
    const imageJob = await prisma.imageJob.create({
      data: {
        orderId,
        inputImageUrl: primaryInputImageUrl,
        style: styleId,
        styleIndex,
        pipeline: 'primary',
        status: 'queued',
      },
    });

    await imageQueue.add('process_image', {
      orderId,
      imageJobId: imageJob.id,
      phoneNumber,
      inputImageUrl: primaryInputImageUrl,
      style: styleId,
      voiceInstructions: order.voiceInstructions ?? undefined,
      productCategory: order.productCategory ?? undefined,
      pipeline: 'primary',
    });
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'processing', processingStartedAt: new Date() },
  });

  logger.info('Image processing jobs enqueued', {
    orderId,
    outputJobCount: styleJobs.length,
    styles: styleJobs.map(j => j.styleId),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function sendPaymentLink(
  session: Session,
  user: User,
  wa: WhatsAppClient,
): Promise<void> {
  const lang = (user.language === 'en' ? 'en' : 'hi') as 'hi' | 'en';
  const phoneNumber = session.phoneNumber;

  if (!session.currentOrderId) {
    logger.error('sendPaymentLink: no currentOrderId on session', { phoneNumber });
    await wa.sendText(phoneNumber, msgGenericError(lang));
    return;
  }

  const order = await prisma.order.findUnique({ where: { id: session.currentOrderId } });
  if (!order) {
    logger.error('sendPaymentLink: order not found', { orderId: session.currentOrderId });
    await wa.sendText(phoneNumber, msgGenericError(lang));
    return;
  }

  // Check if existing link might be expired (created more than 25 minutes ago)
  const linkAge = order.createdAt ? Date.now() - new Date(order.createdAt).getTime() : Infinity;
  const LINK_EXPIRY_BUFFER = 25 * 60 * 1000; // 25 minutes (links expire at 30)

  if (order.razorpayPaymentLinkUrl && linkAge < LINK_EXPIRY_BUFFER) {
    // Reuse existing link
    await wa.sendPaymentLink(
      phoneNumber,
      lang === 'hi'
        ? `${order.imageCount} photo • 3 professional ads • Rs ${order.amount / 100}\nPayment karein:`
        : `${order.imageCount} photo(s) • 3 professional ads • Rs ${order.amount / 100}\nPay to get started:`,
      order.razorpayPaymentLinkUrl,
      lang === 'hi' ? 'Payment karo' : 'Pay Now',
    );
    return;
  }

  // Create new link (existing link expired or doesn't exist)

  // DEV MODE: skip payment and auto-confirm
  if (process.env.PAYMENT_BYPASS === 'true') {
    logger.info('DEV MODE: Skipping payment, auto-confirming order', { phoneNumber, orderId: order.id });
    await onPaymentConfirmed(order.id, 'dev_payment_' + Date.now(), wa);
    return;
  }

  try {
    const link = await createPaymentLink({
      orderId: order.id,
      customerPhone: phoneNumber,
      customerName: user.name ?? undefined,
      amount: order.amount, // paise — always from DB, never client-provided
      description: `Clickkar - ${order.imageCount} photo(s), 3 ads`,
      expiresInMinutes: 30,
    });

    await prisma.order.update({
      where: { id: order.id },
      data: {
        razorpayPaymentLinkId: link.id,
        razorpayPaymentLinkUrl: link.shortUrl,
        status: 'payment_pending',
      },
    });

    await wa.sendPaymentLink(
      phoneNumber,
      lang === 'hi'
        ? `${order.imageCount} photo • 3 professional ads • Rs ${order.amount / 100}\nPayment karein:`
        : `${order.imageCount} photo(s) • 3 professional ads • Rs ${order.amount / 100}\nPay to get started:`,
      link.shortUrl,
      lang === 'hi' ? 'Payment karo' : 'Pay Now',
    );

    await schedulePaymentCheck(order.id, phoneNumber, link.id);

    logger.info('Payment link sent', { phoneNumber, orderId: order.id, linkId: link.id });
  } catch (err) {
    logger.error('createPaymentLink failed', {
      phoneNumber,
      orderId: order.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await wa.sendText(phoneNumber, msgGenericError(lang));
  }
}

async function schedulePaymentCheck(
  orderId: string,
  phoneNumber: string,
  paymentLinkId: string,
): Promise<void> {
  try {
    const queue = getPaymentCheckQueue();
    await queue.add(
      'check_payment',
      { orderId, phoneNumber, paymentLinkId, attempt: 0 },
      {
        delay: PAYMENT_CHECK_DELAY_MS,
        jobId: `payment_check_${orderId}`,
        attempts: 5,
      },
    );
  } catch (err) {
    logger.warn('Failed to schedule payment check job', {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Called when a revision payment (Rs 29) is confirmed via webhook or polling
// ---------------------------------------------------------------------------

export async function onRevisionPaymentConfirmed(
  orderId: string,
  wa: WhatsAppClient,
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    logger.error('onRevisionPaymentConfirmed: order not found', { orderId });
    return;
  }

  const phoneNumber = order.phoneNumber;

  const session = await prisma.session.findUnique({ where: { phoneNumber } });
  // ALWAYS process the edit — user paid Rs 29. Do not gate on session state.
  if (session && session.state !== 'AWAITING_REVISION_PAYMENT') {
    logger.warn('onRevisionPaymentConfirmed: session state mismatch — processing edit anyway', {
      phoneNumber,
      state: session.state,
    });
  }

  const user = await prisma.user.findUnique({ where: { phoneNumber } });
  if (!user) {
    logger.error('onRevisionPaymentConfirmed: user not found', { phoneNumber });
    return;
  }

  const lang = (user.language === 'en' ? 'en' : 'hi') as 'hi' | 'en';

  try {
    // Increment revision count
    await prisma.order.update({
      where: { id: orderId },
      data: { revisionsUsed: { increment: 1 }, status: 'processing', processingStartedAt: new Date(), processingCompletedAt: null },
    });

    // Use pending edit info stored in session at time of payment request
    const editStyle = (session as any).pendingEditStyle ?? order.style ?? 'style_clean_white';
    const editInstructions = (session as any).pendingEditInstructions ?? null;

    const inputImageUrls = order.inputImageUrls as string[];
    const cutoutUrls = order.cutoutUrls as string[];
    const lastIdx = Math.max(0, inputImageUrls.length - 1);
    const editImageUrl = cutoutUrls[lastIdx] || inputImageUrls[lastIdx] || inputImageUrls[0] || '';

    const imageJob = await prisma.imageJob.create({
      data: {
        orderId,
        inputImageUrl: editImageUrl,
        style: editStyle,
        pipeline: cutoutUrls[lastIdx] ? 'fallback' : 'primary',
        status: 'queued',
      },
    });

    const imageQueue = getImageQueue();
    await imageQueue.add('process_image', {
      orderId,
      imageJobId: imageJob.id,
      phoneNumber,
      inputImageUrl: editImageUrl,
      style: editStyle,
      voiceInstructions: editInstructions ?? undefined,
      productCategory: order.productCategory ?? undefined,
      pipeline: cutoutUrls[lastIdx] ? 'fallback' : 'primary',
    });

    // Transition to EDIT_PROCESSING and clear pending edit fields
    await transitionTo(phoneNumber, 'EDIT_PROCESSING', {
      pendingEditStyle: null,
      pendingEditInstructions: null,
    });

    await wa.sendText(
      phoneNumber,
      lang === 'hi'
        ? 'Payment mil gaya! Aapka edit process ho raha hai...'
        : 'Payment received! Processing your edit...',
    );

    console.info(JSON.stringify({
      event: 'revision_payment_confirmed',
      orderId,
      phoneNumber,
      editStyle,
      hasInstructions: !!editInstructions,
    }));
  } catch (err) {
    logger.error('onRevisionPaymentConfirmed failed', {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    await wa.sendText(phoneNumber, lang === 'hi'
      ? 'Kuch gadbad ho gayi. Thodi der mein dobara koshish karein.'
      : 'Something went wrong. Please try again in a moment.');
  }
}
