/**
 * Razorpay webhook route (§2.4) — IMPLEMENTED (Phase 2).
 *
 *   POST /webhooks/razorpay -> verifies X-Razorpay-Signature, updates razorpay_orders
 *                              and payment_requests
 *
 * This is the trust boundary. "The protocol layer proposes, but Razorpay's webhook
 * confirms" (§1.3): this route is the ONLY place in the system that may promote a
 * payment_request to 'settled'.
 *
 * RAW BODY HANDLING (§3.4): this plugin removes the inherited application/json parser
 * within its own encapsulation context and installs one that hands the handler an
 * untouched Buffer. JSON.parse never sees this body until AFTER the HMAC has been
 * verified. That is stricter than merely stashing the raw bytes alongside a parsed
 * object, and it means a body that fails verification is never fed to a parser at all.
 */

import type { FastifyPluginAsync } from 'fastify';
import { type Prisma } from '../generated/prisma/index.js';
import { prisma } from '../db/prisma-client.js';
import { env } from '../config/env.js';
import { verifyWebhookSignature } from '../razorpay/webhook-signature.js';
import { createHash } from 'node:crypto';

/** Events that move money in this system. Anything else is stored and acknowledged. */
const SETTLING_EVENTS = new Set(['payment.captured', 'order.paid']);

interface ExtractedEvent {
  readonly eventType: string;
  readonly razorpayOrderId: string | null;
  readonly razorpayPaymentId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** payload.<entityName>.entity — Razorpay's standard webhook envelope. */
function readEntity(payload: unknown, entityName: string): unknown {
  if (!isRecord(payload)) return null;
  const wrapper = payload[entityName];
  if (!isRecord(wrapper)) return null;
  return wrapper['entity'] ?? null;
}

/**
 * Pulls the order/payment ids out of a Razorpay webhook body without trusting its
 * shape. Both payment.captured and order.paid can carry either or both entities.
 */
function extractEvent(body: unknown): ExtractedEvent {
  const eventType = readString(body, 'event') ?? 'unknown';
  const payload = isRecord(body) ? body['payload'] : null;

  const paymentEntity = readEntity(payload, 'payment');
  const orderEntity = readEntity(payload, 'order');

  return {
    eventType,
    razorpayOrderId: readString(paymentEntity, 'order_id') ?? readString(orderEntity, 'id'),
    razorpayPaymentId: readString(paymentEntity, 'id'),
  };
}

/**
 * Razorpay carries the event id in the X-Razorpay-Event-Id header, and
 * webhook_events.razorpay_event_id is NOT NULL + UNIQUE (§2.3). When the header is
 * absent (older deliveries, hand-built test payloads) fall back to a digest of the
 * exact bytes, which still dedupes a byte-identical redelivery.
 */
function resolveEventId(headerValue: unknown, rawBody: Buffer): string {
  if (typeof headerValue === 'string' && headerValue.length > 0) return headerValue;
  return `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
}

/** raw_payload is JSONB NOT NULL, so an unparsable body still has to be storable. */
function toStorablePayload(rawBody: Buffer, parsed: unknown): Prisma.InputJsonValue {
  if (parsed !== undefined) return parsed as Prisma.InputJsonValue;
  return { _unparsable: true, _raw: rawBody.toString('utf8').slice(0, 8_000) };
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // Scope-local parser: replaces the inherited JSON parser for THIS plugin only, so the
  // webhook body reaches the handler as raw bytes and nothing else in the app changes.
  app.removeContentTypeParser(['application/json']);
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      request.rawBody = body;
      done(null, body);
    },
  );

  app.post('/webhooks/razorpay', async (request, reply) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : request.rawBody;
    const signature = request.headers['x-razorpay-signature'];

    if (rawBody === undefined || typeof signature !== 'string') {
      return reply.code(400).send({ error: 'missing_raw_body_or_signature' });
    }

    // Verify BEFORE parsing. An unverified body is untrusted input.
    const signatureValid = verifyWebhookSignature(rawBody, signature, env.RAZORPAY_WEBHOOK_SECRET);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      parsed = undefined;
    }

    const razorpayEventId = resolveEventId(request.headers['x-razorpay-event-id'], rawBody);
    const { eventType, razorpayOrderId, razorpayPaymentId } = extractEvent(parsed);

    // Redelivery guard (§3.4). Razorpay retries on failure with backoff;
    // webhook_events.razorpay_event_id is UNIQUE at the DB level, and this read is the
    // fast path in front of that constraint.
    const existing = await prisma.webhookEvent.findUnique({
      where: { razorpayEventId },
      select: { id: true, signatureValid: true, processedAt: true },
    });

    if (existing !== null) {
      request.log.info({ razorpayEventId }, 'webhook redelivery ignored');
      return reply.code(200).send({
        status: 'duplicate_ignored',
        razorpay_event_id: razorpayEventId,
        processed_at: existing.processedAt?.toISOString() ?? null,
      });
    }

    // Every event is persisted regardless of validity — invalid ones logged and
    // rejected, never silently dropped (§2.4 / §3.4).
    if (!signatureValid) {
      await storeInvalidDelivery(razorpayEventId, eventType, rawBody, parsed);
      request.log.warn({ razorpayEventId, eventType }, 'webhook signature verification FAILED');
      return reply
        .code(400)
        .send({ error: 'invalid_signature', razorpay_event_id: razorpayEventId });
    }

    const result = await prisma.$transaction(async (tx) => {
      const event = await tx.webhookEvent.create({
        data: {
          razorpayEventId,
          eventType,
          signatureValid: true,
          rawPayload: toStorablePayload(rawBody, parsed),
        },
        select: { id: true },
      });

      if (!SETTLING_EVENTS.has(eventType) || razorpayOrderId === null) {
        await tx.webhookEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
        return { settled: false as const, reason: 'not_a_settling_event' as const };
      }

      const order = await tx.razorpayOrder.findUnique({
        where: { razorpayOrderId },
        select: { id: true, paymentRequestId: true },
      });

      if (order === null) {
        await tx.webhookEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
        return { settled: false as const, reason: 'no_matching_order' as const };
      }

      await tx.razorpayOrder.update({
        where: { id: order.id },
        data: {
          status: 'paid',
          ...(razorpayPaymentId === null ? {} : { razorpayPaymentId }),
        },
      });

      await tx.paymentRequest.update({
        where: { id: order.paymentRequestId },
        data: { status: 'settled', updatedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          actorType: 'system',
          actorId: 'razorpay_webhook',
          action: 'webhook_settled',
          paymentRequestId: order.paymentRequestId,
          detail: {
            razorpayEventId,
            eventType,
            razorpayOrderId,
            razorpayPaymentId,
          } satisfies Prisma.InputJsonObject,
        },
      });

      await tx.webhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });

      return {
        settled: true as const,
        paymentRequestId: order.paymentRequestId,
        razorpayOrderId,
      };
    });

    if (result.settled) {
      request.log.info(
        { razorpayEventId, eventType, paymentRequestId: result.paymentRequestId },
        'webhook settled payment request',
      );
      return reply.code(200).send({
        status: 'settled',
        razorpay_event_id: razorpayEventId,
        payment_request_id: result.paymentRequestId,
      });
    }

    request.log.info({ razorpayEventId, eventType, reason: result.reason }, 'webhook acknowledged');
    return reply
      .code(200)
      .send({ status: 'acknowledged', reason: result.reason, razorpay_event_id: razorpayEventId });
  });
};

/**
 * Stores a signature-invalid delivery. Kept outside the success transaction on purpose:
 * the record must survive even though the request is being rejected.
 */
async function storeInvalidDelivery(
  razorpayEventId: string,
  eventType: string,
  rawBody: Buffer,
  parsed: unknown,
): Promise<void> {
  await prisma.webhookEvent.create({
    data: {
      razorpayEventId,
      eventType,
      signatureValid: false,
      rawPayload: toStorablePayload(rawBody, parsed),
      // processed_at stays NULL: received and recorded, deliberately not acted on.
    },
  });
}
