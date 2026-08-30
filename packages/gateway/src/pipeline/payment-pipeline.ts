/**
 * The request pipeline shared by every protocol route (Phase 3).
 *
 * Runs the §2.2 adapter contract in order, with the two things that must happen between
 * normalize() and settle():
 *
 *   validate -> normalize -> [persist payment_request + mandate] ->
 *   PolicyEngine.evaluate -> [persist any rejection] -> settle -> formatReceipt
 *
 * WHY THIS IS A PIPELINE AND NOT A CALL INSIDE EACH ADAPTER:
 * the brief asks that "every adapter must call PolicyEngine.evaluate() before calling
 * settle()". Implementing that inside all three adapters would triplicate the ordering,
 * the persistence and the rejection handling, and would leave "did this adapter
 * remember to check policy?" as a convention that a fourth adapter (UAP, §5.2) could
 * silently break. Hoisting it here makes settling without evaluating structurally
 * impossible: settle() is only ever reached through this function, on the approved
 * branch. The guarantee is stronger, not weaker — but it IS a deviation from the
 * literal instruction and is called out as such.
 *
 * PolicyEngine is the sole source of truth for guardrail decisions. Nothing in this
 * file re-derives revocation, protocol enablement, category rules or spend caps.
 */

import type { Prisma } from '../generated/prisma/index.js';
import { prisma } from '../db/prisma-client.js';
import { policyEngine } from '../policy/policy-engine.js';
import { deriveIdempotencyKey, findByIdempotencyKey } from '../idempotency/idempotency-engine.js';
import { releaseNonce, remainingValiditySeconds, reserveNonce } from '../crypto/nonce-guard.js';
import type {
  IncomingRequest,
  ProtocolReceipt,
  RejectionEnvelope,
  RoutableProtocolAdapter,
  SettlementResult,
  ValidationResult,
} from '../adapters/protocol-adapter.interface.js';

/** Maps a pipeline outcome onto an HTTP status without the routes duplicating logic. */
export type PipelineOutcome =
  | {
      readonly kind: 'settled';
      readonly httpStatus: 202;
      readonly paymentRequestId: string;
      readonly result: SettlementResult;
      readonly receipt: ProtocolReceipt;
    }
  | {
      readonly kind: 'rejected';
      readonly httpStatus: 400 | 403 | 409 | 422;
      readonly paymentRequestId: string | null;
      readonly envelope: RejectionEnvelope;
    }
  | {
      readonly kind: 'duplicate';
      readonly httpStatus: 200;
      readonly paymentRequestId: string;
      readonly status: string;
      readonly rejectionReason: string | null;
    };

/** Validation failures are client errors; which 4xx depends on what went wrong. */
function statusForValidationFailure(reason: string): 400 | 403 | 409 | 422 {
  switch (reason) {
    case 'signature_invalid':
    case 'agent_revoked':
      return 403;
    case 'nonce_replayed':
    case 'reference_already_redeemed':
      return 409;
    case 'mandate_expired':
    case 'envelope_mismatch':
      return 422;
    default:
      return 400;
  }
}

function validationEnvelope(
  validated: Extract<ValidationResult, { ok: false }>,
): RejectionEnvelope {
  return {
    error: validated.reason,
    payment_request_id: null,
    detail: validated.detail,
  };
}

/**
 * Persists payment_requests + mandates in ONE transaction.
 *
 * The mandate insert is what enforces §3.2's durable backstop: mandates.nonce is UNIQUE,
 * so a replay that slipped past the Redis fast path fails here and rolls the
 * payment_request back with it. That shared rollback boundary is the reason these two
 * writes cannot be split apart.
 */
async function persistRequestAndMandate(options: {
  merchantId: string;
  agentIdentityId: string;
  protocol: string;
  rawPayload: Prisma.InputJsonValue;
  amountPaise: bigint;
  idempotencyKey: string;
  mandateType: string;
  canonicalPayload: string;
  signature: string;
  nonce: string;
  expiresAt: Date;
}): Promise<{ ok: true; paymentRequestId: string } | { ok: false; reason: 'nonce_replayed' }> {
  try {
    const paymentRequestId = await prisma.$transaction(async (tx) => {
      const paymentRequest = await tx.paymentRequest.create({
        data: {
          merchantId: options.merchantId,
          agentIdentityId: options.agentIdentityId,
          protocol: options.protocol,
          rawPayload: options.rawPayload,
          normalizedAmountPaise: options.amountPaise,
          idempotencyKey: options.idempotencyKey,
          status: 'pending',
        },
        select: { id: true },
      });

      await tx.mandate.create({
        data: {
          paymentRequestId: paymentRequest.id,
          mandateType: options.mandateType,
          canonicalPayload: options.canonicalPayload,
          signature: options.signature,
          verified: true,
          limitPaise: options.amountPaise,
          nonce: options.nonce,
          expiresAt: options.expiresAt,
        },
      });

      return paymentRequest.id;
    });

    return { ok: true, paymentRequestId };
  } catch (error) {
    // P2002 = unique constraint violation. On mandates.nonce or
    // payment_requests.idempotency_key it means the same request already exists:
    // a replay, caught by the database even if Redis never saw it.
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'P2002') return { ok: false, reason: 'nonce_replayed' };
    }
    throw error;
  }
}

/** Persists a guardrail rejection against the real payment_requests row. */
async function persistRejection(paymentRequestId: string, rejectionReason: string): Promise<void> {
  await prisma.paymentRequest.update({
    where: { id: paymentRequestId },
    data: { status: 'rejected', rejectionReason, updatedAt: new Date() },
  });
}

/**
 * Runs one protocol request end to end.
 *
 * @param skipRedisNonceCheck test seam — disables ONLY the Redis fast path so the
 *        Postgres unique constraint can be proven to block a replay on its own (§3.2).
 */
export async function runPaymentPipeline(
  adapter: RoutableProtocolAdapter,
  request: IncomingRequest,
  options: { skipRedisNonceCheck?: boolean } = {},
): Promise<PipelineOutcome> {
  // 1. Protocol-native validation. A hard reject here never touches payment_requests.
  const validated = await adapter.validate(request);

  if (!validated.ok) {
    return {
      kind: 'rejected',
      httpStatus: statusForValidationFailure(validated.reason),
      paymentRequestId: null,
      envelope: validationEnvelope(validated),
    };
  }

  const { claims } = validated;

  // 2. Redis fast-path replay check (§3.2) — before any database write.
  const ttlSeconds = remainingValiditySeconds(claims.expiresAt, request.receivedAt);
  let nonceReserved = false;

  if (options.skipRedisNonceCheck !== true) {
    const reservation = await reserveNonce(claims.nonce, ttlSeconds);

    if (!reservation.reserved && reservation.reason === 'replayed') {
      return {
        kind: 'rejected',
        httpStatus: 409,
        paymentRequestId: null,
        envelope: {
          error: 'nonce_replayed',
          payment_request_id: null,
          detail: { nonce: claims.nonce, caughtBy: 'redis' },
        },
      };
    }

    // 'redis_unavailable' deliberately falls through: the Postgres unique constraint
    // still refuses the duplicate, so a Redis blip degrades performance, not safety.
    nonceReserved = reservation.reserved;
  }

  // 3. Normalize, then derive the §3.3 idempotency key from the normalized content.
  const normalized = await adapter.normalize(validated);
  const amountPaise = BigInt(normalized.amountPaise);
  const idempotencyKey = deriveIdempotencyKey({
    agentIdentityId: normalized.agentIdentityId,
    normalizedAmountPaise: amountPaise,
    mandateNonce: claims.nonce,
  });

  // A retried request is a SELECT, not a re-INSERT (§3.3).
  const existing = await findByIdempotencyKey(idempotencyKey);
  if (existing.found) {
    return {
      kind: 'duplicate',
      httpStatus: 200,
      paymentRequestId: existing.paymentRequestId,
      status: existing.status,
      rejectionReason: existing.rejectionReason,
    };
  }

  // 4. Persist payment_request + mandate together; mandates.nonce UNIQUE is the backstop.
  const persisted = await persistRequestAndMandate({
    merchantId: normalized.merchantId,
    agentIdentityId: normalized.agentIdentityId,
    protocol: normalized.sourceProtocol,
    rawPayload: claims.raw as Prisma.InputJsonValue,
    amountPaise,
    idempotencyKey,
    mandateType: normalized.sourceProtocol === 'ap2' ? 'IntentMandate' : 'x402Envelope',
    canonicalPayload: claims.canonicalPayload,
    signature: claims.signature,
    nonce: claims.nonce,
    expiresAt: claims.expiresAt,
  });

  if (!persisted.ok) {
    return {
      kind: 'rejected',
      httpStatus: 409,
      paymentRequestId: null,
      envelope: {
        error: 'nonce_replayed',
        payment_request_id: null,
        detail: { nonce: claims.nonce, caughtBy: 'postgres_unique_constraint' },
      },
    };
  }

  const paymentRequestId = persisted.paymentRequestId;

  try {
    // 5. Guardrails. PolicyEngine is the only authority here.
    const decision = await policyEngine.evaluate(normalized, paymentRequestId);

    if (decision.outcome === 'rejected') {
      await persistRejection(paymentRequestId, decision.code);

      const envelope: RejectionEnvelope =
        decision.code === 'spend_cap_exceeded'
          ? { ...decision.detail, payment_request_id: paymentRequestId }
          : buildGuardrailEnvelope(decision.code, decision.detail, paymentRequestId, normalized);

      return { kind: 'rejected', httpStatus: 403, paymentRequestId, envelope };
    }

    if (decision.outcome === 'requires_human_approval' && !adapter.settlesViaHumanApproval) {
      // For x402/AP2 this is a stop: the agent must route through the fallback
      // Payment Link path where a human can actually approve.
      await persistRejection(paymentRequestId, 'requires_human_approval');
      return {
        kind: 'rejected',
        httpStatus: 403,
        paymentRequestId,
        envelope: {
          error: 'human_approval_required',
          payment_request_id: paymentRequestId,
          reason: decision.reason,
        },
      };
    }

    // 6. Settle. Reached only on the approved branch.
    const settlementInput = {
      ...normalized,
      metadata: { ...normalized.metadata, paymentRequestId },
    };

    const result = await adapter.settle(settlementInput);
    const receipt = await adapter.formatReceipt(result);

    await prisma.receipt.create({
      data: {
        paymentRequestId,
        protocolShape: receipt.shape as Prisma.InputJsonValue,
      },
    });

    return { kind: 'settled', httpStatus: 202, paymentRequestId, result, receipt };
  } catch (error) {
    // The request row exists but could not be carried through; mark it failed rather
    // than leaving it stuck at 'pending', and free the nonce so a genuine retry works.
    await prisma.paymentRequest
      .update({
        where: { id: paymentRequestId },
        data: { status: 'failed', updatedAt: new Date() },
      })
      .catch(() => undefined);

    if (nonceReserved) await releaseNonce(claims.nonce);
    throw error;
  }
}

function buildGuardrailEnvelope(
  code: 'category_blocked' | 'protocol_disabled' | 'agent_revoked',
  detail: Readonly<Record<string, unknown>>,
  paymentRequestId: string,
  normalized: { agentIdentityId: string; sourceProtocol: string },
): RejectionEnvelope {
  switch (code) {
    case 'agent_revoked':
      return {
        error: 'agent_revoked',
        payment_request_id: paymentRequestId,
        agent_identity_id: normalized.agentIdentityId,
      };
    case 'protocol_disabled':
      return {
        error: 'protocol_disabled',
        payment_request_id: paymentRequestId,
        protocol: normalized.sourceProtocol,
        enabled_protocols: Array.isArray(detail['enabledProtocols'])
          ? (detail['enabledProtocols'] as string[])
          : [],
      };
    case 'category_blocked':
      return {
        error: 'category_blocked',
        payment_request_id: paymentRequestId,
        category: typeof detail['category'] === 'string' ? detail['category'] : 'unknown',
        blocked_categories: Array.isArray(detail['blockedCategories'])
          ? (detail['blockedCategories'] as string[])
          : [],
      };
  }
}
