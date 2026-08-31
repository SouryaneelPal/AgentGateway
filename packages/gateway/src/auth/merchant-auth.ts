/**
 * Merchant API-key authentication (Phase 4.5).
 *
 * Closes the two issues the Phase 4 commit deferred:
 *   1. /v1/merchant/* was entirely unauthenticated
 *   2. merchantId was trusted from the request body — a cross-tenant IDOR
 *
 * Point 2 is the one that matters architecturally. Adding auth *alongside* a
 * body-supplied merchantId would not fix it: a caller could still authenticate as
 * merchant A and pass merchant B's id. So the merchant id is derived ONLY from the
 * presented key and attached to the request; routes read it from there and no
 * /v1/merchant/* route accepts a merchantId parameter any more.
 *
 * Keys are stored as SHA-256 hashes. The plaintext key is shown once at creation and is
 * not recoverable — a leaked database yields hashes, not working credentials.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db/prisma-client.js';

const KEY_PREFIX = 'agk_';
const KEY_BYTES = 32;

export interface GeneratedApiKey {
  /** Shown to the operator once. Never stored. */
  readonly plaintext: string;
  readonly keyHash: string;
  readonly keyPrefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const plaintext = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;
  return {
    plaintext,
    keyHash: hashApiKey(plaintext),
    // Enough to identify a key in a list, far too little to reconstruct it.
    keyPrefix: plaintext.slice(0, 12),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Extracts the bearer token.
 *
 * The Authorization header is the normal path. A single fallback exists: an `api_key`
 * query parameter, because the browser EventSource API cannot set request headers and
 * the dashboard's SSE feed would otherwise be unauthenticatable.
 *
 * The trade-off is real and worth naming rather than burying: a token in a query string
 * can land in server access logs and proxy logs in a way a header does not. It is the
 * SAME credential checked the SAME way — this widens where the token may be carried, not
 * who may use it — and it is acceptable for a local demo console. A production build
 * would have the dashboard POST for a short-lived, single-use stream ticket and pass
 * that instead.
 */
export function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;

  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const token = match?.[1]?.trim();
    if (token !== undefined && token.length > 0) return token;
  }

  const query = request.query;
  if (typeof query === 'object' && query !== null) {
    const fromQuery = (query as Record<string, unknown>)['api_key'];
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery.trim();
  }

  return null;
}

export interface AuthenticatedMerchant {
  readonly merchantId: string;
  readonly apiKeyId: string;
}

/**
 * Resolves a presented key to a merchant, or null.
 *
 * Lookup is by hash, so the comparison is an indexed equality on a digest rather than a
 * scan over secrets. The extra constant-time check guards the (already-hashed) value
 * against any timing signal in the surrounding code path.
 */
export async function authenticateApiKey(token: string): Promise<AuthenticatedMerchant | null> {
  const keyHash = hashApiKey(token);

  const record = await prisma.merchantApiKey.findUnique({
    where: { keyHash },
    select: { id: true, merchantId: true, revokedAt: true, keyHash: true },
  });

  if (record === null || record.revokedAt !== null) return null;

  const presented = Buffer.from(keyHash, 'utf8');
  const stored = Buffer.from(record.keyHash, 'utf8');
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;

  return { merchantId: record.merchantId, apiKeyId: record.id };
}

/**
 * Fastify preHandler for every /v1/merchant/* route.
 *
 * Registered inside the merchant-routes plugin, so it covers that whole encapsulation
 * context — including POST /v1/merchant/agents/register, which is NOT a special case.
 * A new merchant route added to that plugin is authenticated by default rather than by
 * remembering to opt in.
 */
export async function requireMerchantAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = readBearerToken(request);

  if (token === null) {
    await reply
      .code(401)
      .header('www-authenticate', 'Bearer')
      .send({ error: 'unauthorized', detail: 'missing or malformed Authorization header' });
    return;
  }

  const merchant = await authenticateApiKey(token);

  if (merchant === null) {
    request.log.warn({ path: request.url }, 'merchant auth failed');
    await reply
      .code(401)
      .header('www-authenticate', 'Bearer')
      .send({ error: 'unauthorized', detail: 'invalid or revoked API key' });
    return;
  }

  request.merchant = merchant;

  // Best-effort; a failure here must never break an authenticated request.
  void prisma.merchantApiKey
    .update({ where: { id: merchant.apiKeyId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}

/**
 * Reads the authenticated merchant. Throws rather than returning null: reaching a route
 * body without an authenticated merchant would mean the preHandler was bypassed, which
 * is a wiring bug, not a runtime condition to handle.
 */
export function authenticatedMerchantId(request: FastifyRequest): string {
  const merchant = request.merchant;
  if (merchant === undefined) {
    throw new Error('authenticatedMerchantId called on an unauthenticated request');
  }
  return merchant.merchantId;
}
