/**
 * An unverified delivery must not be able to claim an event id (Phase 7 regression).
 *
 * THE DEFECT, as originally found and confirmed against the running gateway:
 *
 * The redelivery guard (§3.4) ran BEFORE signature verification, and a delivery that
 * failed verification was still persisted under the razorpay_event_id the caller had
 * supplied. Since that column is UNIQUE and the guard consults it, an unauthenticated
 * caller could:
 *
 *   1. POST /webhooks/razorpay with a garbage signature and a chosen
 *      X-Razorpay-Event-Id  ->  400, but the id is now on record
 *   2. Razorpay later delivers the genuine event with that same id
 *      ->  200 duplicate_ignored, and the settlement is silently dropped
 *
 * The 200 is what makes it stick: Razorpay treats it as delivered and stops retrying, so
 * a paid order strands at awaiting_settlement permanently. It inverts §1.3 — the webhook
 * is the ONLY thing allowed to confirm settlement, so anything that can mute it can
 * prevent settlement from ever being recorded.
 *
 * The fix verifies the signature first, and quarantines invalid deliveries under a
 * namespaced id so the genuine one stays claimable.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db/prisma-client.js';
import { env } from '../src/config/env.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function deliver(body: string, signature: string, eventId: string) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    payload: body,
  });
}

describe('webhook event id cannot be claimed by an unverified caller', () => {
  it('does not let a forged delivery suppress the genuine one', async () => {
    const eventId = `evt_claim_${randomUUID()}`;
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_x', order_id: 'order_x' } } },
    });

    // 1. Attacker reserves the id with an invalid signature.
    const forged = await deliver(body, 'not-a-valid-signature', eventId);
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ error: 'invalid_signature' });

    // 2. The genuine, correctly signed delivery arrives with the same id.
    const signature = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
    const genuine = await deliver(body, signature, eventId);

    // It MUST be processed. Before the fix this returned duplicate_ignored.
    expect(genuine.json()).not.toMatchObject({ status: 'duplicate_ignored' });

    // 3. The invalid delivery is still on record — rejected, never silently dropped
    //    (§2.4 / §3.4) — but under a quarantined id, not the real one.
    const quarantined = await prisma.webhookEvent.findMany({
      where: { razorpayEventId: { startsWith: `invalid:${eventId}:` } },
      select: { signatureValid: true, processedAt: true },
    });
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.signatureValid).toBe(false);
    expect(quarantined[0]?.processedAt).toBeNull();

    // And the genuine id is held by the verified delivery.
    const real = await prisma.webhookEvent.findUnique({
      where: { razorpayEventId: eventId },
      select: { signatureValid: true },
    });
    expect(real?.signatureValid).toBe(true);

    await prisma.webhookEvent.deleteMany({
      where: {
        OR: [
          { razorpayEventId: eventId },
          { razorpayEventId: { startsWith: `invalid:${eventId}:` } },
        ],
      },
    });
  });

  it('a genuine redelivery is still deduplicated', async () => {
    // The guard must keep doing its actual job: Razorpay retries with backoff, and a
    // verified event seen twice must be ignored the second time.
    const eventId = `evt_dedupe_${randomUUID()}`;
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_y', order_id: 'order_y' } } },
    });
    const signature = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');

    const first = await deliver(body, signature, eventId);
    expect(first.statusCode).toBe(200);

    const second = await deliver(body, signature, eventId);
    expect(second.json()).toMatchObject({ status: 'duplicate_ignored' });

    await prisma.webhookEvent.deleteMany({ where: { razorpayEventId: eventId } });
  });

  it('repeating an identical forgery does not error', async () => {
    // The quarantine id is derived from the body, so a replayed identical forgery hits
    // the unique constraint. That is the constraint working, not a failure to surface.
    const eventId = `evt_replay_${randomUUID()}`;
    const body = JSON.stringify({ event: 'payment.captured' });

    const first = await deliver(body, 'bad', eventId);
    const second = await deliver(body, 'bad', eventId);

    expect(first.statusCode).toBe(400);
    expect(second.statusCode).toBe(400);

    await prisma.webhookEvent.deleteMany({
      where: { razorpayEventId: { startsWith: `invalid:${eventId}:` } },
    });
  });
});
