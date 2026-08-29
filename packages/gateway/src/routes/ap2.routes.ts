/**
 * AP2 gateway-facing routes (§2.4). Handlers land in Phase 3.
 *
 *   POST /v1/ap2/mandates      -> submit a signed IntentMandate; 202 + payment_request_id
 *   GET  /v1/ap2/mandates/:id  -> poll settlement status (also pushed via SSE)
 */

import type { FastifyPluginAsync } from 'fastify';
import { NotImplementedError } from '../errors.js';

interface MandateParams {
  readonly id: string;
}

export const ap2Routes: FastifyPluginAsync = async (app) => {
  /**
   * TODO(Phase 3): verify the Ed25519 signature over the canonicalized mandate, check
   * the nonce, run policy, and return 202 Accepted + payment_request_id — or a typed
   * rejection (never a generic 500, per §3.5).
   */
  app.post('/v1/ap2/mandates', async (request) => {
    void request.body;
    throw new NotImplementedError('POST /v1/ap2/mandates', 'Phase 3');
  });

  /**
   * TODO(Phase 3): report current settlement status. Note that 'settled' is only ever
   * reached because a verified webhook said so (§1.3).
   */
  app.get<{ Params: MandateParams }>('/v1/ap2/mandates/:id', async (request) => {
    void request.params.id;
    throw new NotImplementedError('GET /v1/ap2/mandates/:id', 'Phase 3');
  });
};
