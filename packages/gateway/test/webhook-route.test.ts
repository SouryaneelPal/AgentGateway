/**
 * End-to-end tests for POST /webhooks/razorpay (§2.4, §3.4) — Phase 2.
 *
 * These drive a real Fastify instance via app.inject() against the real Postgres, so
 * the scope-local raw-body parser, the HMAC check, the webhook_events write and the
 * razorpay_orders / payment_requests state transitions are all exercised together.
 * Payload shapes mirror Razorpay's actual webhook envelope.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db/prisma-client.js';
import { env } from '../src/config/env.js';
import { signWebhookPayload } from '../src/razorpay/webhook-signature.js';
import { cleanup, seedAgent, seedPaymentRequest, type SeededAgent } from './helpers/db.js';

let app: FastifyInstance;
const created: SeededAgent[] = [];
const eventIds: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  if (eventIds.length > 0) {
    await prisma.webhookEvent.deleteMany({ where: { razorpayEventId: { in: eventIds } } });
    eventIds.length = 0;
  }
  while (created.length > 0) {
    const seeded = created.pop();
    if (seeded !== undefined) await cleanup(seeded);
  }
});

/** A payment_requests row with a razorpay_orders row attached, ready to be settled. */
async function seedOrder(): Promise<{
  seeded: SeededAgent;
  paymentRequestId: string;
  razorpayOrderId: string;
}> {
  const seeded = await seedAgent({ spendingLimitPaise: 1_000_000n });
  created.push(seeded);
  const paymentRequestId = await seedPaymentRequest(seeded, 149_900n);
  const razorpayOrderId = `order_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

  await prisma.razorpayOrder.create({
    data: { paymentRequestId, razorpayOrderId, status: 'created' },
  });

  await prisma.paymentRequest.update({
    where: { id: paymentRequestId },
    data: { status: 'awaiting_settlement' },
  });

  return { seeded, paymentRequestId, razorpayOrderId };
}

function paymentCapturedBody(razorpayOrderId: string, paymentId: string): string {
  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_TESTACCOUNT',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: 'payment',
          amount: 149_900,
          currency: 'INR',
          status: 'captured',
          order_id: razorpayOrderId,
          method: 'upi',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}

function post(body: string, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
}

function signedHeaders(body: string, eventId: string): Record<string, string> {
  eventIds.push(eventId);
  return {
    'x-razorpay-signature': signWebhookPayload(
      Buffer.from(body, 'utf8'),
      env.RAZORPAY_WEBHOOK_SECRET,
    ),
    'x-razorpay-event-id': eventId,
  };
}

describe('POST /webhooks/razorpay — valid signature', () => {
  it('settles the payment request and updates the razorpay order', async () => {
    const { paymentRequestId, razorpayOrderId } = await seedOrder();
    const paymentId = `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const body = paymentCapturedBody(razorpayOrderId, paymentId);
    const eventId = `evt_${randomUUID()}`;

    const response = await post(body, signedHeaders(body, eventId));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'settled',
      payment_request_id: paymentRequestId,
    });

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { razorpayEventId: eventId },
    });
    expect(event.signatureValid).toBe(true);
    expect(event.eventType).toBe('payment.captured');
    expect(event.processedAt).not.toBeNull();

    const order = await prisma.razorpayOrder.findUniqueOrThrow({ where: { razorpayOrderId } });
    expect(order.status).toBe('paid');
    expect(order.razorpayPaymentId).toBe(paymentId);

    const paymentRequest = await prisma.paymentRequest.findUniqueOrThrow({
      where: { id: paymentRequestId },
    });
    expect(paymentRequest.status).toBe('settled');

    const audit = await prisma.auditLog.findMany({
      where: { paymentRequestId, action: 'webhook_settled' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorType).toBe('system');
  });

  it('stores and acknowledges a non-settling event without changing state', async () => {
    const { paymentRequestId } = await seedOrder();
    const body = JSON.stringify({ entity: 'event', event: 'payment.failed', payload: {} });
    const eventId = `evt_${randomUUID()}`;

    const response = await post(body, signedHeaders(body, eventId));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'acknowledged' });

    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { razorpayEventId: eventId },
    });
    expect(event.signatureValid).toBe(true);
    expect(event.eventType).toBe('payment.failed');

    const paymentRequest = await prisma.paymentRequest.findUniqueOrThrow({
      where: { id: paymentRequestId },
    });
    expect(paymentRequest.status).toBe('awaiting_settlement');
  });
});

describe('POST /webhooks/razorpay — tampered signature (§3.4)', () => {
  it('rejects with 400 and still records the event with signature_valid = false', async () => {
    const { paymentRequestId, razorpayOrderId } = await seedOrder();
    const body = paymentCapturedBody(razorpayOrderId, 'pay_tampered');
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);

    const good = signWebhookPayload(Buffer.from(body, 'utf8'), env.RAZORPAY_WEBHOOK_SECRET);
    const tampered = `${good.slice(0, -1)}${good.endsWith('a') ? 'b' : 'a'}`;

    const response = await post(body, {
      'x-razorpay-signature': tampered,
      'x-razorpay-event-id': eventId,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_signature' });

    // Logged and rejected, never silently dropped.
    const event = await prisma.webhookEvent.findUniqueOrThrow({
      where: { razorpayEventId: eventId },
    });
    expect(event.signatureValid).toBe(false);
    expect(event.processedAt).toBeNull();

    // No state change whatsoever.
    const order = await prisma.razorpayOrder.findUniqueOrThrow({ where: { razorpayOrderId } });
    expect(order.status).toBe('created');
    const paymentRequest = await prisma.paymentRequest.findUniqueOrThrow({
      where: { id: paymentRequestId },
    });
    expect(paymentRequest.status).toBe('awaiting_settlement');
    expect(await prisma.auditLog.count({ where: { paymentRequestId } })).toBe(0);
  });

  it('rejects a body whose bytes changed after signing', async () => {
    const { razorpayOrderId } = await seedOrder();
    const signedBody = paymentCapturedBody(razorpayOrderId, 'pay_original');
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);

    const signature = signWebhookPayload(
      Buffer.from(signedBody, 'utf8'),
      env.RAZORPAY_WEBHOOK_SECRET,
    );
    const alteredBody = signedBody.replace('149900', '9900');

    const response = await post(alteredBody, {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    });

    expect(response.statusCode).toBe(400);
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { razorpayEventId: eventId } }))
        .signatureValid,
    ).toBe(false);
  });

  it('rejects a request with no signature header at all', async () => {
    const response = await post(JSON.stringify({ event: 'payment.captured' }), {});
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'missing_raw_body_or_signature' });
  });
});

describe('POST /webhooks/razorpay — redelivery guard (§3.4)', () => {
  it('processes a repeated event exactly once', async () => {
    const { paymentRequestId, razorpayOrderId } = await seedOrder();
    const paymentId = `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const body = paymentCapturedBody(razorpayOrderId, paymentId);
    const eventId = `evt_${randomUUID()}`;
    const headers = signedHeaders(body, eventId);

    const first = await post(body, headers);
    const second = await post(body, headers);
    const third = await post(body, headers);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'settled' });

    // Razorpay's retry backoff must be acknowledged, not reprocessed.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'duplicate_ignored' });
    expect(third.json()).toMatchObject({ status: 'duplicate_ignored' });

    expect(await prisma.webhookEvent.count({ where: { razorpayEventId: eventId } })).toBe(1);
    // Exactly one audit row — no double-write to the settlement trail.
    expect(
      await prisma.auditLog.count({ where: { paymentRequestId, action: 'webhook_settled' } }),
    ).toBe(1);
  });

  it('dedupes byte-identical redeliveries that carry no event-id header', async () => {
    const { razorpayOrderId } = await seedOrder();
    const body = paymentCapturedBody(razorpayOrderId, 'pay_noheader');
    const signature = signWebhookPayload(Buffer.from(body, 'utf8'), env.RAZORPAY_WEBHOOK_SECRET);

    const first = await post(body, { 'x-razorpay-signature': signature });
    const second = await post(body, { 'x-razorpay-signature': signature });

    const firstId = (first.json() as { razorpay_event_id: string }).razorpay_event_id;
    eventIds.push(firstId);

    expect(firstId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.json()).toMatchObject({ status: 'settled' });
    expect(second.json()).toMatchObject({ status: 'duplicate_ignored' });
  });
});

describe('POST /webhooks/razorpay — unmatched order', () => {
  it('records the event and acknowledges when no razorpay_orders row matches', async () => {
    const body = paymentCapturedBody('order_doesnotexist', 'pay_orphan');
    const eventId = `evt_${randomUUID()}`;

    const response = await post(body, signedHeaders(body, eventId));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'acknowledged', reason: 'no_matching_order' });
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { razorpayEventId: eventId } }))
        .signatureValid,
    ).toBe(true);
  });
});
