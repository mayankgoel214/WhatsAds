import type { FastifyInstance } from 'fastify';
import { prisma } from '@whatsads/db';
import { getRedisConnection } from '@whatsads/queue';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Lightweight liveness probe — Railway uses this to know the process is up
  app.get('/health', async () => {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  });

  // Deep readiness probe — checks real dependencies
  // Hit this manually after deploy or from an external uptime monitor
  app.get('/health/ready', async (request, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    let allOk = true;

    // Database
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'fail';
      allOk = false;
    }

    // Redis / BullMQ
    try {
      const redis = getRedisConnection();
      await redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'fail';
      allOk = false;
    }

    const status = allOk ? 200 : 503;
    return reply.status(status).send({
      status: allOk ? 'ok' : 'degraded',
      checks,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });
}
