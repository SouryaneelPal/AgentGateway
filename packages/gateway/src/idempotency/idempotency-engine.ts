/**
 * Idempotency Engine (§3.3) — Phase 2 scope, scaffolded here.
 *
 * Agents retry by nature. A network timeout on an x402 retry or an AP2 mandate
 * resubmission must never create a second charge. The key is derived server-side from
 * the *content* of the request, so even an agent that forgets to send an idempotency
 * header cannot double-charge — retries are safe by construction, not by client
 * good behaviour.
 */

import { NotImplementedError } from '../errors.js';

export interface IdempotencyKeyParts {
  readonly agentIdentityId: string;
  readonly normalizedAmountPaise: bigint;
  readonly mandateNonce: string;
}

/**
 * TODO(Phase 2): idempotencyKey = sha256(agentIdentityId + normalizedAmountPaise + mandateNonce)
 * exactly as specified in §3.3.
 */
export function deriveIdempotencyKey(parts: IdempotencyKeyParts): string {
  void parts;
  throw new NotImplementedError('deriveIdempotencyKey', 'Phase 2');
}

export type IdempotentInsert =
  | { readonly created: true; readonly paymentRequestId: string }
  | { readonly created: false; readonly paymentRequestId: string; readonly status: string };

/**
 * TODO(Phase 2): insert-or-fetch against the payment_requests.idempotency_key unique
 * constraint —
 *
 *   INSERT INTO payment_requests (..., idempotency_key)
 *   VALUES (..., $idempotencyKey)
 *   ON CONFLICT (idempotency_key) DO NOTHING
 *   RETURNING *;
 *   -- if no row returned, SELECT the existing row and return its current status
 *   --    instead of re-processing
 */
export async function insertOrFetch(idempotencyKey: string): Promise<IdempotentInsert> {
  void idempotencyKey;
  throw new NotImplementedError('insertOrFetch', 'Phase 2');
}
