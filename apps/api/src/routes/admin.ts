/**
 * Admin routes for development/testing.
 * Reset test user data with: curl -X POST http://localhost:3001/admin/reset/15406050446
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@whatsads/db';
import { getRedisConnection } from '@whatsads/queue';

export async function adminRoutes(app: FastifyInstance): Promise<void> {

  // Flush stale bull queue keys
  app.post('/admin/flush-queue/:queueName', async (req: FastifyRequest, reply: FastifyReply) => {
    const { queueName } = req.params as { queueName: string };
    const redis = getRedisConnection();

    try {
      const keys = await redis.keys(`bull:${queueName}:*`);
      app.log.info({ queueName, keyCount: keys.length }, 'Flushing queue keys');

      if (keys.length > 0) {
        const pipeline = redis.pipeline();
        for (const key of keys) { pipeline.del(key); }
        await pipeline.exec();
      }

      return reply.send({ ok: true, deleted: keys.length });
    } catch (err) {
      app.log.error({ err, queueName }, 'Flush failed');
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });

  app.post('/admin/reset/:phone', async (req: FastifyRequest, reply: FastifyReply) => {
    const { phone } = req.params as { phone: string };

    try {
      const deleted = {
        imageJobs: (await prisma.imageJob.deleteMany({ where: { order: { phoneNumber: phone } } })).count,
        orders: (await prisma.order.deleteMany({ where: { phoneNumber: phone } })).count,
        sessions: (await prisma.session.deleteMany({ where: { phoneNumber: phone } })).count,
        users: (await prisma.user.deleteMany({ where: { phoneNumber: phone } })).count,
      };

      app.log.info({ phone, deleted }, 'Test data reset');
      return reply.send({ ok: true, deleted });
    } catch (err) {
      app.log.error({ err, phone }, 'Reset failed');
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });
}
