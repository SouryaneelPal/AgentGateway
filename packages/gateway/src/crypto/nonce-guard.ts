/**
 * Replay protection (§3.2) — IMPLEMENTED (Phase 3).
 *
 * Two independent layers, on purpose. Redis gives fast-path rejection before any
 * database write; the mandates.nonce UNIQUE constraint in Postgres is the durable
 * backstop that holds even if Redis is flushed, restarted or unreachable. Defence in
 * depth, not redundancy for its own sake (§2.3 design notes).
 *
 * The same mechanism serves both protocols: an AP2 mandate nonce and an x402 one-time
 * `reference` are the same kind of object — a single-use token minted for one request —
 * so x402 reuses this rather than inventing a parallel scheme (§3.2 final bullet).
 */

import { redis } from '../redis/redis-client.js';

const NONCE_KEY_PREFIX = 'nonce:';

/** Never let a clock-skewed or hostile expiry set an absurd TTL. */
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 24 * 60 * 60;

export type NonceReservation =
  | { readonly reserved: true; readonly ttlSeconds: number }
  | { readonly reserved: false; readonly reason: 'replayed' }
  | { readonly reserved: false; readonly reason: 'redis_unavailable'; readonly error: string };

/**
 * TTL equals the mandate's remaining validity window (§3.2). Once the mandate has
 * expired it cannot be redeemed anyway, so holding the key longer buys nothing — and
 * the Postgres constraint is permanent regardless.
 */
export function remainingValiditySeconds(expiresAt: Date, now: Date = new Date()): number {
  const seconds = Math.ceil((expiresAt.getTime() - now.getTime()) / 1000);
  if (seconds < MIN_TTL_SECONDS) return MIN_TTL_SECONDS;
  if (seconds > MAX_TTL_SECONDS) return MAX_TTL_SECONDS;
  return seconds;
}

/**
 * `SETNX nonce:{nonce} 1 EX {ttl}` (§3.2). Returns reserved:false/'replayed' when the
 * key already exists — the request is a replay and must be rejected BEFORE any
 * database write.
 *
 * A Redis outage is reported distinctly rather than being folded into "replayed":
 * failing open here is safe ONLY because the Postgres unique constraint still refuses
 * the duplicate insert. Callers must therefore treat 'redis_unavailable' as
 * "continue, the DB will catch it" and never as "reject" — otherwise a Redis blip
 * becomes a full outage of the mandate path.
 */
export async function reserveNonce(nonce: string, ttlSeconds: number): Promise<NonceReservation> {
  const key = `${NONCE_KEY_PREFIX}${nonce}`;
  try {
    const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    if (result === null) return { reserved: false, reason: 'replayed' };
    return { reserved: true, ttlSeconds };
  } catch (error) {
    return {
      reserved: false,
      reason: 'redis_unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Releases a reservation. Used when the surrounding database transaction rolls back,
 * so a nonce is not burned by a request that never actually persisted — without this,
 * a transient DB failure would permanently lock out a legitimate retry.
 */
export async function releaseNonce(nonce: string): Promise<void> {
  try {
    await redis.del(`${NONCE_KEY_PREFIX}${nonce}`);
  } catch {
    // Best effort. The key expires on its own, and the DB constraint is authoritative.
  }
}

/** Test seam: lets the Redis fast path be disabled to prove the DB backstop works alone. */
export async function isNonceReserved(nonce: string): Promise<boolean> {
  const value = await redis.get(`${NONCE_KEY_PREFIX}${nonce}`);
  return value !== null;
}
