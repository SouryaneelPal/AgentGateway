/**
 * ap2Adapter (§2.2) — Phase 3 scope, scaffolded here.
 *
 * Verifies Ed25519 signatures over the canonicalized IntentMandate payload using the
 * agent's registered public key (§3.1), and enforces nonce uniqueness on both the
 * Redis fast path and the Postgres unique constraint (§3.2).
 */

import { NotImplementedError } from '../errors.js';
import type {
  IncomingRequest,
  NormalizedPaymentRequest,
  ProtocolAdapter,
  ProtocolReceipt,
  SettlementResult,
  ValidationResult,
} from './protocol-adapter.interface.js';

export class Ap2Adapter implements ProtocolAdapter {
  readonly protocolName = 'ap2' as const;

  /**
   * TODO(Phase 3): canonicalize the IntentMandate (JCS), verify the Ed25519 signature
   * against agent_identities.public_key, reject on expiry, and reject a replayed nonce.
   * A failed verification is a hard reject — it must never reach the Policy Engine or
   * touch Razorpay, and it is written to audit_log as mandate_rejected /
   * signature_invalid (§3.1).
   */
  async validate(rawRequest: IncomingRequest): Promise<ValidationResult> {
    void rawRequest;
    throw new NotImplementedError('Ap2Adapter.validate', 'Phase 3');
  }

  /**
   * TODO(Phase 3): map IntentMandate.maxAmount / .merchantId / .expiresAt into the
   * shared shape, setting requiresHumanApproval = true when the mandate amount exceeds
   * the merchant's auto-approve ceiling.
   */
  async normalize(validated: ValidationResult): Promise<NormalizedPaymentRequest> {
    void validated;
    throw new NotImplementedError('Ap2Adapter.normalize', 'Phase 3');
  }

  /** TODO(Phase 3): create a Razorpay Order; settlement is confirmed by webhook only. */
  async settle(normalized: NormalizedPaymentRequest): Promise<SettlementResult> {
    void normalized;
    throw new NotImplementedError('Ap2Adapter.settle', 'Phase 3');
  }

  /**
   * TODO(Phase 3): on capture, construct a PaymentMandate/PaymentReceipt-shaped object
   * per AP2's object model.
   */
  async formatReceipt(result: SettlementResult): Promise<ProtocolReceipt> {
    void result;
    throw new NotImplementedError('Ap2Adapter.formatReceipt', 'Phase 3');
  }
}

export const ap2Adapter = new Ap2Adapter();
