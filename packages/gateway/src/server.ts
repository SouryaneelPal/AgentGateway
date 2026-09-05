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
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { readBearerToken, hashApiKey } from './auth/merchant-auth.js';

import { env } from './config/env.js';
import { isAllowedOrigin } from './config/cors.js';
import { NotImplementedError, PolicyRejectionError } from './errors.js';
import { healthRoutes } from './health/health.routes.js';
import { x402Routes } from './routes/x402.routes.js';
// The constant, not a string literal: the exposed header and the header the adapter
// actually sets must never drift apart.
import { X402_PAYMENT_REQUIRED_HEADER } from './adapters/x402.adapter.js';
import { ap2Routes } from './routes/ap2.routes.js';
import { fallbackRoutes } from './routes/fallback.routes.js';
import { webhookRoutes } from './routes/webhooks.routes.js';
import { merchantRoutes } from './routes/merchant.routes.js';
import { disconnectDatabase } from './db/prisma-client.js';
import { disconnectRedis } from './redis/redis-client.js';
import { findControlCharacterPath } from './validation.js';

/**
 * Best-effort attribution of a payment-facing request to an agent identity, for rate
 * limiting only. Deliberately shallow: this runs before validation, so it must never
 * throw and must never be treated as authentication.
 */
function readAgentIdentityHint(request: { body?: unknown; query?: unknown }): string | null {
  const fromBody = request.body;
  if (typeof fromBody === 'object' && fromBody !== null && !Array.isArray(fromBody)) {
    const agentId = (fromBody as Record<string, unknown>)['agentId'];
    if (typeof agentId === 'string' && agentId.length > 0 && agentId.length <= 128) {
      return agentId;
    }
  }
  const fromQuery = request.query;
  if (typeof fromQuery === 'object' && fromQuery !== null) {
    const agentId = (fromQuery as Record<string, unknown>)['agentId'];
    if (typeof agentId === 'string' && agentId.length > 0 && agentId.length <= 128) {
      return agentId;
    }
  }
  return null;
}

export async function buildServer(): Promise<FastifyInstance> {
  const merchantMax = env.RATE_LIMIT_MERCHANT_MAX;
  const merchantWindow = env.RATE_LIMIT_MERCHANT_WINDOW_MS;
  const agentMax = env.RATE_LIMIT_AGENT_MAX;
  const agentWindow = env.RATE_LIMIT_AGENT_WINDOW_MS;

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

  /**
   * Rate limiting (Phase 4.5).
   *
   * Keyed by WHO is calling, not by IP: agents and dashboards sit behind NAT and proxies,
   * so an IP-keyed limit would either punish co-located callers or be trivially evaded.
   *   - /v1/merchant/*  -> keyed on the merchant API key (hashed; never log the key)
   *   - everything else -> keyed on the agent identity when the request carries one,
   *                        falling back to IP for unattributable traffic
   * Limits come from env so a load test or demo can raise them without a code change.
   */
  await app.register(rateLimit, {
    global: true,
    // MUST run at preHandler, not the default onRequest. keyGenerator needs the parsed
    // body to read agentId, and at onRequest the body has not been parsed yet — so
    // readAgentIdentityHint always saw undefined and every agent silently shared one
    // IP-keyed bucket. The limiter still limited, which is why nothing failed and the
    // defect survived Phase 4.5: it was doing a different job than the one documented.
    hook: 'preHandler',
    max: (request) => (request.url.startsWith('/v1/merchant/') ? merchantMax : agentMax),
    timeWindow: (request) =>
      request.url.startsWith('/v1/merchant/') ? merchantWindow : agentWindow,
    keyGenerator: (request) => {
      if (request.url.startsWith('/v1/merchant/')) {
        const token = readBearerToken(request);
        // Hash so the raw key never reaches the limiter's store or any log line.
        return token === null ? `ip:${request.ip}` : `mk:${hashApiKey(token)}`;
      }
      const agentId = readAgentIdentityHint(request);
      return agentId === null ? `ip:${request.ip}` : `agent:${agentId}`;
    },
    // The webhook route must never be throttled: dropping a settlement confirmation
    // because Razorpay burst is far worse than the burst itself (§1.3).
    allowList: (request) => request.url.startsWith('/webhooks/'),
    // statusCode MUST be included here. The plugin turns this object into a thrown
    // error, which then reaches the global error handler below — and without an explicit
    // statusCode that handler saw an unrecognised error and mapped it to 500. The limit
    // was enforcing correctly the whole time (x-ratelimit-remaining hit 0), but callers
    // were told "internal_error" instead of "back off", which is exactly the wrong
    // signal: a 500 invites a retry, a 429 does not.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'rate_limit_exceeded',
      detail: `too many requests — limit ${context.max} per ${context.after}`,
      retry_after_seconds: Math.ceil(context.ttl / 1000),
    }),
  });

  /**
   * Security headers (Phase 7).
   *
   * The gateway serves JSON, never HTML, so the headers that matter here are the ones
   * that stop a response from being *reinterpreted* as something renderable:
   * nosniff defeats content-type guessing, frame-ancestors 'none' defeats framing, and a
   * CSP of default-src 'none' means that if a JSON body ever were rendered as a document,
   * it could load nothing.
   *
   * HSTS is deliberately left to helmet's default (enabled, but only ever acted on by a
   * browser over HTTPS). Locally the gateway is plain HTTP and the header is ignored.
   */
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // The console fetches from a different origin; a same-origin-only referrer policy is
    // the strictest setting that still lets it work.
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  /**
   * CORS (Phase 7).
   *
   * Previously `origin: true` in development, which reflects whatever Origin the caller
   * sends. Combined with `credentials: true` that is the permissive combination: any web
   * page the merchant happened to visit could issue credentialed requests to a gateway
   * running on their machine and read the replies. It is now an explicit allowlist in
   * every environment, sourced from DASHBOARD_ORIGIN.
   *
   * A request with no Origin header is allowed through. That is not a hole — it is how
   * every non-browser client behaves (curl, the agent client, Razorpay's webhook
   * delivery), and CORS is a browser mechanism that has nothing to say about them. The
   * gateway's actual authorization for those callers is the API key and the webhook HMAC.
   */
  await app.register(cors, {
    origin: (origin, callback) => {
      if (origin === undefined || isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    /**
     * Headers browser JavaScript is allowed to READ off a cross-origin response.
     *
     * Setting Access-Control-Allow-Origin is only half the job, and the missing half
     * fails silently. CORS restricts a cross-origin reader to seven safelisted response
     * headers (Cache-Control, Content-Language, Content-Length, Content-Type, Expires,
     * Last-Modified, Pragma); every other header is stripped from `response.headers`
     * before script sees it. The server still sends it, a proxy still logs it, and curl
     * still shows it — so the header looks present from every angle except the one that
     * matters.
     *
     * That is exactly how this surfaced: the console's live x402 run failed on
     * `headers.get('payment-required')` returning null and reported "No PAYMENT-REQUIRED
     * header returned", while the same request under curl showed the header intact.
     * The protocol's entire challenge/response depends on the browser reading it.
     *
     * The rate-limit headers are listed for a related reason: the README documents them
     * as part of a 429 response, and without exposure that promise silently excludes
     * every browser caller.
     */
    exposedHeaders: [
      X402_PAYMENT_REQUIRED_HEADER,
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ],
  });

  /**
   * Body-wide control-character rejection (Phase 7).
   *
   * Postgres text and jsonb columns cannot store U+0000; it raises error 22021. Before
   * this hook, a null byte anywhere in a request body surfaced as an HTTP 500 carrying a
   * raw Prisma error — found by probing POST /v1/ap2/mandates during this pass.
   *
   * This runs body-wide rather than field-by-field because the fallback adapter persists
   * the entire body (`JSON.stringify(body)` and `raw: { ...body }`), so a null byte in a
   * field no adapter reads still reaches the database. Per-field bounds still exist in
   * the adapters; this is the backstop that makes them sufficient.
   */
  app.addHook('preValidation', async (request, reply) => {
    if (request.body === undefined || request.body === null) return;
    const offendingPath = findControlCharacterPath(request.body);
    if (offendingPath !== null) {
      await reply.code(400).send({
        error: 'malformed_request',
        message: 'Request contains control characters, which cannot be stored.',
        field: offendingPath,
      });
    }
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

    // @fastify/rate-limit signals throttling with this code; surface it as 429 even if
    // an upstream builder omits statusCode.
    if (error.code === 'FST_ERR_RATE_LIMIT' || error.statusCode === 429) {
      return reply.code(429).send({
        error: 'rate_limit_exceeded',
        detail: error.message,
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    /**
     * A 5xx never echoes the underlying message (Phase 7).
     *
     * `message: error.message` used to be returned verbatim. For a Prisma failure that
     * message contains the absolute source path of the query, the surrounding lines of
     * our own source, and the raw Postgres error — all of which were being handed to an
     * unauthenticated caller. A null byte in an agent id was enough to trigger it.
     *
     * Suppression is unconditional rather than gated on NODE_ENV=production. A leak that
     * only appears in production is a leak nobody sees while building, and the detail is
     * not lost — the full error is logged above, and the request id below correlates the
     * caller's report to that log line.
     */
    if (statusCode >= 500) {
      return reply.code(statusCode).send({
        error: 'internal_error',
        message: 'The gateway failed to process this request. The failure has been logged.',
        requestId: request.id,
      });
    }

    return reply.code(statusCode).send({
      error: error.code ?? 'request_error',
      message: error.message,
      requestId: request.id,
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
