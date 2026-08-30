/**
 * AP2 gateway-facing routes (§2.4) — IMPLEMENTED (Phase 3).
 *
 *   POST /v1/ap2/mandates      -> submit a signed IntentMandate; 202 + payment_request_id
 *   GET  /v1/ap2/mandates/:id  -> poll settlement status (also pushed via SSE in Phase 5)
 */

import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db/prisma-client.js';
import { runPaymentPipeline } from '../pipeline/payment-pipeline.js';
import { routeRequest } from '../adapters/protocol-router.js';
import { sendOutcome, toIncomingRequest } from './route-support.js';

interface MandateParams {
  readonly id: string;
}

export const ap2Routes: FastifyPluginAsync = async (app) => {
  /**
   * Returns 202 Accepted + payment_request_id when the mandate is valid and passes
   * policy, or a typed rejection (never a generic 500, per §3.5).
   */
  app.post('/v1/ap2/mandates', async (request, reply) => {
    const incoming = toIncomingRequest(request);

    // The router picks the adapter; the route does not hard-code one, so a body posted
    // here that is not an AP2 mandate still degrades to fallback rather than 500ing.
    const { adapter } = routeRequest(incoming);
    const outcome = await runPaymentPipeline(adapter, incoming);

    return sendOutcome(reply, outcome);
  });

  /**
   * Reports current settlement status. 'settled' is only ever reached because a
   * signature-verified webhook said so (§1.3) — never because this adapter said so.
   */
  app.get<{ Params: MandateParams }>('/v1/ap2/mandates/:id', async (request, reply) => {
    const paymentRequest = await prisma.paymentRequest.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        status: true,
        rejectionReason: true,
        normalizedAmountPaise: true,
        normalizedCurrency: true,
        protocol: true,
        createdAt: true,
        updatedAt: true,
        razorpayOrders: {
          select: { razorpayOrderId: true, razorpayPaymentId: true, status: true },
        },
        receipts: { select: { protocolShape: true, issuedAt: true } },
      },
    });

    if (paymentRequest === null) {
      return reply.code(404).send({ error: 'payment_request_not_found', id: request.params.id });
    }

    return reply.code(200).send({
      payment_request_id: paymentRequest.id,
      status: paymentRequest.status,
      rejection_reason: paymentRequest.rejectionReason,
      protocol: paymentRequest.protocol,
      amount_paise: Number(paymentRequest.normalizedAmountPaise),
      currency: paymentRequest.normalizedCurrency,
      razorpay_orders: paymentRequest.razorpayOrders,
      receipts: paymentRequest.receipts,
      created_at: paymentRequest.createdAt.toISOString(),
      updated_at: paymentRequest.updatedAt.toISOString(),
    });
  });
};
