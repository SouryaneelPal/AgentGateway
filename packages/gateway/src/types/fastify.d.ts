/**
 * Fastify request augmentation.
 *
 * §3.4 requires the webhook HMAC to be computed over the unparsed body. server.ts
 * installs a content-type parser that stashes the raw buffer here before JSON parsing
 * runs, and webhooks.routes.ts reads it back.
 */

import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}
