/**
 * Payment status polling job.
 *
 * Backup for Razorpay webhook delays — polls payment link status
 * and triggers order processing if payment was captured.
 */

import type { Job } from 'bullmq';
import { prisma } from '@autmn/db';
import { pollPaymentStatus } from '@autmn/payment';
import { WhatsAppClient } from '@autmn/whatsapp';
import { onPaymentConfirmed, onRevisionPaymentConfirmed } from '@autmn/session';
import { getPaymentCheckQueue, PaymentCheckJobDataSchema } from '@autmn/queue';
import { getConfig } from '../config.js';

export async function processPaymentCheck(job: Job): Promise<void> {
  const config = getConfig();
  const data = PaymentCheckJobDataSchema.parse(job.data);

  const log = (msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ job: job.id, orderId: data.orderId, msg, ...extra }));

  log('Checking payment status', { attempt: data.attempt });

  // Check if payment already processed
  const order = await prisma.order.findUnique({ where: { id: data.orderId } });
  if (!order) {
    log('Order not found, skipping');
    return;
  }

  // Determine if this is a revision payment check by comparing link IDs
  const isRevisionPayment = order.razorpayRevisionLinkId === data.paymentLinkId;

  if (!isRevisionPayment && order.status !== 'payment_pending') {
    log('Order no longer pending, skipping', { status: order.status });
    return;
  }

  // Poll Razorpay
  const status = await pollPaymentStatus(data.paymentLinkId);

  if (status.status === 'paid' && status.paymentId) {
    log('Payment confirmed via polling', { isRevisionPayment });

    // Check idempotency
    const existing = await prisma.payment.findUnique({
      where: { razorpayPaymentId: status.paymentId },
    });

    if (!existing) {
      const wa = new WhatsAppClient({
        accessToken: config.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      });

      if (isRevisionPayment) {
        // Record revision payment and trigger edit job
        await prisma.payment.create({
          data: {
            orderId: order.id,
            razorpayPaymentId: status.paymentId,
            razorpayPaymentLinkId: data.paymentLinkId,
            amount: 2900, // Rs 29 revision fee in paise
            status: 'captured',
            capturedAt: new Date(),
          },
        });

        await onRevisionPaymentConfirmed(order.id, wa);
      } else {
        // Create payment record and update order atomically
        await prisma.$transaction([
          prisma.payment.create({
            data: {
              orderId: order.id,
              razorpayPaymentId: status.paymentId,
              razorpayPaymentLinkId: data.paymentLinkId,
              amount: order.amount,
              status: 'captured',
              capturedAt: new Date(),
            },
          }),
          prisma.order.update({
            where: { id: order.id },
            data: {
              status: 'payment_confirmed',
              razorpayPaymentId: status.paymentId,
            },
          }),
        ]);

        await onPaymentConfirmed(order.id, status.paymentId, wa);
      }
    }
    return;
  }

  // Not paid yet — re-enqueue if under max attempts (10 attempts × 30s = 5 min total)
  if (data.attempt < 10) {
    const queue = getPaymentCheckQueue();
    await queue.add(
      'payment-check',
      { ...data, attempt: data.attempt + 1 },
      { delay: 30_000 },
    );
    log('Re-enqueued payment check', { nextAttempt: data.attempt + 1 });
  } else {
    log('Max polling attempts reached, giving up');
  }
}
