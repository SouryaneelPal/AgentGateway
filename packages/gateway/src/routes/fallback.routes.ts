/**
 * Fallback gateway-facing route (§2.4). Handler lands in Phase 3.
 *
 *   POST /v1/fallback/payment-links -> human-approval Payment Link for non-protocol agents
 */

import type { FastifyPluginAsync } from 'fastify';
import { NotImplementedError } from '../errors.js';

export const fallbackRoutes: FastifyPluginAsync = async (app) => {
  /**
   * TODO(Phase 3): generate a Razorpay Payment Link and hand it back into the
   * conversation for a human tap — one-time consent, not per-transaction blind trust.
   */
  app.post('/v1/fallback/payment-links', async (request) => {
    void request.body;
    throw new NotImplementedError('POST /v1/fallback/payment-links', 'Phase 3');
  });
};
