/**
 * x402 gateway-facing routes (§2.4). Handlers land in Phase 3.
 *
 *   GET  /v1/x402/checkout/:cartId  -> 402 Payment Required + PAYMENT-REQUIRED envelope
 *   POST /v1/x402/checkout/:cartId  -> retried with PAYMENT-SIGNATURE proof
 */

import type { FastifyPluginAsync } from 'fastify';
import { NotImplementedError } from '../errors.js';

interface CheckoutParams {
  readonly cartId: string;
}

export const x402Routes: FastifyPluginAsync = async (app) => {
  /**
   * TODO(Phase 3): issue the 402 challenge. Response carries a PAYMENT-REQUIRED header
   * holding the envelope, and a body of { error: 'payment_required', reference }.
   * The reference is one-time and gateway-generated, so a proof can only be redeemed
   * against the reference it was issued for, and only once (§3.2).
   */
  app.get<{ Params: CheckoutParams }>('/v1/x402/checkout/:cartId', async (request) => {
    void request.params.cartId;
    throw new NotImplementedError('GET /v1/x402/checkout/:cartId', 'Phase 3');
  });

  /**
   * TODO(Phase 3): validate the PAYMENT-SIGNATURE header against the originally issued
   * envelope, then return the resource plus a protocol-shaped receipt.
   */
  app.post<{ Params: CheckoutParams }>('/v1/x402/checkout/:cartId', async (request) => {
    void request.params.cartId;
    throw new NotImplementedError('POST /v1/x402/checkout/:cartId', 'Phase 3');
  });
};
