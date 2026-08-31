/**
 * x402 gateway-facing routes (§2.4) — IMPLEMENTED (Phase 3).
 *
 *   GET  /v1/x402/checkout/:cartId  -> 402 Payment Required + PAYMENT-REQUIRED envelope
 *   POST /v1/x402/checkout/:cartId  -> retried with a PAYMENT-SIGNATURE proof
 *
 * The two halves are the stateless challenge/response x402 is built around: the GET
 * mints a one-time reference, the POST redeems it exactly once (§3.2).
 */

import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db/prisma-client.js';
import { runPaymentPipeline } from '../pipeline/payment-pipeline.js';
import { routeRequest } from '../adapters/protocol-router.js';
import { x402Adapter, X402_PAYMENT_REQUIRED_HEADER } from '../adapters/x402.adapter.js';
import {
  MAX_IDENTIFIER_LENGTH,
  isSafeString,
  isUuid,
  isValidAmountPaise,
  MAX_AMOUNT_PAISE,
} from '../validation.js';
import { sendOutcome, toIncomingRequest } from './route-support.js';

interface CheckoutParams {
  readonly cartId: string;
}

interface CheckoutQuery {
  readonly agentId?: string;
  readonly merchantId?: string;
  readonly amountPaise?: string;
}

/** Demo cart pricing. A real catalogue lookup is ACP/Phase 5 territory, not Phase 3. */
const DEFAULT_CART_AMOUNT_PAISE = 149_900;

export const x402Routes: FastifyPluginAsync = async (app) => {
  /**
   * Issues the 402 challenge. The envelope goes in the PAYMENT-REQUIRED header and the
   * body carries { error, reference }, exactly as §2.4's worked example shows.
   */
  app.get<{ Params: CheckoutParams; Querystring: CheckoutQuery }>(
    '/v1/x402/checkout/:cartId',
    async (request, reply) => {
      const { agentId, merchantId } = request.query;

      if (agentId === undefined || merchantId === undefined) {
        return reply.code(400).send({
          error: 'malformed_request',
          detail: 'agentId and merchantId query parameters are required to mint a challenge',
        });
      }

      // Query and route parameters bypass the body-wide control-character hook in
      // server.ts, which only inspects request.body — so they are checked here.
      if (!isSafeString(agentId) || !isSafeString(request.params.cartId)) {
        return reply.code(400).send({
          error: 'malformed_request',
          detail: `agentId and cartId must be non-empty, at most ${MAX_IDENTIFIER_LENGTH} characters, and free of control characters`,
        });
      }

      // merchantId is a uuid column. Anything else fails inside Postgres rather than
      // returning no rows, which turned a bad query parameter into an HTTP 500.
      if (!isUuid(merchantId)) {
        return reply.code(400).send({
          error: 'malformed_request',
          detail: 'merchantId must be a UUID',
        });
      }

      const agent = await prisma.agentIdentity.findUnique({
        where: {
          merchantId_protocol_externalAgentId: {
            merchantId,
            protocol: 'x402',
            externalAgentId: agentId,
          },
        },
        select: { id: true, revokedAt: true },
      });

      if (agent === null) {
        return reply.code(404).send({ error: 'unknown_agent', agentId });
      }

      // A revoked agent is refused the challenge outright — no point minting a
      // reference the Policy Engine would reject on redemption.
      if (agent.revokedAt !== null) {
        return reply.code(403).send({ error: 'agent_revoked', agent_identity_id: agent.id });
      }

      // An ABSENT amount falls back to the demo cart price. An amount that is PRESENT
      // but nonsensical (negative, non-numeric, above the ceiling) is refused rather
      // than silently replaced with the default — quietly charging a different amount
      // than the caller asked for is the worst available response to a bad amount.
      const rawAmount = request.query.amountPaise;
      let amountPaise = DEFAULT_CART_AMOUNT_PAISE;
      if (rawAmount !== undefined) {
        const parsedAmount = Number(rawAmount);
        if (!isValidAmountPaise(parsedAmount)) {
          return reply.code(400).send({
            error: 'malformed_request',
            detail: `amountPaise must be a positive integer of at most ${MAX_AMOUNT_PAISE}`,
          });
        }
        amountPaise = parsedAmount;
      }

      const envelope = await x402Adapter.issueChallenge({
        cartId: request.params.cartId,
        amountPaise,
        merchantId,
        agentIdentityId: agent.id,
        payTo: `acc_${merchantId.slice(0, 12)}`,
      });

      return reply
        .code(402)
        .header(X402_PAYMENT_REQUIRED_HEADER, JSON.stringify(envelope))
        .send({ error: 'payment_required', reference: envelope.reference });
    },
  );

  /**
   * Redeems the challenge. The proof is validated against the reference the gateway
   * itself issued, and the reference is consumed exactly once (§3.2).
   */
  app.post<{ Params: CheckoutParams }>('/v1/x402/checkout/:cartId', async (request, reply) => {
    const incoming = toIncomingRequest(request);
    const { adapter } = routeRequest(incoming);
    const outcome = await runPaymentPipeline(adapter, incoming);

    if (outcome.kind === 'settled') {
      // On success x402 returns the resource alongside the receipt (§2.4).
      return reply.code(200).send({
        resource: { cartId: request.params.cartId, status: 'released' },
        payment_request_id: outcome.paymentRequestId,
        receipt: outcome.receipt.shape,
      });
    }

    return sendOutcome(reply, outcome);
  });
};
