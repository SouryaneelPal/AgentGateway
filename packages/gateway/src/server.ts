/**
 * AgentGateway — Fastify service entrypoint (§2.1).
 *
 * Phase 1 wires the skeleton: config, Postgres, Redis, /health, the §2.4 route surface,
 * raw-body capture for webhook verification, and graceful shutdown. The protocol
 * router, adapters and policy engine are registered as stubs and fill in from Phase 2.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

import { env } from './config/env.js';
import { NotImplementedError, PolicyRejectionError } from './errors.js';
import { healthRoutes } from './health/health.routes.js';
import { x402Routes } from './routes/x402.routes.js';
import { ap2Routes } from './routes/ap2.routes.js';
import { fallbackRoutes } from './routes/fallback.routes.js';
import { webhookRoutes } from './routes/webhooks.routes.js';
import { merchantRoutes } from './routes/merchant.routes.js';
import { disconnectDatabase } from './db/prisma-client.js';
import { disconnectRedis } from './redis/redis-client.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Silent under test: the suite asserts on database state and HTTP responses, and
    // request logs would bury the actual results.
    logger:
      env.NODE_ENV === 'test'
        ? false
        : env.NODE_ENV === 'development'
          ? {
              level: 'info',
              transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss Z' } },
            }
          : { level: 'info' },
    // Strict routing avoids surprising duplicate route matches on the webhook path.
    // (Fastify 5 moved router options under routerOptions; the top-level form is
    // deprecated and removed in Fastify 6.)
    routerOptions: { ignoreTrailingSlash: false },
  });

  /**
   * Raw-body capture — §3.4's "detail that matters more than it looks".
   *
   * If Fastify's default JSON parser runs first, the parsed object can only be
   * re-serialised, and a re-serialised body will not byte-match what Razorpay signed.
   * So we parse as a buffer, keep the original bytes on the request, and only then
   * hand JSON.parse the same bytes.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      request.rawBody = body;

      if (body.length === 0) {
        done(null, undefined);
        return;
      }

      try {
        done(null, JSON.parse(body.toString('utf8')) as unknown);
      } catch (error) {
        const parseError = error instanceof Error ? error : new Error('invalid JSON body');
        Object.assign(parseError, { statusCode: 400 });
        done(parseError, undefined);
      }
    },
  );

  await app.register(cors, {
    // The dashboard (Phase 5) is a separate origin in development.
    origin: env.NODE_ENV === 'development' ? true : false,
    credentials: true,
  });

  // Anything scaffolded but not yet built answers 501, not 500 — an unimplemented
  // route should be legible as unimplemented.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof NotImplementedError) {
      request.log.warn({ subject: error.subject, phase: error.phase }, 'not implemented');
      return reply.code(501).send({
        error: 'not_implemented',
        subject: error.subject,
        phase: error.phase,
        message: error.message,
      });
    }

    if (error instanceof PolicyRejectionError) {
      return reply.code(403).send({ error: error.code, ...error.detail });
    }

    request.log.error({ err: error }, 'unhandled error');
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    return reply.code(statusCode).send({
      error: statusCode === 500 ? 'internal_error' : (error.code ?? 'request_error'),
      message: error.message,
    });
  });

  await app.register(healthRoutes);
  await app.register(x402Routes);
  await app.register(ap2Routes);
  await app.register(fallbackRoutes);
  await app.register(webhookRoutes);
  await app.register(merchantRoutes);

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    // 0.0.0.0 so the container's published port actually reaches the process.
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

// Only auto-start when run directly, so tests can import buildServer() cleanly.
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  void main();
}
