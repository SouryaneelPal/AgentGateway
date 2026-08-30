/**
 * Idempotency Engine (§3.3).
 *
 * Agents retry by nature. A network timeout on an x402 retry or an AP2 mandate
 * resubmission must never create a second charge. The key is derived server-side from
 * the *content* of the request, so even an agent that forgets to send an idempotency
 * header cannot double-charge — retries are safe by construction, not by client
 * good behaviour.
 *
 * SCOPE NOTE: this is §3.3, nominally Phase 2 work, but it was left stubbed there
 * because nothing called it yet. Phase 3 cannot create a payment_requests row without
 * it — idempotency_key is NOT NULL UNIQUE in §2.3 — so it is implemented here as a
 * direct dependency of the adapters, exactly as §3.3 specifies and no further.
 */

import { createHash } from 'node:crypto';
import { prisma } from '../db/prisma-client.js';

export interface IdempotencyKeyParts {
  readonly agentIdentityId: string;
  readonly normalizedAmountPaise: bigint;
  readonly mandateNonce: string;
}

/**
 * §3.3, verbatim:
 *   idempotencyKey = sha256(agentIdentityId + normalizedAmountPaise + mandateNonce)
 *
 * Fields are joined with a separator that cannot occur in a UUID or a nonce, so that
 * ("a", 1, "23") and ("a", 12, "3") cannot collide into the same digest.
 */
export function deriveIdempotencyKey(parts: IdempotencyKeyParts): string {
  const material = [
    parts.agentIdentityId,
    parts.normalizedAmountPaise.toString(),
    parts.mandateNonce,
  ].join('|');

  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export type IdempotentLookup =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly paymentRequestId: string;
      readonly status: string;
      readonly rejectionReason: string | null;
    };

/**
 * The fetch half of §3.3's insert-or-fetch. The insert half happens inside the
 * adapter pipeline's own transaction, where it shares a rollback boundary with the
 * mandate row — splitting it out would mean a payment_request could survive a failed
 * mandate insert.
 *
 * A retried request is therefore a SELECT, not a re-INSERT, and correctness is enforced
 * by the payment_requests.idempotency_key unique constraint rather than by application
 * logic alone.
 */
export async function findByIdempotencyKey(idempotencyKey: string): Promise<IdempotentLookup> {
  const existing = await prisma.paymentRequest.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true, rejectionReason: true },
  });

  if (existing === null) return { found: false };

  return {
    found: true,
    paymentRequestId: existing.id,
    status: existing.status,
    rejectionReason: existing.rejectionReason,
  };
}
