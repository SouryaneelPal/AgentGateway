/**
 * Fallback gateway-facing route (§2.4) — IMPLEMENTED (Phase 3).
 *
 *   POST /v1/fallback/payment-links -> human-approval Payment Link for non-protocol agents
 */

import type { FastifyPluginAsync } from 'fastify';
import { runPaymentPipeline } from '../pipeline/payment-pipeline.js';
import { fallbackAdapter } from '../adapters/fallback.adapter.js';
import { sendOutcome, toIncomingRequest } from './route-support.js';

export const fallbackRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Generates a Razorpay Payment Link and hands it back for a human tap — one-time
   * consent, not per-transaction blind trust (§2.2).
   *
   * This route pins the fallback adapter explicitly rather than routing, because an
   * agent posting here is asking for the human-approval path by name.
   */
  app.post('/v1/fallback/payment-links', async (request, reply) => {
    const incoming = toIncomingRequest(request);
    const outcome = await runPaymentPipeline(fallbackAdapter, incoming);
    return sendOutcome(reply, outcome);
  });
};
