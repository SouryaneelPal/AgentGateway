/**
 * Phase 3 validation suite — protocol adapters end to end (§2.2, §3.1, §3.2, §3.5).
 *
 * Every case here drives the real Fastify app against the real Postgres and Redis. Only
 * the Razorpay SDK is substituted, because a live test-mode call needs credentials this
 * environment does not have; everything else — canonicalization, Ed25519 verification,
 * the Redis nonce guard, the Postgres unique constraint, PolicyEngine, the state
 * machine on payment_requests — is the production code path.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db/prisma-client.js';
import { redis } from '../src/redis/redis-client.js';
import { env } from '../src/config/env.js';
import { canonicalizeForSigning } from '../src/crypto/canonicalize.js';
import { signCanonicalPayload } from '../src/crypto/ed25519-verify.js';
import { signWebhookPayload } from '../src/razorpay/webhook-signature.js';
import { runPaymentPipeline } from '../src/pipeline/payment-pipeline.js';
import { ap2Adapter } from '../src/adapters/ap2.adapter.js';
import { routeRequest, registeredProtocols } from '../src/adapters/protocol-router.js';
import { X402_PAYMENT_SIGNATURE_HEADER } from '../src/adapters/x402.adapter.js';
import type { IncomingRequest } from '../src/adapters/protocol-adapter.interface.js';
import { cleanup, seedAgentWithKey, type SeededAgent } from './helpers/db.js';
import { installFakeRazorpay, type InstalledFakeRazorpay } from './helpers/fake-razorpay.js';

let app: FastifyInstance;
let razorpay: InstalledFakeRazorpay;
const created: SeededAgent[] = [];
const nonces: string[] = [];
const eventIds: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  // Sweep any Redis state the tests created. Both key classes are TTL'd in production,
  // but a test run must not leave residue behind for the next one to trip over.
  for (const pattern of ['nonce:*', 'x402:challenge:*']) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
  await app.close();
});

afterEach(async () => {
  razorpay?.restore();
  if (eventIds.length > 0) {
    await prisma.webhookEvent.deleteMany({ where: { razorpayEventId: { in: eventIds } } });
    eventIds.length = 0;
  }
  for (const nonce of nonces.splice(0)) {
    await redis.del(`nonce:${nonce}`);
  }
  while (created.length > 0) {
    const seeded = created.pop();
    if (seeded !== undefined) await cleanup(seeded);
  }
});

type KeyedAgent = Awaited<ReturnType<typeof seedAgentWithKey>>;

async function seed(options: Parameters<typeof seedAgentWithKey>[0]): Promise<KeyedAgent> {
  razorpay = installFakeRazorpay();
  const agent = await seedAgentWithKey(options);
  created.push(agent);
  return agent;
}

function buildMandate(
  agent: KeyedAgent,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const nonce = String(overrides['nonce'] ?? `n_${randomUUID()}`);
  nonces.push(nonce);

  const body: Record<string, unknown> = {
    mandateType: 'IntentMandate',
    agentId: agent.externalAgentId,
    merchantId: agent.merchantId,
    maxAmountPaise: 50_000,
    currency: 'INR',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...overrides,
    nonce,
  };

  const canonical = canonicalizeForSigning(body);
  body['signature'] = signCanonicalPayload(canonical, agent.privateKeyBase64);
  return body;
}

function postMandate(body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/ap2/mandates',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------

describe('AP2 — signature verification (§3.1)', () => {
  it('accepts a correctly signed mandate and reaches awaiting_settlement', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const response = await postMandate(buildMandate(agent));

    expect(response.statusCode).toBe(202);
    const body = response.json() as { payment_request_id: string; status: string };
    expect(body.status).toBe('awaiting_settlement');

    const row = await prisma.paymentRequest.findUniqueOrThrow({
      where: { id: body.payment_request_id },
    });
    // Critically NOT 'settled' — only the webhook may do that (§1.3).
    expect(row.status).toBe('awaiting_settlement');
    expect(row.protocol).toBe('ap2');
  });

  it('REJECTS A TAMPERED SIGNATURE BEFORE ANY DATABASE WRITE (§3.1 step 4)', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const mandate = buildMandate(agent);

    // Sign honestly, then change the amount — the classic tamper.
    const before = await prisma.paymentRequest.count({
      where: { agentIdentityId: agent.agentIdentityId },
    });
    mandate['maxAmountPaise'] = 1;

    const response = await postMandate(mandate);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'signature_invalid' });

    // The assertion that matters: no payment_requests row was created at all.
    const after = await prisma.paymentRequest.count({
      where: { agentIdentityId: agent.agentIdentityId },
    });
    expect(after).toBe(before);
    expect(after).toBe(0);

    // And no mandate row either.
    expect(await prisma.mandate.count({ where: { nonce: String(mandate['nonce']) } })).toBe(0);

    // §3.1 requires the rejection be logged even though nothing else was written.
    const audit = await prisma.auditLog.findMany({
      where: { actorId: agent.agentIdentityId, action: 'mandate_rejected' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ reason: 'signature_invalid' });
    expect(audit[0]?.paymentRequestId).toBeNull();
  });

  it('rejects a mandate signed by a different agent key, pre-database', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const impostor = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });

    const body = buildMandate(agent);
    const canonical = canonicalizeForSigning({ ...body, signature: undefined });
    body['signature'] = signCanonicalPayload(canonical, impostor.privateKeyBase64);

    const response = await postMandate(body);
    expect(response.statusCode).toBe(403);
    expect(
      await prisma.paymentRequest.count({ where: { agentIdentityId: agent.agentIdentityId } }),
    ).toBe(0);
  });

  it('rejects an expired mandate before any database write', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const response = await postMandate(
      buildMandate(agent, { expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'mandate_expired' });
    expect(
      await prisma.paymentRequest.count({ where: { agentIdentityId: agent.agentIdentityId } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('AP2 — replay protection (§3.2)', () => {
  it('rejects a replayed nonce on the Redis fast path', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const mandate = buildMandate(agent);

    const first = await postMandate(mandate);
    expect(first.statusCode).toBe(202);

    const replay = await postMandate(mandate);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: 'nonce_replayed',
      detail: { caughtBy: 'redis' },
    });

    // Exactly one payment_request survived the replay.
    expect(
      await prisma.paymentRequest.count({ where: { agentIdentityId: agent.agentIdentityId } }),
    ).toBe(1);
  });

  it('an identical replay with Redis disabled is caught by the §3.3 idempotency check', async () => {
    // Documents the real layering. There are THREE guards, in this order:
    //   1. Redis SETNX          (§3.2 fast path)
    //   2. idempotency_key SELECT (§3.3) — a byte-identical replay derives the same key
    //   3. mandates.nonce UNIQUE  (§3.2 durable backstop)
    // With Redis off, an identical replay is stopped by (2) before it can reach (3).
    // That is correct, but it means this case does NOT exercise the DB constraint —
    // the next test is the one that does.
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const mandate = buildMandate(agent);

    const incoming = (): IncomingRequest => ({
      method: 'POST',
      path: '/v1/ap2/mandates',
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from(JSON.stringify(mandate), 'utf8'),
      body: mandate,
      params: {},
      query: {},
      receivedAt: new Date(),
    });

    expect(
      (await runPaymentPipeline(ap2Adapter, incoming(), { skipRedisNonceCheck: true })).kind,
    ).toBe('settled');
    expect(await redis.get(`nonce:${String(mandate['nonce'])}`)).toBeNull();

    const replay = await runPaymentPipeline(ap2Adapter, incoming(), { skipRedisNonceCheck: true });
    expect(replay.kind).toBe('duplicate');

    expect(
      await prisma.paymentRequest.count({ where: { agentIdentityId: agent.agentIdentityId } }),
    ).toBe(1);
  });

  it('MUTATION TEST: with Redis disabled AND idempotency bypassed, mandates.nonce UNIQUE alone blocks the replay', async () => {
    // Mirrors the Phase 2 FOR UPDATE mutation test: strip the outer guards and prove the
    // durable one still holds. The nonce is reused but the amount differs, so the §3.3
    // key — sha256(agentId + amount + nonce) — is DIFFERENT and the idempotency SELECT
    // misses. The insert therefore reaches Postgres, where mandates.nonce UNIQUE is the
    // only thing left standing between a captured mandate and a second execution.
    //
    // This is also a realistic attack: an agent that controls its own key replaying a
    // burnt nonce with a new amount.
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const nonce = `n_${randomUUID()}`;
    nonces.push(nonce);

    const build = (amountPaise: number): IncomingRequest => {
      const body = buildMandate(agent, { nonce, maxAmountPaise: amountPaise });
      return {
        method: 'POST',
        path: '/v1/ap2/mandates',
        headers: { 'content-type': 'application/json' },
        rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
        body,
        params: {},
        query: {},
        receivedAt: new Date(),
      };
    };

    const first = await runPaymentPipeline(ap2Adapter, build(50_000), {
      skipRedisNonceCheck: true,
    });
    expect(first.kind).toBe('settled');

    // Redis genuinely never saw it, so any rejection below cannot be Redis's doing.
    expect(await redis.get(`nonce:${nonce}`)).toBeNull();

    const replay = await runPaymentPipeline(ap2Adapter, build(60_000), {
      skipRedisNonceCheck: true,
    });

    expect(replay.kind).toBe('rejected');
    if (replay.kind === 'rejected') {
      expect(replay.envelope).toMatchObject({
        error: 'nonce_replayed',
        detail: { caughtBy: 'postgres_unique_constraint' },
      });
    }

    // The durable backstop held: one mandate for that nonce, and the rolled-back
    // payment_request did not survive alongside it.
    expect(await prisma.mandate.count({ where: { nonce } })).toBe(1);
    expect(
      await prisma.paymentRequest.count({ where: { agentIdentityId: agent.agentIdentityId } }),
    ).toBe(1);
  });

  it('keeps the mandates.nonce UNIQUE constraint that the backstop depends on', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'mandates' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%nonce%'
    `;
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('Guardrail rejections are persisted against a real payment_requests row', () => {
  it('spend cap breach -> status rejected, rejection_reason set, §3.5 envelope returned', async () => {
    const agent = await seed({ spendingLimitPaise: 10_000n, protocol: 'ap2' });
    const response = await postMandate(buildMandate(agent, { maxAmountPaise: 50_000 }));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: 'spend_cap_exceeded',
      requested: 50_000,
      remaining: 10_000,
    });

    const id = (response.json() as { payment_request_id: string }).payment_request_id;
    const row = await prisma.paymentRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('spend_cap_exceeded');
  });

  it('revoked agent -> status rejected with rejection_reason agent_revoked', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2', revoked: true });
    const response = await postMandate(buildMandate(agent));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'agent_revoked' });

    const id = (response.json() as { payment_request_id: string }).payment_request_id;
    const row = await prisma.paymentRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('agent_revoked');
  });

  it('protocol disabled -> status rejected with rejection_reason protocol_disabled', async () => {
    const agent = await seed({
      spendingLimitPaise: 500_000n,
      protocol: 'ap2',
      enabledProtocols: ['fallback'],
    });
    const response = await postMandate(buildMandate(agent));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'protocol_disabled' });

    const id = (response.json() as { payment_request_id: string }).payment_request_id;
    const row = await prisma.paymentRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('protocol_disabled');
  });

  it('above the auto-approve ceiling -> rejected with requires_human_approval, no order created', async () => {
    const agent = await seed({
      spendingLimitPaise: 500_000n,
      protocol: 'ap2',
      policy: { maxAutoApprovePaise: 10_000 },
    });
    const response = await postMandate(buildMandate(agent, { maxAmountPaise: 50_000 }));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'human_approval_required' });

    const id = (response.json() as { payment_request_id: string }).payment_request_id;
    const row = await prisma.paymentRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('requires_human_approval');

    // §3.5 step 5: no Razorpay call is ever made for a rejected request.
    expect(razorpay.recorded.orders).toHaveLength(0);
  });

  it('never calls Razorpay for any rejected request', async () => {
    const agent = await seed({ spendingLimitPaise: 1_000n, protocol: 'ap2' });
    await postMandate(buildMandate(agent, { maxAmountPaise: 50_000 }));
    expect(razorpay.recorded.orders).toHaveLength(0);
    expect(razorpay.recorded.paymentLinks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('Protocol router (§2.2)', () => {
  function req(overrides: Partial<IncomingRequest>): IncomingRequest {
    return {
      method: 'POST',
      path: '/',
      headers: {},
      rawBody: Buffer.alloc(0),
      body: {},
      params: {},
      query: {},
      receivedAt: new Date(),
      ...overrides,
    };
  }

  it('registers x402, ap2 and fallback, with fallback last', () => {
    expect(registeredProtocols()).toEqual(['x402', 'ap2', 'fallback']);
  });

  it('routes a PAYMENT-SIGNATURE header to x402', () => {
    expect(
      routeRequest(req({ headers: { [X402_PAYMENT_SIGNATURE_HEADER]: '{"reference":"x"}' } }))
        .adapter.protocolName,
    ).toBe('x402');
  });

  it('routes a signed mandate body to ap2', () => {
    expect(
      routeRequest(req({ body: { mandateType: 'IntentMandate', signature: 'sig' } })).adapter
        .protocolName,
    ).toBe('ap2');
  });

  it('falls back for anything unrecognised, rather than failing', () => {
    const decision = routeRequest(req({ body: { something: 'else' } }));
    expect(decision.adapter.protocolName).toBe('fallback');
    expect(decision.viaFallback).toBe(true);
  });

  it('falls back for an empty request', () => {
    expect(routeRequest(req({ body: undefined })).adapter.protocolName).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------

describe('x402 — full challenge/response flow (§2.2, §3.2)', () => {
  async function issueChallenge(agent: KeyedAgent, amountPaise = 50_000) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/x402/checkout/cart_demo_001?agentId=${agent.externalAgentId}&merchantId=${agent.merchantId}&amountPaise=${amountPaise}`,
    });
    return response;
  }

  it('GET returns 402 with a PAYMENT-REQUIRED envelope', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'x402' });
    const response = await issueChallenge(agent);

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ error: 'payment_required' });

    const envelope = JSON.parse(String(response.headers['payment-required'])) as {
      scheme: string;
      amount: number;
      currency: string;
      reference: string;
      expiry: string;
    };
    expect(envelope.scheme).toBe('razorpay-inr');
    expect(envelope.currency).toBe('INR');
    expect(envelope.amount).toBe(50_000);
    expect(envelope.reference).toMatch(/^pr_[0-9a-f]{32}$/);
    nonces.push(envelope.reference);
  });

  it('completes end to end: 402 -> proof -> awaiting_settlement -> webhook -> settled', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'x402' });

    // 1. Challenge
    const challenge = await issueChallenge(agent);
    const envelope = JSON.parse(String(challenge.headers['payment-required'])) as {
      amount: number;
      reference: string;
    };
    nonces.push(envelope.reference);

    // 2. Redeem with a proof bound to that reference
    const proof = JSON.stringify({
      reference: envelope.reference,
      amount: envelope.amount,
      razorpayPaymentId: 'pay_proofstandin',
    });

    const redeemed = await app.inject({
      method: 'POST',
      url: '/v1/x402/checkout/cart_demo_001',
      headers: { 'content-type': 'application/json', [X402_PAYMENT_SIGNATURE_HEADER]: proof },
      payload: JSON.stringify({}),
    });

    expect(redeemed.statusCode).toBe(200);
    const redeemedBody = redeemed.json() as { payment_request_id: string; resource: unknown };
    expect(redeemedBody.resource).toMatchObject({ cartId: 'cart_demo_001', status: 'released' });

    const paymentRequestId = redeemedBody.payment_request_id;

    // 3. The adapter stopped at awaiting_settlement — it did NOT settle (§1.3).
    let row = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } });
    expect(row.status).toBe('awaiting_settlement');

    const order = await prisma.razorpayOrder.findFirstOrThrow({ where: { paymentRequestId } });
    expect(order.status).toBe('created');
    expect(razorpay.recorded.orders).toHaveLength(1);
    expect(razorpay.recorded.orders[0]).toMatchObject({ amount: 50_000, currency: 'INR' });

    // 4. Only now, the webhook settles it.
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);
    const webhookBody = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_x402flow',
            amount: 50_000,
            currency: 'INR',
            status: 'captured',
            order_id: order.razorpayOrderId,
          },
        },
      },
    });

    const webhook = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signWebhookPayload(
          Buffer.from(webhookBody, 'utf8'),
          env.RAZORPAY_WEBHOOK_SECRET,
        ),
        'x-razorpay-event-id': eventId,
      },
      payload: webhookBody,
    });

    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toMatchObject({ status: 'settled' });

    row = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } });
    expect(row.status).toBe('settled');
  });

  it('refuses to redeem the same reference twice (one-time redemption, §3.2)', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'x402' });
    const challenge = await issueChallenge(agent);
    const envelope = JSON.parse(String(challenge.headers['payment-required'])) as {
      amount: number;
      reference: string;
    };
    nonces.push(envelope.reference);

    const proof = JSON.stringify({ reference: envelope.reference, amount: envelope.amount });
    const headers = {
      'content-type': 'application/json',
      [X402_PAYMENT_SIGNATURE_HEADER]: proof,
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/x402/checkout/cart_demo_001',
      headers,
      payload: '{}',
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/x402/checkout/cart_demo_001',
      headers,
      payload: '{}',
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'nonce_replayed' });
    expect(
      await prisma.paymentRequest.count({ where: { agentIdentityId: agent.agentIdentityId } }),
    ).toBe(1);
  });

  it('rejects a proof for a reference the gateway never issued', async () => {
    await seed({ spendingLimitPaise: 500_000n, protocol: 'x402' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/x402/checkout/cart_demo_001',
      headers: {
        'content-type': 'application/json',
        [X402_PAYMENT_SIGNATURE_HEADER]: JSON.stringify({ reference: 'pr_never_issued' }),
      },
      payload: '{}',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'envelope_mismatch' });
  });

  it('rejects a proof that restates a smaller amount than the gateway issued', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'x402' });
    const challenge = await issueChallenge(agent);
    const envelope = JSON.parse(String(challenge.headers['payment-required'])) as {
      reference: string;
    };
    nonces.push(envelope.reference);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/x402/checkout/cart_demo_001',
      headers: {
        'content-type': 'application/json',
        [X402_PAYMENT_SIGNATURE_HEADER]: JSON.stringify({
          reference: envelope.reference,
          amount: 1,
        }),
      },
      payload: '{}',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'envelope_mismatch' });
  });
});

// ---------------------------------------------------------------------------

describe('fallback adapter (§2.2)', () => {
  it('creates a Payment Link and stops at awaiting_settlement', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'fallback' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/fallback/payment-links',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        agentId: `unknown-client-${randomUUID().slice(0, 6)}`,
        merchantId: agent.merchantId,
        amountPaise: 25_000,
      }),
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { payment_link_url: string; payment_request_id: string };
    expect(body.payment_link_url).toMatch(/^https:\/\/rzp\.io\/i\//);

    expect(razorpay.recorded.paymentLinks).toHaveLength(1);
    expect(razorpay.recorded.paymentLinks[0]).toMatchObject({ amount: 25_000, currency: 'INR' });

    const row = await prisma.paymentRequest.findUniqueOrThrow({
      where: { id: body.payment_request_id },
    });
    // Human approval pending — still not settled until the webhook lands.
    expect(row.status).toBe('awaiting_settlement');
    expect(row.protocol).toBe('fallback');
  });

  it('settles through the human-confirmation webhook path (payment_link.paid)', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'fallback' });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/fallback/payment-links',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        agentId: `human-client-${randomUUID().slice(0, 6)}`,
        merchantId: agent.merchantId,
        amountPaise: 25_000,
      }),
    });

    const paymentRequestId = (created.json() as { payment_request_id: string }).payment_request_id;
    expect(
      (await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } })).status,
    ).toBe('awaiting_settlement');

    // The human taps the link; Razorpay sends payment_link.paid. There is NO
    // razorpay_orders row for this path, so settlement has to resolve via the
    // paymentRequestId stamped into the link's notes.
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);
    const body = JSON.stringify({
      entity: 'event',
      event: 'payment_link.paid',
      payload: {
        payment_link: {
          entity: {
            id: 'plink_human',
            status: 'paid',
            reference_id: paymentRequestId,
            notes: { paymentRequestId },
          },
        },
        payment: {
          entity: { id: 'pay_humantap', amount: 25_000, currency: 'INR', status: 'captured' },
        },
      },
    });

    const webhook = await app.inject({
      method: 'POST',
      url: '/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signWebhookPayload(
          Buffer.from(body, 'utf8'),
          env.RAZORPAY_WEBHOOK_SECRET,
        ),
        'x-razorpay-event-id': eventId,
      },
      payload: body,
    });

    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toMatchObject({ status: 'settled' });

    // Only now is it settled — the human tap, confirmed by webhook (§1.3).
    expect(
      (await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } })).status,
    ).toBe('settled');

    const audit = await prisma.auditLog.findMany({
      where: { paymentRequestId, action: 'webhook_settled' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ matchedVia: 'payment_link_notes' });
  });

  it('rejects an unknown merchant instead of inventing one', async () => {
    razorpay = installFakeRazorpay();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/fallback/payment-links',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        agentId: 'someone',
        merchantId: '00000000-0000-0000-0000-000000000000',
        amountPaise: 100,
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'malformed_request' });
  });
});

// ---------------------------------------------------------------------------

describe('Idempotency (§3.3)', () => {
  it('returns the existing request rather than creating a second one', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const mandate = buildMandate(agent);

    const first = await postMandate(mandate);
    expect(first.statusCode).toBe(202);

    // Clear the Redis nonce so the replay reaches the idempotency check rather than
    // being short-circuited by the fast path — this isolates §3.3 from §3.2.
    await redis.del(`nonce:${String(mandate['nonce'])}`);

    const second = await postMandate(mandate);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ idempotent_replay: true });

    expect(
      await prisma.paymentRequest.count({ where: { agentIdentityId: agent.agentIdentityId } }),
    ).toBe(1);
  });
});
