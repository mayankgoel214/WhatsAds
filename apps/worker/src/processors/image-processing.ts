/**
 * Image processing job handler.
 *
 * Runs the AI pipeline (primary: Bria Product Shot, fallback: multi-stage)
 * and delivers results via WhatsApp.
 */

import type { Job } from 'bullmq';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { prisma } from '@whatsads/db';
import type { ImageJob } from '@whatsads/db';
import { processProductImage } from '@whatsads/ai';
import { uploadFile, Buckets } from '@whatsads/storage';
import { WhatsAppClient } from '@whatsads/whatsapp';
import { sendProcessedImages } from '@whatsads/session';
import { ImageProcessingJobDataSchema } from '@whatsads/queue';
import { getConfig } from '../config.js';

function getFreshAccessToken(): string {
  try {
    const envPath = resolve(process.cwd(), '.env');
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^WHATSAPP_ACCESS_TOKEN=(.+)$/m);
    if (match?.[1]) return match[1].trim();
  } catch {}
  return getConfig().WHATSAPP_ACCESS_TOKEN;
}

export async function processImageJob(job: Job): Promise<void> {
  const config = getConfig();
  const data = ImageProcessingJobDataSchema.parse(job.data);

  const log = (msg: string, extra?: Record<string, unknown>) => {
    const line = JSON.stringify({ job: job.id, orderId: data.orderId, msg, ...extra });
    console.log(line);
    process.stdout.write(line + '\n');
  };

  log('=== STARTING IMAGE PROCESSING ===', { style: data.style, imageUrl: data.inputImageUrl.slice(0, 80) });

  // Update job status
  await prisma.imageJob.update({
    where: { id: data.imageJobId },
    data: { status: 'processing', startedAt: new Date(), attempts: { increment: 1 } },
  }).catch(() => {}); // Job record might not exist for edits

  try {
    // Run AI pipeline
    const result = await processProductImage({
      imageUrl: data.inputImageUrl,
      style: data.style,
      productCategory: data.productCategory,
      voiceInstructions: data.voiceInstructions,
    });

    log('Pipeline complete', {
      pipeline: result.pipeline,
      qaScore: result.qaScore,
      durationMs: result.durationMs,
      attempts: result.attempts,
    });

    // Use pipeline output URL directly if it's already in Supabase storage
    // (the pipeline uploads internally via uploadToStorage)
    let outputUrl = result.outputUrl;
    if (!outputUrl.includes('supabase.co')) {
      // Only re-upload if it's a temporary URL (fal.ai, data URL, etc.)
      const outputPath = `${data.orderId}/${data.imageJobId}-output.jpg`;
      const outputBuffer = await fetch(outputUrl).then((r) => r.arrayBuffer());
      outputUrl = await uploadFile(
        Buckets.PROCESSED_IMAGES,
        outputPath,
        Buffer.from(outputBuffer),
        'image/jpeg',
      );
    }

    // Use cutout URL directly if already in Supabase, otherwise re-upload
    let cutoutUrl: string | undefined;
    if (result.cutoutUrl && result.cutoutUrl.startsWith('http')) {
      if (result.cutoutUrl.includes('supabase.co')) {
        cutoutUrl = result.cutoutUrl;
      } else try {
        const cutoutPath = `${data.orderId}/${data.imageJobId}-cutout.png`;
        const cutoutBuffer = await fetch(result.cutoutUrl).then((r) => r.arrayBuffer());
        cutoutUrl = await uploadFile(
          Buckets.PROCESSED_IMAGES,
          cutoutPath,
          Buffer.from(cutoutBuffer),
          'image/png',
        );
      } catch {
        // Cutout upload is non-critical — continue without it
        cutoutUrl = result.cutoutUrl;
      }
    }

    // Update job record
    await prisma.imageJob.update({
      where: { id: data.imageJobId },
      data: {
        status: 'completed',
        outputImageUrl: outputUrl,
        cutoutUrl,
        qaScore: result.qaScore,
        qaAttempts: result.attempts,
        pipeline: result.pipeline,
        durationMs: result.durationMs,
        completedAt: new Date(),
      },
    }).catch(() => {});

    // Update order — add output URL
    const order = await prisma.order.findUnique({ where: { id: data.orderId } });
    if (order) {
      await prisma.order.update({
        where: { id: data.orderId },
        data: {
          outputImageUrls: { push: outputUrl },
          cutoutUrls: cutoutUrl ? { push: cutoutUrl } : undefined,
          qaBestScore: result.qaScore > (order.qaBestScore ?? 0) ? result.qaScore : undefined,
        },
      });

      // Check if all images in order are done
      const allJobs = await prisma.imageJob.findMany({
        where: { orderId: data.orderId },
      });

      const allComplete = allJobs.every(
        (j: ImageJob) => j.status === 'completed' || j.status === 'failed',
      );

      if (allComplete) {
        const completedUrls = allJobs
          .filter((j: ImageJob) => j.status === 'completed' && j.outputImageUrl)
          .map((j: ImageJob) => j.outputImageUrl!);

        // Update order status
        await prisma.order.update({
          where: { id: data.orderId },
          data: {
            status: 'completed',
            outputImageUrls: completedUrls,
            processingCompletedAt: new Date(),
          },
        });

        // Send results via WhatsApp
        const user = await prisma.user.findUnique({
          where: { phoneNumber: data.phoneNumber },
        });

        const wa = new WhatsAppClient({
          accessToken: getFreshAccessToken(),
          phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        });

        await sendProcessedImages(
          data.phoneNumber,
          completedUrls,
          (user?.language as 'hi' | 'en') || 'hi',
          user?.name ?? undefined,
          wa,
        );

        // Transition session PROCESSING → DELIVERED
        if (user) {
          await prisma.session.updateMany({
            where: { userId: user.id, state: 'PROCESSING' },
            data: { state: 'DELIVERED', stateEnteredAt: new Date() },
          });
          log('Session transitioned to DELIVERED');
        }

        log('All images delivered', { count: completedUrls.length });
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error('=== IMAGE PROCESSING FAILED ===', errorMsg);
    log('Image processing failed', { error: errorMsg });

    // Update job as failed
    await prisma.imageJob.update({
      where: { id: data.imageJobId },
      data: {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      },
    }).catch(() => {});

    // If all retries exhausted, notify user
    const jobRecord = await prisma.imageJob.findUnique({
      where: { id: data.imageJobId },
    });

    if (jobRecord && jobRecord.attempts >= jobRecord.maxAttempts) {
      const user = await prisma.user.findUnique({
        where: { phoneNumber: data.phoneNumber },
      });
      const lang = (user?.language as 'hi' | 'en') || 'hi';

      const wa = new WhatsAppClient({
        accessToken: getFreshAccessToken(),
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      });

      // Check if ALL jobs in this order are now done (completed or failed)
      const allJobs = await prisma.imageJob.findMany({
        where: { orderId: data.orderId },
      });
      const allDone = allJobs.every(
        (j: ImageJob) => j.status === 'completed' || j.status === 'failed',
      );

      if (allDone) {
        const completedUrls = allJobs
          .filter((j: ImageJob) => j.status === 'completed' && j.outputImageUrl)
          .map((j: ImageJob) => j.outputImageUrl!);

        if (completedUrls.length > 0) {
          // Some images succeeded — deliver those and note the failures
          await sendProcessedImages(data.phoneNumber, completedUrls, lang, user?.name ?? undefined, wa);
        } else {
          // All images failed
          await wa.sendText(
            data.phoneNumber,
            lang === 'hi'
              ? 'Maaf kijiye, aapki photo process nahi ho payi. Kripya dobara try karein.'
              : 'Sorry, we could not process your photo. Please try again.',
          );
        }

        // Transition session out of PROCESSING regardless of outcome
        if (user) {
          await prisma.session.updateMany({
            where: { userId: user.id, state: 'PROCESSING' },
            data: { state: 'DELIVERED', stateEnteredAt: new Date() },
          });
          log('Session transitioned to DELIVERED (after failure recovery)');
        }

        await prisma.order.update({
          where: { id: data.orderId },
          data: { status: completedUrls.length > 0 ? 'completed' : 'failed', processingCompletedAt: new Date() },
        }).catch(() => {});
      }
    }

    throw err; // Let BullMQ handle retries
  }
}
