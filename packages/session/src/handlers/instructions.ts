/**
 * Shared utility functions for order creation and media handling.
 * Used by images.ts (AWAITING_PHOTO handler).
 */

import type { WhatsAppClient } from '@autmn/whatsapp';
import { downloadMedia } from '@autmn/whatsapp';
import type { Session, User } from '@autmn/db';
import { prisma } from '@autmn/db';
import { transitionTo } from '../db-helpers.js';
// (message helpers imported as needed)
import { PRICE_PER_ORDER_PAISE, OUTPUT_STYLES_PER_ORDER, ButtonIds } from '../types.js';
import type { Language } from '../types.js';
import { sendPaymentLink, enqueueImageJobs } from './payment.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Download media from WhatsApp
// ---------------------------------------------------------------------------

export async function downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const accessToken = process.env['WHATSAPP_ACCESS_TOKEN'] ?? '';
  if (!accessToken || accessToken === 'placeholder') {
    console.error(JSON.stringify({ event: 'missing_whatsapp_access_token' }));
    throw new Error('WHATSAPP_ACCESS_TOKEN is not configured');
  }

  const DOWNLOAD_TIMEOUT_MS = 20_000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Photo download timed out after 20s')), DOWNLOAD_TIMEOUT_MS)
  );

  return Promise.race([
    downloadMedia(mediaId, accessToken),
    timeoutPromise,
  ]);
}

export function mimeToExt(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('webp')) return '.webp';
  return '.jpg';
}

// ---------------------------------------------------------------------------
// Create order and send payment / start processing
// ---------------------------------------------------------------------------

export interface CreateOrderParams {
  session: Session;
  user: User;
  lang: Language;
  wa: WhatsAppClient;
  imageStorageUrls: string[];
  imageMediaIds: string[];
  imageCount: number;
  /** All 3 styles selected for this order */
  styleSelections: string[];
  voiceInstructions: string | null;
}

export async function createOrderAndSendPayment(params: CreateOrderParams): Promise<void> {
  const { session, user, lang, wa, imageStorageUrls, imageMediaIds, imageCount, styleSelections, voiceInstructions } = params;
  const phoneNumber = session.phoneNumber;

  // V2 model: fixed Rs 199 per order regardless of photo count, always 3 style outputs.
  // Ensure we always have OUTPUT_STYLES_PER_ORDER entries — fill from defaults without repeating.
  const normalizedStyles =
    styleSelections.length >= OUTPUT_STYLES_PER_ORDER
      ? styleSelections.slice(0, OUTPUT_STYLES_PER_ORDER)
      : fillStylesFromDefaults(styleSelections, OUTPUT_STYLES_PER_ORDER);

  const primaryStyleId = normalizedStyles[0] ?? 'style_clean_white';
  const isFreeOrder = user.orderCount === 0;
  const amount = isFreeOrder ? 0 : PRICE_PER_ORDER_PAISE;

  // Create order
  const order = await prisma.order.create({
    data: {
      phoneNumber,
      imageCount,
      style: primaryStyleId,              // backward compat — first style
      stylesOrdered: normalizedStyles,    // all 3 styles
      outputStyleCount: OUTPUT_STYLES_PER_ORDER,
      voiceInstructions,
      inputImageUrls: imageStorageUrls,
      status: 'payment_pending',
      amount,
      productCategory: user.businessType ?? 'general',
      userId: user.id,
    },
  });

  if (isFreeOrder) {
    // Free order — skip payment, set to processing BEFORE enqueuing
    // (worker checks status: 'processing' for delivery — must be set first)
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'processing', processingStartedAt: new Date() },
    });

    await transitionTo(phoneNumber, 'PROCESSING', {
      currentOrderId: order.id,
      styleSelection: primaryStyleId,
    });

    // Note: msgProcessingNow confirmation removed — user already received "X photos received ✅"
    // from the debounce buttons flow. Sending again would be a duplicate confirmation.

    // Enqueue image jobs using the canonical enqueueImageJobs from payment.ts.
    // Order status is already set to 'processing' above; the canonical function
    // will perform an idempotent update back to 'processing', which is harmless.
    await enqueueImageJobs(order.id, phoneNumber, order);
  } else {
    // Paid order — go directly to payment link.
    // User already received "X photos received ✅" from the debounce buttons flow,
    // so the msgPhotoReceivedWithPayment confirmation is intentionally omitted here
    // to avoid a duplicate message. The payment link itself shows the amount.
    const updatedSession = await transitionTo(phoneNumber, 'AWAITING_PAYMENT', {
      currentOrderId: order.id,
      styleSelection: primaryStyleId,
    });

    await sendPaymentLink(updatedSession, user, wa);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safety-net padding for normalizedStyles in createOrderAndSendPayment.
 * Fills `existing` up to `target` with styles from a default pool, never repeating.
 * This should rarely trigger now that onboarding.ts always passes 3 styles via
 * fillWithSmartPack, but it prevents the old repeat-first-style bug if it ever does.
 */
function fillStylesFromDefaults(existing: string[], target: number): string[] {
  const defaults = [
    'style_autmn_special', 'style_lifestyle', 'style_gradient',
    'style_outdoor', 'style_studio', 'style_festive', 'style_with_model', 'style_clean_white',
  ];
  const result = [...existing];
  const used = new Set(result);
  for (const s of defaults) {
    if (result.length >= target) break;
    if (!used.has(s)) {
      result.push(s);
      used.add(s);
    }
  }
  return result.slice(0, target);
}

