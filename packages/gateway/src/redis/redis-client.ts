/**
 * Redis access (§2.1 State Layer: nonces, locks, idempotency).
 *
 * Phase 3 uses this for the SETNX nonce fast path described in §3.2; Phase 1 only
 * needs it reachable so /health can prove connectivity.
 */

import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import type { DependencyCheck } from '../db/prisma-client.js';

export const redis = new Redis(env.REDIS_URL, {
  // Fail fast on a dead Redis instead of retrying forever behind a health check.
  maxRetriesPerRequest: 2,
  connectTimeout: 5_000,
  lazyConnect: false,
});

// Without a listener, ioredis surfaces connection errors as unhandled 'error' events
// and crashes the process the moment Redis blips.
redis.on('error', (error: Error) => {
  if (env.NODE_ENV !== 'test') {
    console.error(`[redis] ${error.message}`);
  }
});

export async function checkRedis(): Promise<DependencyCheck> {
  const startedAt = performance.now();
  try {
    const pong = await redis.ping();
    const ok = pong === 'PONG';
    return {
      ok,
      latencyMs: Math.round(performance.now() - startedAt),
      ...(ok ? {} : { error: `unexpected PING reply: ${pong}` }),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
