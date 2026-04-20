/**
 * Image processing job handler.
 *
 * Runs the AI pipeline (primary: Bria Product Shot, fallback: multi-stage)
 * and delivers results via WhatsApp.
 */

import type { Job } from 'bullmq';
import { prisma } from '@autmn/db';
import type { ImageJob } from '@autmn/db';
import { processImageNeverFail, downloadBuffer, type NeverFailResult } from '@autmn/ai';
import { uploadFile, Buckets } from '@autmn/storage';
import { WhatsAppClient } from '@autmn/whatsapp';
import { sendProcessedImages, msgGotPhotoCreating, msgProgressAlmostDone, msgProgressReadyToSend, msgPhotoProcessingFailed } from '@autmn/session';
import type { Language } from '@autmn/session';
import { ImageProcessingJobDataSchema } from '@autmn/queue';
import { getConfig, type WorkerConfig } from '../config.js';

async function sendProgressUpdate(
  phoneNumber: string,
  stage: number,
  lang: Language,
  config: WorkerConfig,
): Promise<void> {
  try {
    const wa = new WhatsAppClient({
      accessToken: config.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
    });

    const msg = stage === 2 ? msgProgressAlmostDone(lang) : '';
    if (msg) await wa.sendText(phoneNumber, msg);
  } catch (err) {
    console.warn(JSON.stringify({ event: 'progress_update_failed', stage, error: String(err) }));
  }
}

export async function processImageJob(job: Job): Promise<void> {
  const config = getConfig();
  const data = ImageProcessingJobDataSchema.parse(job.data);

  // Bug 3 fix: compute effectiveStyle early so ALL cache keys are consistent.
  // style_video_shoot maps to style_autmn_special. If this is declared later
  // (as it was), the profile is written under data.style but looked up under
  // effectiveStyle → guaranteed cache miss for video-shoot orders.
  const effectiveStyle: string = data.style === 'style_video_shoot'
    ? 'style_autmn_special'
    : (data.style ?? 'style_lifestyle');

  const log = (msg: string, extra?: Record<string, unknown>) => {
    const line = JSON.stringify({ job: job.id, orderId: data.orderId, msg, ...extra });
    console.log(line);
  };

  log('=== STARTING IMAGE PROCESSING ===', { style: data.style, imageUrl: data.inputImageUrl.slice(0, 80) });

  // Fetch the imageJob record to get styleIndex (used for progress update gating)
  const imageJobRecord = await prisma.imageJob.findUnique({
    where: { id: data.imageJobId },
    select: { styleIndex: true },
  }).catch(() => null);
  const styleIndex = imageJobRecord?.styleIndex ?? 0;
  const isFirstJob = styleIndex === 0;

  // Fetch the user's language early — needed for progress messages
  const userForLang = await prisma.user.findUnique({
    where: { phoneNumber: data.phoneNumber },
    select: { language: true },
  }).catch(() => null);
  const lang = (userForLang?.language as Language) || 'hi';

  // Update job status
  await prisma.imageJob.update({
    where: { id: data.imageJobId },
    data: { status: 'processing', startedAt: new Date(), attempts: { increment: 1 } },
  }).catch((err) => {
    console.error(JSON.stringify({
      event: 'db_update_failed',
      error: err instanceof Error ? err.message : String(err),
      context: 'imageJob_mark_processing',
    }));
  }); // Job record might not exist for edits

  // V5 pipeline handles its own lightweight analysis (lightAnalyze, ~3s).
  // V4's heavy analyzeProductV4 (24s, 42 fields) has been removed.
  const productProfile: any = null;

  try {
    // Declare shared output variables — all set by the normal pipeline path.
    // eslint-disable-next-line prefer-const
    let outputUrl!: string;
    let cutoutUrl: string | undefined;

    {
      // ── Normal image pipeline ─────────────────────────────────────────────
      log('Using Never-Fail pipeline (V5)');

      // Progress update — sent after 30s delay, only for the first job
      let stage2Sent = false;
      let stage2Timer: ReturnType<typeof setTimeout> | undefined;
      if (isFirstJob) {
        stage2Timer = setTimeout(async () => {
          if (!stage2Sent) {
            stage2Sent = true;
            await sendProgressUpdate(data.phoneNumber, 2, lang, config);
          }
        }, 90_000);
      }

      // Send initial progress message (first job only)
      if (isFirstJob) {
        try {
          const waProgress = new WhatsAppClient({
            accessToken: config.WHATSAPP_ACCESS_TOKEN,
            phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
          });
          await waProgress.sendText(data.phoneNumber, msgGotPhotoCreating(lang, 3));
        } catch (err) {
          console.warn(JSON.stringify({ event: 'progress_start_failed', error: String(err) }));
        }
      }

      // Download reference photos (all inputImageUrls except index 0, which is the primary)
      // The primary URL is already downloaded inside the pipeline via params.imageUrl.
      const orderForRefs = await prisma.order.findUnique({
        where: { id: data.orderId },
        select: { inputImageUrls: true },
      }).catch(() => null);

      const allInputUrls = (orderForRefs?.inputImageUrls ?? []) as string[];
      const referenceUrls = allInputUrls.slice(1); // skip index 0 (primary)
      const referenceImageBuffers: Buffer[] = [];

      for (const url of referenceUrls) {
        try {
          const buf = await downloadBuffer(url);
          referenceImageBuffers.push(buf);
        } catch (err) {
          console.warn(JSON.stringify({
            event: 'reference_download_failed',
            url,
            error: err instanceof Error ? err.message : String(err),
          }));
          // Continue — a missing reference is not fatal
        }
      }

      if (referenceImageBuffers.length > 0) {
        console.info(JSON.stringify({
          event: 'reference_buffers_ready',
          orderId: data.orderId,
          referenceCount: referenceImageBuffers.length,
        }));
      }

      const result = await processImageNeverFail({
        imageUrl: data.inputImageUrl,
        style: effectiveStyle,
        productCategory: data.productCategory,
        voiceInstructions: data.voiceInstructions,
        referenceImageBuffers: referenceImageBuffers.length > 0 ? referenceImageBuffers : undefined,
      });

      // Cancel the stage 2 timer if pipeline finished before 30s
      if (stage2Timer !== undefined) {
        clearTimeout(stage2Timer);
        stage2Sent = true;
      }

      log(`Pipeline complete`, {
        tier: result.tier,
        tierReason: result.tierReason,
        pipeline: result.pipeline,
        qaScore: result.qaScore,
        durationMs: result.durationMs,
      });

      await job.updateProgress(80);

      // Use pipeline output URL directly if it's already in Supabase storage
      // (the pipeline uploads internally via uploadToStorage)
      outputUrl = result.outputUrl;
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

      await job.updateProgress(90);

      // Map pipeline string to Prisma enum — new never-fail tier names fall back to 'fallback'
      const PIPELINE_ENUM_MAP: Record<string, string> = {
        composite: 'composite',
        bria: 'bria',
        'bria-fallback': 'bria',
        kontext: 'kontext',
        segmentation: 'segmentation',
        nano_banana: 'nano_banana',
        primary: 'primary',
        fallback: 'fallback',
        'styled-studio': 'fallback',
        'styled-studio-fallback': 'fallback',
        'clean-studio': 'fallback',
        'enhanced-original': 'fallback',
        'raw-input': 'fallback',
        'tier4-enhanced': 'fallback',
      };
      const pipelineEnum = (PIPELINE_ENUM_MAP[result.pipeline] ?? 'fallback') as any;

      // Update job record
      await prisma.imageJob.update({
        where: { id: data.imageJobId },
        data: {
          status: 'completed',
          outputImageUrl: outputUrl,
          cutoutUrl,
          qaScore: result.qaScore,
          qaAttempts: result.attempts,
          pipeline: pipelineEnum,
          durationMs: result.durationMs,
          completedAt: new Date(),
        },
      }).catch((err) => {
        console.error(JSON.stringify({
          event: 'db_update_failed',
          error: err instanceof Error ? err.message : String(err),
          context: 'imageJob_mark_completed',
        }));
      });
    } // end of normal image pipeline branch

    // Update order — add output URL
    const order = await prisma.order.findUnique({ where: { id: data.orderId } });
    if (order) {
      await prisma.order.update({
        where: { id: data.orderId },
        data: {
          outputImageUrls: { push: outputUrl },
          cutoutUrls: cutoutUrl ? { push: cutoutUrl } : undefined,
        },
      });

      // Check if all images in the current round are done.
      const allJobs = await prisma.imageJob.findMany({
        where: { orderId: data.orderId },
      });

      // For edit/redo: only look at jobs created after the last processingStartedAt.
      // For initial orders: look at ALL jobs.
      // isEditRound is determined by job count — more jobs than imageCount means a
      // previous round exists, so we are in an edit round.
      const isEditRound = allJobs.length > (order.imageCount ?? 0);
      const currentRoundJobs = isEditRound && order.processingStartedAt
        ? allJobs.filter((j: ImageJob) => {
            const jobCreated = new Date(j.createdAt).getTime();
            const roundStart = new Date(order.processingStartedAt!).getTime();
            return jobCreated >= roundStart - 5000; // 5s buffer for clock skew
          })
        : allJobs;

      const allComplete = currentRoundJobs.length > 0 && currentRoundJobs.every(
        (j: ImageJob) => j.status === 'completed' || j.status === 'failed',
      );

      if (allComplete) {
        const jobsForDelivery = isEditRound ? currentRoundJobs : allJobs;

        const completedJobs = jobsForDelivery.filter(
          (j: ImageJob) => j.status === 'completed' && j.outputImageUrl,
        );
        const completedUrls = completedJobs.map((j: ImageJob) => j.outputImageUrl!);

        const sortedCompletedJobs = [...completedJobs].sort(
          (a: ImageJob, b: ImageJob) => (a.styleIndex ?? 0) - (b.styleIndex ?? 0),
        );

        const sortedCompletedUrls = sortedCompletedJobs.map((j: ImageJob) => j.outputImageUrl!);
        const styleLabels = sortedCompletedJobs
          .map((j: ImageJob) => j.style ?? null)
          .filter((s): s is string => s !== null);

        // Fetch the user record — needed for both delivery paths below
        const user = await prisma.user.findUnique({
          where: { phoneNumber: data.phoneNumber },
        });

        // ── Atomic delivery lock ─────────────────────────────────────────────
        // Only ONE worker may deliver by claiming the transition to 'completed'
        // BEFORE sending images. If another worker already claimed it (count=0),
        // check whether this is a style-change edit that still needs delivery.
        const deliveryClaim = await prisma.order.updateMany({
          where: {
            id: data.orderId,
            status: { in: ['processing', 'payment_confirmed'] },
          },
          data: {
            status: 'completed',
            outputImageUrls: sortedCompletedUrls,
            processingCompletedAt: new Date(),
          },
        });

        if (deliveryClaim.count === 0) {
          // Another worker already claimed delivery. Check for style-change edit path
          // where the session is EDIT_PROCESSING — that still requires sending the new output.
          if (!user) {
            log('Delivery already claimed by another worker — skipping');
            return;
          }
          const currentSession = await prisma.session.findFirst({ where: { userId: user.id } });
          const isStyleChangeEdit = currentSession?.state === 'EDIT_PROCESSING';
          if (isStyleChangeEdit) {
            log('Style-change edit delivery — order already marked complete, sending output and feedback buttons');
            const wa = new WhatsAppClient({
              accessToken: config.WHATSAPP_ACCESS_TOKEN,
              phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
            });
            await sendProcessedImages(
              data.phoneNumber,
              [outputUrl],
              (user?.language as 'hi' | 'en') || 'hi',
              user?.name ?? undefined,
              wa,
              [],
              [],
              effectiveStyle ? [effectiveStyle] : undefined,
            );
            await prisma.session.updateMany({
              where: { userId: user.id, state: 'EDIT_PROCESSING' },
              data: { state: 'DELIVERED', stateEnteredAt: new Date() },
            });
          } else {
            log('Delivery already claimed by another worker — skipping');
          }
          return;
        }

        // We won the atomic race — now deliver. If delivery fails, the order is
        // already marked complete so the user can retry via "Make a change".
        const wa = new WhatsAppClient({
          accessToken: config.WHATSAPP_ACCESS_TOKEN,
          phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        });

        // Re-fetch authoritative output URLs from image_jobs to avoid race condition
        // where order.output_image_urls is stale (concurrent workers may not have
        // committed their imageJob updates at the time allJobs was first fetched).
        const expectedJobCount = currentRoundJobs.length;
        let deliveryJobs = await prisma.imageJob.findMany({
          where: {
            orderId: data.orderId,
            status: 'completed',
            outputImageUrl: { not: null },
          },
          orderBy: { styleIndex: 'asc' },
          select: {
            styleIndex: true,
            outputImageUrl: true,
            cutoutUrl: true,
            style: true,
          },
        });

        if (deliveryJobs.length < expectedJobCount) {
          // In-flight DB commits from concurrent workers haven't landed yet — wait briefly
          await new Promise(r => setTimeout(r, 1500));
          const retryJobs = await prisma.imageJob.findMany({
            where: {
              orderId: data.orderId,
              status: 'completed',
              outputImageUrl: { not: null },
            },
            orderBy: { styleIndex: 'asc' },
            select: {
              styleIndex: true,
              outputImageUrl: true,
              cutoutUrl: true,
              style: true,
            },
          });
          if (retryJobs.length > deliveryJobs.length) {
            deliveryJobs = retryJobs;
          }
        }

        const finalOutputUrls = deliveryJobs.map(j => j.outputImageUrl!).filter(Boolean);
        const finalStyleLabels = deliveryJobs.map(j => j.style ?? '').filter(Boolean);

        console.info(JSON.stringify({
          event: 'delivery_url_collection',
          orderId: data.orderId,
          expectedCount: expectedJobCount,
          collectedCount: finalOutputUrls.length,
          retried: deliveryJobs.length < expectedJobCount,
        }));

        // Send "Ready!" signal before images — gives images time to load on slow connections
        try {
          await wa.sendText(data.phoneNumber, msgProgressReadyToSend((user?.language as 'hi' | 'en') || 'hi'));
          await new Promise(r => setTimeout(r, 2000)); // 2s gap so message arrives before images
        } catch (err) {
          console.warn(JSON.stringify({ event: 'progress_ready_to_send_failed', error: String(err) }));
        }

        await sendProcessedImages(
          data.phoneNumber,
          finalOutputUrls,
          (user?.language as 'hi' | 'en') || 'hi',
          user?.name ?? undefined,
          wa,
          [],
          [],
          finalStyleLabels.length > 0 ? finalStyleLabels : undefined,
        );

        // Transition session to DELIVERED from PROCESSING, EDIT_PROCESSING, IDLE, or
        // AWAITING_REVISION_PAYMENT. The last case covers a race where the user paid for
        // a revision, the session timed out and moved forward before the job finished, and
        // the worker arrives late — user still needs to see the output.
        if (user) {
          const sessionUpdate = await prisma.session.updateMany({
            where: { userId: user.id, state: { in: ['PROCESSING', 'EDIT_PROCESSING', 'IDLE', 'AWAITING_REVISION_PAYMENT'] } },
            data: { state: 'DELIVERED', stateEnteredAt: new Date() },
          });
          if (sessionUpdate.count > 0) {
            log('Session transitioned to DELIVERED');
          } else {
            log('Session transition skipped — already in correct state or not found');
          }
        }

        await job.updateProgress(100);
        log('All images delivered', { count: completedUrls.length });
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error(JSON.stringify({ event: 'image_processing_failed', job: job.id, orderId: data.orderId, error: errorMsg }));
    log('Image processing failed', { error: errorMsg });

    // Update job as failed
    await prisma.imageJob.update({
      where: { id: data.imageJobId },
      data: {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      },
    }).catch((dbErr) => {
      console.error(JSON.stringify({
        event: 'db_update_failed',
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        context: 'imageJob_mark_failed',
      }));
    });

    // If all retries exhausted, notify user
    const jobRecord = await prisma.imageJob.findUnique({
      where: { id: data.imageJobId },
    });

    // Check if BullMQ will NOT retry this job (final attempt)
    const bullmqMaxAttempts = job.opts?.attempts ?? 3;
    const isFinalBullMQAttempt = job.attemptsMade >= bullmqMaxAttempts;
    const isMaxImageJobAttempts = jobRecord ? jobRecord.attempts >= jobRecord.maxAttempts : false;

    if (isFinalBullMQAttempt || isMaxImageJobAttempts) {
      const user = await prisma.user.findUnique({
        where: { phoneNumber: data.phoneNumber },
      });
      const lang = (user?.language as 'hi' | 'en') || 'hi';

      const wa = new WhatsAppClient({
        accessToken: config.WHATSAPP_ACCESS_TOKEN,
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
            msgPhotoProcessingFailed(lang),
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
        }).catch((dbErr) => {
          console.error(JSON.stringify({
            event: 'db_update_failed',
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
            context: 'order_mark_failed',
          }));
        });
      }
    }

    throw err; // Let BullMQ handle retries
  }
}
