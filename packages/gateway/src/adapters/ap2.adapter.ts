/**
 * ap2Adapter (§2.2) — IMPLEMENTED (Phase 3).
 *
 * Verifies Ed25519 signatures over the canonicalized IntentMandate payload using the
 * agent's registered public key (§3.1), and enforces nonce uniqueness on both the Redis
 * fast path and the Postgres unique constraint (§3.2).
 *
 * validate() performs NO write to payment_requests or mandates. A tampered signature is
 * a hard reject that never reaches the Policy Engine and never touches Razorpay (§3.1
 * step 4) — the only write it makes is the audit_log row that §3.1 explicitly requires.
 */

import { prisma } from '../db/prisma-client.js';
import { policyEngine } from '../policy/policy-engine.js';
import { canonicalizeForSigning, CanonicalizationError } from '../crypto/canonicalize.js';
import { verifyMandateSignature } from '../crypto/ed25519-verify.js';
import { auditMandateRejected } from './adapter-support.js';
import type {
  IncomingRequest,
  NormalizedPaymentRequest,
  ProtocolReceipt,
  RoutableProtocolAdapter,
  SettlementResult,
  ValidationFailureReason,
  ValidationResult,
} from './protocol-adapter.interface.js';
import { createRazorpayOrderFor, isRecord, readNumber, readString } from './adapter-support.js';
import { MAX_NONCE_LENGTH, MAX_SIGNATURE_LENGTH, isValidAmountPaise } from '../validation.js';

/** The IntentMandate body shape from §2.4's worked example. */
interface IntentMandateBody {
  readonly mandateType: string;
  readonly agentId: string;
  readonly merchantId: string;
  readonly maxAmountPaise: number;
  readonly currency: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly signature: string;
}

function parseMandate(body: unknown): IntentMandateBody | null {
  if (!isRecord(body)) return null;

  // Per-field bounds. Everything here is attacker-controlled: these values are
  // canonicalized, hashed, used as database lookup keys and written to audit rows, so an
  // unbounded string is carried a long way before anything objects to it.
  const mandateType = readString(body, 'mandateType');
  const agentId = readString(body, 'agentId');
  const merchantId = readString(body, 'merchantId');
  const currency = readString(body, 'currency') ?? 'INR';
  const expiresAt = readString(body, 'expiresAt');
  const nonce = readString(body, 'nonce', MAX_NONCE_LENGTH);
  const signature = readString(body, 'signature', MAX_SIGNATURE_LENGTH);
  const maxAmountPaise = readNumber(body, 'maxAmountPaise');

  if (
    mandateType === null ||
    agentId === null ||
    merchantId === null ||
    expiresAt === null ||
    nonce === null ||
    signature === null ||
    maxAmountPaise === null
  ) {
    return null;
  }

  return {
    mandateType,
    agentId,
    merchantId,
    maxAmountPaise,
    currency,
    expiresAt,
    nonce,
    signature,
  };
}

export class Ap2Adapter implements RoutableProtocolAdapter {
  readonly protocolName = 'ap2' as const;

  /** AP2 settles machine-to-machine; a human-approval outcome is a stop, not the route. */
  readonly settlesViaHumanApproval = false;

  /**
   * Detection is shape-based, per §2.2: a JSON body carrying a mandateType and a
   * detached signature is an AP2 submission. No route or URL knowledge is used, so the
   * same rule works wherever the request arrives.
   */
  matches(request: IncomingRequest): boolean {
    if (!isRecord(request.body)) return false;
    return (
      readString(request.body, 'mandateType') !== null &&
      readString(request.body, 'signature', MAX_SIGNATURE_LENGTH) !== null
    );
  }

  /**
   * §3.1 + §3.2, in order:
   *   1. structural parse
   *   2. resolve the agent identity and its registered public key
   *   3. recompute the canonical form server-side and verify the Ed25519 signature
   *   4. reject an expired mandate
   *
   * Nonce reservation is NOT done here — it belongs with the database write so the
   * reservation and the mandate row share a rollback boundary. See payment-pipeline.ts.
   */
  async validate(rawRequest: IncomingRequest): Promise<ValidationResult> {
    const mandate = parseMandate(rawRequest.body);

    if (mandate === null) {
      return this.reject('malformed_request', {
        reason: 'body is not a well-formed IntentMandate',
      });
    }

    if (mandate.mandateType !== 'IntentMandate') {
      return this.reject('malformed_request', { mandateType: mandate.mandateType });
    }

    if (mandate.currency !== 'INR') {
      return this.reject('malformed_request', { currency: mandate.currency });
    }

    // Upper bound as well as lower. Without a ceiling, a mandate for Number.MAX_SAFE_INTEGER
    // paise passes the "positive integer" check and is only refused later by the spend cap
    // or by Razorpay — a refusal that costs a database transaction and an outbound API call
    // to reach a conclusion available for free here.
    if (!isValidAmountPaise(mandate.maxAmountPaise)) {
      return this.reject('malformed_request', { maxAmountPaise: mandate.maxAmountPaise });
    }

    const expiresAt = new Date(mandate.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      return this.reject('malformed_request', { expiresAt: mandate.expiresAt });
    }

    const agent = await prisma.agentIdentity.findFirst({
      where: { protocol: 'ap2', externalAgentId: mandate.agentId },
      select: { id: true, publicKey: true, merchantId: true, revokedAt: true },
    });

    if (agent === null) {
      return this.reject('unknown_agent', { agentId: mandate.agentId });
    }

    if (agent.publicKey === null || agent.publicKey.length === 0) {
      return this.reject('unknown_agent', {
        agentId: mandate.agentId,
        reason: 'no Ed25519 public key registered for this agent',
      });
    }

    // Recompute the canonical form server-side (§3.1 step 3) — never trust the bytes
    // the agent claims it signed.
    let canonicalPayload: string;
    try {
      canonicalPayload = canonicalizeForSigning(mandate as unknown as Record<string, unknown>);
    } catch (error) {
      if (error instanceof CanonicalizationError) {
        return this.reject('malformed_request', { reason: error.message });
      }
      throw error;
    }

    const signatureValid = verifyMandateSignature({
      canonicalPayload,
      signature: mandate.signature,
      publicKey: agent.publicKey,
    });

    if (!signatureValid) {
      // §3.1 step 4: hard reject, logged to audit_log, never reaches the Policy Engine.
      await auditMandateRejected(agent.id, 'signature_invalid', {
        agentId: mandate.agentId,
        nonce: mandate.nonce,
      });
      return this.reject('signature_invalid', { agentId: mandate.agentId });
    }

    if (expiresAt.getTime() <= rawRequest.receivedAt.getTime()) {
      await auditMandateRejected(agent.id, 'mandate_expired', {
        expiresAt: mandate.expiresAt,
        receivedAt: rawRequest.receivedAt.toISOString(),
      });
      return this.reject('mandate_expired', { expiresAt: mandate.expiresAt });
    }

    return {
      ok: true,
      protocol: this.protocolName,
      request: rawRequest,
      claims: {
        merchantId: agent.merchantId,
        agentIdentityId: agent.id,
        amountPaise: mandate.maxAmountPaise,
        nonce: mandate.nonce,
        expiresAt,
        canonicalPayload,
        signature: mandate.signature,
        raw: { ...(mandate as unknown as Record<string, unknown>) },
      },
    };
  }

  /**
   * §2.2: maps IntentMandate.maxAmount / .merchantId / .expiresAt into the shared shape,
   * "flagging requiresHumanApproval = true if the mandate amount exceeds the merchant's
   * auto-approve ceiling". The ceiling comes from PolicyEngine so the flag and the
   * guardrail cannot disagree.
   */
  async normalize(validated: ValidationResult): Promise<NormalizedPaymentRequest> {
    if (!validated.ok) {
      throw new Error('normalize() called with a failed ValidationResult');
    }

    const { claims } = validated;
    const requiresHumanApproval = await policyEngine.exceedsAutoApproveCeiling(
      claims.agentIdentityId,
      claims.amountPaise,
    );

    return {
      merchantId: claims.merchantId,
      agentIdentityId: claims.agentIdentityId,
      amountPaise: claims.amountPaise,
      currency: 'INR',
      idempotencyKey: '', // derived by the pipeline from §3.3's formula
      sourceProtocol: 'ap2',
      requiresHumanApproval,
      metadata: { ...claims.raw },
    };
  }

  /**
   * Creates a Razorpay Order. Deliberately returns 'awaiting_settlement' and never
   * 'settled': only a signature-verified webhook may promote a request to settled
   * (§1.3). settle() marking anything paid would break the trust boundary.
   */
  async settle(normalized: NormalizedPaymentRequest): Promise<SettlementResult> {
    return createRazorpayOrderFor(normalized);
  }

  /**
   * §2.2: "on capture, constructs a PaymentMandate/PaymentReceipt-shaped object per
   * AP2's object model". The receipt is emitted at awaiting-settlement time carrying
   * the current state; the webhook is what later flips it to captured.
   */
  async formatReceipt(result: SettlementResult): Promise<ProtocolReceipt> {
    return {
      protocol: 'ap2',
      paymentRequestId: result.paymentRequestId,
      shape: {
        mandateType: 'PaymentMandate',
        paymentRequestId: result.paymentRequestId,
        status: result.status,
        amountPaise: result.amountPaise,
        currency: result.currency,
        razorpayOrderId: result.razorpayOrderId,
        razorpayPaymentId: result.razorpayPaymentId,
        settlementRail: 'razorpay-orders',
      },
      issuedAt: new Date(),
    };
  }

  private reject(
    reason: ValidationFailureReason,
    detail: Record<string, unknown>,
  ): ValidationResult {
    return { ok: false, protocol: this.protocolName, reason, detail };
  }
}

export const ap2Adapter = new Ap2Adapter();
