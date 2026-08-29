/**
 * fallbackAdapter (§2.2) — Phase 3 scope, scaffolded here.
 *
 * For any agent that speaks neither x402 nor AP2. Generates a standard Razorpay
 * Payment Link and waits for a human tap — one-time consent rather than per-transaction
 * blind trust. This adapter is what keeps the gateway from hard-failing on an
 * unrecognised client: graceful degradation is part of the design, not an afterthought.
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

export class FallbackAdapter implements ProtocolAdapter {
  readonly protocolName = 'fallback' as const;

  /**
   * TODO(Phase 3): structural validation only — there is no protocol signature to
   * check here. The trust comes from the human tapping the Payment Link.
   */
  async validate(rawRequest: IncomingRequest): Promise<ValidationResult> {
    void rawRequest;
    throw new NotImplementedError('FallbackAdapter.validate', 'Phase 3');
  }

  /** TODO(Phase 3): normalise, always with requiresHumanApproval = true. */
  async normalize(validated: ValidationResult): Promise<NormalizedPaymentRequest> {
    void validated;
    throw new NotImplementedError('FallbackAdapter.normalize', 'Phase 3');
  }

  /** TODO(Phase 3): create a Razorpay Payment Link and return it for a human tap. */
  async settle(normalized: NormalizedPaymentRequest): Promise<SettlementResult> {
    void normalized;
    throw new NotImplementedError('FallbackAdapter.settle', 'Phase 3');
  }

  /** TODO(Phase 3): emit a plain receipt shape — no protocol envelope to satisfy. */
  async formatReceipt(result: SettlementResult): Promise<ProtocolReceipt> {
    void result;
    throw new NotImplementedError('FallbackAdapter.formatReceipt', 'Phase 3');
  }
}

export const fallbackAdapter = new FallbackAdapter();
