/**
 * x402Adapter (§2.2) — Phase 3 scope, scaffolded here.
 *
 * Design note carried from §2.2: Razorpay settles in INR, not on-chain stablecoins, so
 * this adapter reinterprets x402's semantics. The envelope issued in the 402 response
 * encodes a Razorpay Payment Link/UPI intent reference rather than a token contract
 * address, and "payment proof" is a signed reference to a Razorpay payment_id rather
 * than an on-chain transaction hash. x402's *shape* is rail-agnostic; only its
 * reference implementation assumes crypto.
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

export class X402Adapter implements ProtocolAdapter {
  readonly protocolName = 'x402' as const;

  /**
   * TODO(Phase 3): parse the PAYMENT-SIGNATURE header, check the envelope
   * (scheme, network, asset, payTo, maxAmountRequired, expiry) against what the
   * gateway issued in its own 402 response, and reject anything past expiry.
   * Enforce one-time redemption of the reference.
   */
  async validate(rawRequest: IncomingRequest): Promise<ValidationResult> {
    void rawRequest;
    throw new NotImplementedError('X402Adapter.validate', 'Phase 3');
  }

  /** TODO(Phase 3): map the verified envelope onto NormalizedPaymentRequest. */
  async normalize(validated: ValidationResult): Promise<NormalizedPaymentRequest> {
    void validated;
    throw new NotImplementedError('X402Adapter.normalize', 'Phase 3');
  }

  /**
   * TODO(Phase 3): create a Razorpay Order for the referenced amount, then wait for
   * capture confirmation via webhook — never by polling (§1.3).
   */
  async settle(normalized: NormalizedPaymentRequest): Promise<SettlementResult> {
    void normalized;
    throw new NotImplementedError('X402Adapter.settle', 'Phase 3');
  }

  /** TODO(Phase 3): emit the x402-shaped receipt returned alongside the resource. */
  async formatReceipt(result: SettlementResult): Promise<ProtocolReceipt> {
    void result;
    throw new NotImplementedError('X402Adapter.formatReceipt', 'Phase 3');
  }
}

export const x402Adapter = new X402Adapter();
