/**
 * Route-level glue shared by the protocol routes (Phase 3).
 *
 * Turns a Fastify request into the protocol-agnostic IncomingRequest from §2.2, and
 * turns a PipelineOutcome back into an HTTP response. Keeping this here means each
 * route file is only responsible for its own protocol's URL surface.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingRequest } from '../adapters/protocol-adapter.interface.js';
import type { PipelineOutcome } from '../pipeline/payment-pipeline.js';

export function toIncomingRequest(request: FastifyRequest): IncomingRequest {
  return {
    method: request.method,
    path: request.url,
    headers: request.headers,
    rawBody: request.rawBody ?? Buffer.alloc(0),
    body: request.body,
    params: (request.params ?? {}) as Record<string, string>,
    query: (request.query ?? {}) as Record<string, string | string[] | undefined>,
    receivedAt: new Date(),
  };
}

/**
 * One place that decides how a pipeline outcome looks on the wire, so an AP2 rejection
 * and an x402 rejection cannot drift into different shapes.
 */
export function sendOutcome(reply: FastifyReply, outcome: PipelineOutcome): FastifyReply {
  switch (outcome.kind) {
    case 'settled':
      return reply.code(outcome.httpStatus).send({
        status: outcome.result.status,
        payment_request_id: outcome.paymentRequestId,
        razorpay_order_id: outcome.result.razorpayOrderId,
        payment_link_url: outcome.result.paymentLinkUrl,
        receipt: outcome.receipt.shape,
      });

    case 'duplicate':
      // §3.3: a retry is a SELECT, not a re-INSERT. Report the existing state.
      return reply.code(outcome.httpStatus).send({
        status: outcome.status,
        payment_request_id: outcome.paymentRequestId,
        rejection_reason: outcome.rejectionReason,
        idempotent_replay: true,
      });

    case 'rejected':
      return reply.code(outcome.httpStatus).send(outcome.envelope);
  }
}
