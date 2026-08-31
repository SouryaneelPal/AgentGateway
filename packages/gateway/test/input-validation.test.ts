/**
 * Input validation and error-shape hardening (Phase 7).
 *
 * Three claims are under test, each of which was a real defect found by probing the
 * running gateway rather than by reading it:
 *
 *   1. Hostile input produces a typed 4xx, never a 500. A null byte in an agent id used
 *      to reach Postgres, raise error 22021 and surface as an unhandled 500.
 *   2. No error response leaks internal detail. That same 500 carried the absolute path
 *      of a source file, the surrounding lines of our own source, and the raw Postgres
 *      error, to an unauthenticated caller.
 *   3. Prisma's parameterization actually holds. This is asserted, not assumed — see the
 *      SQL injection block for what the assertion is and why it is meaningful.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db/prisma-client.js';
import { encryptSecret, parseEncryptionKey } from '../src/crypto/secret-box.js';
import { env } from '../src/config/env.js';

let app: FastifyInstance;
let merchantId: string;

const NUL = String.fromCharCode(0);

beforeAll(async () => {
  app = await buildServer();

  /**
   * A route that fails the way Prisma fails.
   *
   * Testing the 5xx branch needs a request that actually reaches it, and after this
   * pass's fixes no ordinary hostile input does any more — every probe now lands on a
   * typed 4xx. A mutation run proved the point: re-introducing the leak
   * (`message: error.message`) broke nothing, because the leaking branch was never
   * executed by the suite.
   *
   * The message below is a verbatim-shaped copy of the real Prisma error that was being
   * returned to unauthenticated callers, absolute path and all.
   */
  app.get('/test-only/boom', async () => {
    throw new Error(
      'Invalid `prisma.agentIdentity.findFirst()` invocation in\n' +
        '/Users/example/AgentGateway/packages/gateway/src/adapters/ap2.adapter.ts:132:46\n' +
        '  130 }\n→ 132 const agent = await prisma.agentIdentity.findFirst(\n' +
        'Database error. Code: `22021`. Message: `invalid byte sequence`\n' +
        '    at PrismaClient._request (/node_modules/@prisma/client/runtime/library.js:121:15)',
    );
  });

  await app.ready();

  const merchant = await prisma.merchant.create({
    data: {
      name: `validation-test-${randomUUID().slice(0, 8)}`,
      razorpayKeyId: env.RAZORPAY_KEY_ID,
      razorpayKeySecretEncrypted: encryptSecret(
        env.RAZORPAY_KEY_SECRET,
        parseEncryptionKey(env.MERCHANT_SECRET_ENCRYPTION_KEY),
      ),
      enabledProtocols: ['ap2', 'x402', 'fallback'],
    },
    select: { id: true },
  });
  merchantId = merchant.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: merchantId } });
  await prisma.agentIdentity.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await app.close();
});

function mandate(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mandateType: 'IntentMandate',
    agentId: 'validation-agent',
    merchantId,
    maxAmountPaise: 100,
    currency: 'INR',
    expiresAt: '2027-01-01T00:00:00Z',
    nonce: `n_${randomUUID()}`,
    signature: 'AAAA',
    ...overrides,
  });
}

const post = async (url: string, payload: string) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload });

describe('hostile input never produces a 5xx', () => {
  it.each([
    ['oversized identifier', mandate({ agentId: 'A'.repeat(200_000) })],
    ['negative amount', mandate({ maxAmountPaise: -500 })],
    ['zero amount', mandate({ maxAmountPaise: 0 })],
    ['non-integer amount', mandate({ maxAmountPaise: 10.5 })],
    ['amount above the ceiling', mandate({ maxAmountPaise: Number.MAX_SAFE_INTEGER })],
    ['malformed JSON', '{"unterminated":'],
    ['array instead of object', '[1,2,3]'],
    ['JSON null', 'null'],
  ])('%s -> 4xx', async (_label, payload) => {
    const response = await post('/v1/ap2/mandates', payload);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });

  /**
   * These assert the SPECIFIC control-character rejection, not merely "some 4xx".
   *
   * An earlier version of this test only checked for a 4xx, and a mutation run proved it
   * vacuous: with the body-wide hook disabled, a null byte in a field no adapter reads
   * still produced a 400 — as `unknown_agent`, for an unrelated reason — so the test
   * passed while the guard it existed to protect was switched off. Pinning the error
   * identity is what makes these non-vacuous.
   */
  it.each([
    ['a field the adapter reads', mandate({ agentId: `a${NUL}b` })],
    ['a field no adapter reads', mandate({ unreadField: `x${NUL}y` })],
    ['an object key', mandate({ [`key${NUL}`]: 'value' })],
    ['a nested array element', mandate({ items: [{ label: `x${NUL}` }] })],
  ])('rejects a null byte in %s as a control-character error', async (_label, payload) => {
    const response = await post('/v1/ap2/mandates', payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'malformed_request' });
    expect(response.json().message).toMatch(/control characters/i);
  });

  it('rejects a merchantId that is not a UUID rather than letting Postgres raise', async () => {
    // A uuid column cannot compare against arbitrary text: Postgres raises
    // "invalid input syntax for type uuid" and Prisma turns that into a 500. Any caller
    // could trigger it with a one-character merchantId.
    const response = await post(
      '/v1/fallback/payment-links',
      JSON.stringify({ amountPaise: 100, agentId: 'a', merchantId: 'not-a-uuid' }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'malformed_request' });
  });

  it('accepts legitimate unicode — the bounds are not a character allowlist', async () => {
    // Rejecting control characters must not turn into rejecting non-ASCII text. An agent
    // id of "café-日本語-🎉" is unusual but perfectly valid, and it must fail as an
    // UNKNOWN agent, not as a malformed one.
    const response = await post('/v1/ap2/mandates', mandate({ agentId: 'café-日本語-🎉' }));
    expect(response.json()).toMatchObject({ error: 'unknown_agent' });
  });
});

const FORBIDDEN = [
  /\/Users\//, // absolute developer paths
  /node_modules/,
  /\.ts:\d+/, // source file and line
  /Invalid `prisma\./, // raw Prisma invocation text
  /PrismaClient/,
  /\bat\s+\w+\s+\(/, // stack frames
];

describe('error responses do not leak internals', () => {
  it.each([
    ['unknown route', '/v1/does-not-exist'],
    ['malformed JSON', '/v1/ap2/mandates'],
    ['bad merchantId', '/v1/fallback/payment-links'],
  ])('%s leaks nothing', async (label, url) => {
    const response =
      label === 'unknown route'
        ? await app.inject({ method: 'GET', url })
        : await post(
            url,
            label === 'malformed JSON' ? '{"x":' : JSON.stringify({ merchantId: 'x' }),
          );

    const body = response.body;
    for (const pattern of FORBIDDEN) {
      expect(body, `${label} response leaked ${String(pattern)}`).not.toMatch(pattern);
    }
  });

  it('a genuine 500 returns a typed shape and leaks nothing', async () => {
    const response = await app.inject({ method: 'GET', url: '/test-only/boom' });

    expect(response.statusCode).toBe(500);

    // The typed contract callers can rely on.
    expect(response.json()).toMatchObject({ error: 'internal_error' });
    expect(typeof response.json().requestId).toBe('string');

    // None of the underlying detail reaches the caller.
    for (const pattern of FORBIDDEN) {
      expect(response.body, `500 body leaked ${String(pattern)}`).not.toMatch(pattern);
    }
    expect(response.body).not.toMatch(/22021/);
    expect(response.body).not.toMatch(/invalid byte sequence/);
  });

  it('every error body carries a typed error code', async () => {
    const response = await post('/v1/ap2/mandates', mandate({ maxAmountPaise: -1 }));
    expect(typeof response.json().error).toBe('string');
  });
});

/**
 * SQL injection — proven, not assumed.
 *
 * The meaningful assertion is NOT "the server returned 400". A rejected request proves
 * nothing about parameterization; it only proves the request was rejected. What proves
 * parameterization is a round-trip: store an injection-shaped string through Prisma, read
 * it back, and confirm it comes back byte-identical AND that the table it names still
 * exists. A string that survives as data was never interpreted as SQL.
 *
 * The payloads are aimed at the row-locked spend cap in §3.5, which is the one place this
 * codebase uses `$queryRaw` — a tagged template, so its interpolations are parameters
 * rather than concatenated text, but that is exactly the claim worth testing rather than
 * trusting.
 */
describe('Prisma parameterization holds against injection-shaped input', () => {
  const PAYLOADS = [
    "'; DROP TABLE payment_requests; --",
    "' OR '1'='1",
    "1; DELETE FROM merchants WHERE 't'='t",
    "\\'; UPDATE agent_identities SET spending_limit_paise = 999999999; --",
    "'||(SELECT razorpay_key_secret_encrypted FROM merchants LIMIT 1)||'",
  ];

  it.each(PAYLOADS)('stores and returns %j verbatim, as data', async (payload) => {
    const agent = await prisma.agentIdentity.create({
      data: {
        merchantId,
        protocol: 'fallback',
        externalAgentId: payload,
        spendingLimitPaise: 5_000n,
      },
      select: { id: true },
    });

    const readBack = await prisma.agentIdentity.findUnique({
      where: { id: agent.id },
      select: { externalAgentId: true, spendingLimitPaise: true },
    });

    // Byte-identical round-trip: the string was treated as a value throughout.
    expect(readBack?.externalAgentId).toBe(payload);
    // And it did not execute: the UPDATE payload did not raise the spending limit.
    expect(readBack?.spendingLimitPaise).toBe(5_000n);
  });

  it('leaves the tables the payloads name intact', async () => {
    // If any payload had been interpreted, one of these would be gone or empty.
    const [requests, merchants, agents] = await Promise.all([
      prisma.paymentRequest.count(),
      prisma.merchant.count(),
      prisma.agentIdentity.count(),
    ]);
    expect(Number.isInteger(requests)).toBe(true);
    expect(merchants).toBeGreaterThan(0);
    expect(agents).toBeGreaterThan(0);
  });

  it('passes an injection payload through the raw $queryRaw spend-cap path unharmed', async () => {
    // §3.5's spend cap is the only $queryRaw in the codebase. Drive a value through the
    // same tagged-template shape and confirm it is bound as a parameter: a concatenating
    // implementation would raise a syntax error here instead of returning a row.
    const payload = "'; DROP TABLE merchants; --";
    const agent = await prisma.agentIdentity.create({
      data: {
        merchantId,
        protocol: 'fallback',
        externalAgentId: payload,
        spendingLimitPaise: 5_000n,
      },
      select: { id: true },
    });

    const rows = await prisma.$queryRaw<
      { external_agent_id: string }[]
    >`SELECT external_agent_id FROM agent_identities WHERE id = ${agent.id}::uuid AND external_agent_id = ${payload} FOR UPDATE`;

    // A row came back, so the payload was bound as a parameter and matched as text. A
    // concatenating implementation would have raised a syntax error instead.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.external_agent_id).toBe(payload);
    // The table named in the payload is still there.
    await expect(prisma.merchant.count()).resolves.toBeGreaterThan(0);
  });
});
