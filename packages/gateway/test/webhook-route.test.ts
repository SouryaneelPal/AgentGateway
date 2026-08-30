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

describe('POST /webhooks/razorpay — idempotent settlement (settlement-application layer)', () => {
  /**
   * Replays the EXACT three-event sequence observed live on 2026-08-30: one ₹1
   * netbanking payment against a Payment Link produced payment.captured, order.paid
   * and payment_link.paid — three legitimate events, three distinct Razorpay event ids,
   * one payment. Before the guard, each settled the request independently and left
   * three webhook_settled rows in audit_log for a single settlement.
   *
   * This is NOT the razorpay_event_id replay guard (covered above). Distinct event ids
   * mean the delivery-deduplication layer correctly lets all three through; the
   * settlement-application layer is what must collapse them into one settlement.
   */
  function eventBody(event: string, paymentRequestId: string, paymentId: string): string {
    return JSON.stringify({
      entity: 'event',
      event,
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount: 100,
            currency: 'INR',
            status: 'captured',
            method: 'netbanking',
            notes: { paymentRequestId },
          },
        },
        payment_link: {
          entity: {
            id: 'plink_TEST',
            status: 'paid',
            reference_id: paymentRequestId,
            notes: { paymentRequestId },
          },
        },
      },
    });
  }

  it('collapses payment.captured + order.paid + payment_link.paid into ONE settlement', async () => {
    const seeded = await seedAgent({ spendingLimitPaise: 500_000n });
    created.push(seeded);
    const paymentRequestId = await seedPaymentRequest(seeded, 100n);
    await prisma.paymentRequest.update({
      where: { id: paymentRequestId },
      data: { status: 'awaiting_settlement' },
    });

    const paymentId = `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const sequence = ['payment.captured', 'order.paid', 'payment_link.paid'] as const;
    const responses = [];

    for (const event of sequence) {
      const body = eventBody(event, paymentRequestId, paymentId);
      const eventId = `evt_${randomUUID()}`; // distinct id per event, as Razorpay sends
      eventIds.push(eventId);
      responses.push(await post(body, signedHeaders(body, eventId)));
    }

    // All three acknowledged with 200 — none rejected. Razorpay is behaving normally.
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }

    // The first settles; the next two report the distinguishable already_settled branch.
    expect(responses[0]?.json()).toMatchObject({
      status: 'settled',
      payment_request_id: paymentRequestId,
    });
    expect(responses[1]?.json()).toMatchObject({
      status: 'already_settled',
      reason: 'duplicate_settling_event',
      payment_request_id: paymentRequestId,
    });
    expect(responses[2]?.json()).toMatchObject({
      status: 'already_settled',
      reason: 'duplicate_settling_event',
    });

    // EXACTLY ONE audit row for the settlement — the defect this guard fixes.
    const audit = await prisma.auditLog.findMany({
      where: { paymentRequestId, action: 'webhook_settled' },
    });
    expect(audit).toHaveLength(1);

    // Status transitioned exactly once, and stayed settled.
    const row = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } });
    expect(row.status).toBe('settled');

    // All three deliveries were still stored and processed — nothing was dropped.
    const stored = await prisma.webhookEvent.findMany({
      where: { razorpayEventId: { in: eventIds } },
      select: { eventType: true, signatureValid: true, processedAt: true },
    });
    expect(stored).toHaveLength(3);
    for (const event of stored) {
      expect(event.signatureValid).toBe(true);
      expect(event.processedAt).not.toBeNull();
    }
    expect(stored.map((e) => e.eventType).sort()).toEqual([
      'order.paid',
      'payment.captured',
      'payment_link.paid',
    ]);
  });

  it('still settles normally when only one settling event arrives', async () => {
    // Guards against the fix over-correcting into "never settle anything".
    const seeded = await seedAgent({ spendingLimitPaise: 500_000n });
    created.push(seeded);
    const paymentRequestId = await seedPaymentRequest(seeded, 100n);
    await prisma.paymentRequest.update({
      where: { id: paymentRequestId },
      data: { status: 'awaiting_settlement' },
    });

    const body = eventBody('payment.captured', paymentRequestId, 'pay_single');
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);

    const response = await post(body, signedHeaders(body, eventId));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'settled' });
    expect(
      (await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } })).status,
    ).toBe('settled');
    expect(
      await prisma.auditLog.count({ where: { paymentRequestId, action: 'webhook_settled' } }),
    ).toBe(1);
  });

  it('keeps the two guards distinct: a true redelivery is duplicate_ignored, not already_settled', async () => {
    const seeded = await seedAgent({ spendingLimitPaise: 500_000n });
    created.push(seeded);
    const paymentRequestId = await seedPaymentRequest(seeded, 100n);
    await prisma.paymentRequest.update({
      where: { id: paymentRequestId },
      data: { status: 'awaiting_settlement' },
    });

    const body = eventBody('payment.captured', paymentRequestId, 'pay_redelivery');
    const eventId = `evt_${randomUUID()}`;
    eventIds.push(eventId);
    const headers = signedHeaders(body, eventId);

    const first = await post(body, headers);
    // SAME event id => delivery-deduplication layer, not the settlement layer.
    const redelivery = await post(body, headers);

    expect(first.json()).toMatchObject({ status: 'settled' });
    expect(redelivery.json()).toMatchObject({ status: 'duplicate_ignored' });
    expect(redelivery.json()).not.toMatchObject({ status: 'already_settled' });
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
