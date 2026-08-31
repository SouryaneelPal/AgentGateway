/**
 * The CORS allowlist, in one place (Phase 7).
 *
 * Two call sites need it and they must not disagree:
 *
 *   1. @fastify/cors in server.ts, which covers every ordinary route.
 *   2. GET /v1/merchant/stream, which writes to reply.raw and therefore never passes
 *      through the plugin — it sets its own headers by hand.
 *
 * When those two diverged, the SSE endpoint kept reflecting arbitrary origins after the
 * plugin had stopped doing so. A single exported predicate is the cheapest way to keep a
 * documented policy and an enforced policy the same policy.
 */

import { env } from './env.js';

/** Origins permitted to make credentialed cross-origin browser requests. */
export const allowedOrigins: readonly string[] = env.DASHBOARD_ORIGIN.split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.includes(origin);
}
