/**
 * Admin routes for development/testing.
 * Reset test user data with: curl -X POST http://localhost:3001/admin/reset/15406050446
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@whatsads/db';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
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
