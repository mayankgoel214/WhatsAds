/**
 * WhatsApp Cloud API webhook routes.
 *
 * GET  /webhooks/whatsapp — Meta verification challenge
 * POST /webhooks/whatsapp — Incoming messages and status updates
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WhatsAppClient, extractMessage, getMessageType, verifyWebhookSignature } from '@whatsads/whatsapp';
import type { WhatsAppWebhookBody } from '@whatsads/whatsapp';
import { handleIncomingMessage } from '@whatsads/session';
import type { MessageContext } from '@whatsads/session';
import { prisma } from '@whatsads/db';
import { getConfig } from '../../config.js';

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter: max 60 requests/minute per IP
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, number[]>();

// Purge stale entries every 60 seconds to prevent unbounded memory growth.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of rateLimitMap) {
    const fresh = timestamps.filter(t => t > cutoff);
    if (fresh.length === 0) {
      rateLimitMap.delete(ip);
    } else {
      rateLimitMap.set(ip, fresh);
    }
  }
  // Nuclear option: if the map is still enormous, clear it entirely.
  if (rateLimitMap.size > 10_000) {
    rateLimitMap.clear();
  }
}, 60_000).unref();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (rateLimitMap.get(ip) ?? []).filter(t => t > cutoff);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

export async function whatsappWebhookRoutes(app: FastifyInstance): Promise<void> {
  const config = getConfig();

  // -------------------------------------------------------------------------
  // GET — Meta verification challenge
  // -------------------------------------------------------------------------

  app.get('/webhooks/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>;
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === config.WHATSAPP_VERIFY_TOKEN) {
      app.log.info('WhatsApp webhook verified');
      return reply.code(200).send(challenge);
    }

    return reply.code(403).send('Forbidden');
  });

  // -------------------------------------------------------------------------
  // POST — Incoming messages
  // -------------------------------------------------------------------------

  app.post('/webhooks/whatsapp', async (req: FastifyRequest, reply: FastifyReply) => {
    // Rate limiting: 60 req/min per IP
    const ip = req.ip ?? 'unknown';
    if (isRateLimited(ip)) {
      app.log.warn({ ip }, 'WhatsApp webhook rate limit exceeded');
      return reply.code(429).send({ error: 'Too many requests', code: 'RATE_LIMITED' });
    }

    // Verify signature BEFORE responding — HMAC takes <1ms so this is safe.
    // Meta only requires the 200 within 20s; heavy processing still runs async below.
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = (req as any).rawBody as string | undefined;

    if (config.NODE_ENV === 'production') {
      if (!signature || !rawBody) {
        app.log.warn('Missing signature or raw body');
        return reply.code(401).send({ error: 'Missing signature', code: 'UNAUTHORIZED' });
      }
      if (!verifyWebhookSignature(rawBody, signature, config.WHATSAPP_APP_SECRET)) {
        app.log.warn('Invalid WhatsApp webhook signature — rejecting request');
        return reply.code(401).send({ error: 'Invalid signature', code: 'UNAUTHORIZED' });
      }
    } else {
      // Development mode: skip verification when secret is the placeholder value.
      if (config.WHATSAPP_APP_SECRET === 'placeholder') {
        app.log.warn('WHATSAPP_APP_SECRET is placeholder — skipping signature verification in dev');
      } else if (!signature || !rawBody) {
        app.log.warn('Missing signature or raw body');
        return reply.code(401).send({ error: 'Missing signature', code: 'UNAUTHORIZED' });
      } else if (!verifyWebhookSignature(rawBody, signature, config.WHATSAPP_APP_SECRET)) {
        app.log.warn('Invalid WhatsApp webhook signature (dev mode — continuing anyway)');
      }
    }

    // Signature passed (or skipped in dev). Respond 200 immediately so Meta is
    // satisfied within its 20-second window. All DB writes and processing below
    // run asynchronously after the response is flushed.
    reply.code(200).send('OK');

    try {
      const body = req.body as WhatsAppWebhookBody;

      // Store raw event for debugging/audit
      await prisma.webhookEvent.create({
        data: {
          source: 'whatsapp',
          eventType: 'message',
          rawPayload: body as any,
        },
      }).catch((err: unknown) => app.log.error({ err }, 'Failed to store webhook event'));

      // Extract message
      const extracted = extractMessage(body);
      if (!extracted?.message) {
        // Status update or no message — skip
        return;
      }

      const { message } = extracted;
      const phoneNumber = message.from;
      const rawType = getMessageType(message);

      // Map to session-expected types
      const validTypes = ['text', 'image', 'audio', 'interactive', 'unknown'] as const;
      const messageType = validTypes.includes(rawType as any)
        ? (rawType as typeof validTypes[number])
        : 'unknown';

      // Skip unsupported message types (reactions, stickers, system messages, etc.)
      if (!messageType || messageType === 'unknown') {
        app.log.debug('Ignoring unsupported message type: %s', rawType);
        return;
      }

      // Build message context — access message fields via any cast since
      // the WhatsApp types use a union but we know the shape by type check
      const msg = message as any;
      const messageContext: MessageContext = {
        messageId: message.id,
        messageType,
        timestamp: parseInt(message.timestamp, 10),
        text: message.type === 'text' ? msg.text?.body : undefined,
        mediaId:
          message.type === 'image'
            ? msg.image?.id
            : message.type === 'audio'
              ? msg.audio?.id
              : undefined,
        caption: message.type === 'image' ? msg.image?.caption : undefined,
        isVoiceNote: message.type === 'audio' ? msg.audio?.voice === true : undefined,
        buttonReplyId:
          message.type === 'interactive' && msg.interactive?.type === 'button_reply'
            ? msg.interactive.button_reply?.id
            : undefined,
        listReplyId:
          message.type === 'interactive' && msg.interactive?.type === 'list_reply'
            ? msg.interactive.list_reply?.id
            : undefined,
      };

      // Create WhatsApp client
      const wa = new WhatsAppClient({
        accessToken: config.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      });

      // Mark as read
      wa.markAsRead(message.id).catch(() => {});

      // Route through session state machine
      await handleIncomingMessage(phoneNumber, messageContext, wa);
    } catch (err) {
      app.log.error({ err }, 'WhatsApp webhook processing error');
    }
  });
}
