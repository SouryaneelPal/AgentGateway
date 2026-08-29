/**
 * GET /health — Phase 1 deliverable.
 *
 * Returns 200 only if BOTH Postgres and Redis answer. A degraded dependency yields
 * 503 with a per-dependency breakdown, so "the gateway is up" and "the gateway can
 * actually do work" are never conflated.
 */

import type { FastifyPluginAsync } from 'fastify';
import { checkDatabase } from '../db/prisma-client.js';
import { checkRedis } from '../redis/redis-client.js';

interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly service: 'agentgateway';
  readonly uptimeSeconds: number;
  readonly checkedAt: string;
  readonly checks: {
    readonly postgres: { ok: boolean; latencyMs: number; error?: string };
    readonly redis: { ok: boolean; latencyMs: number; error?: string };
  };
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_request, reply) => {
    const [postgres, redis] = await Promise.all([checkDatabase(), checkRedis()]);
    const healthy = postgres.ok && redis.ok;

    const payload: HealthResponse = {
      status: healthy ? 'ok' : 'degraded',
      service: 'agentgateway',
      uptimeSeconds: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
      checks: { postgres, redis },
    };

    return reply.code(healthy ? 200 : 503).send(payload);
  });
};
