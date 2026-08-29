/**
 * x402 buyer-side client (Phase 4) — scaffolded in Phase 1.
 *
 * Mirrors the gateway's x402Adapter from the other side of the wire: request the
 * resource, receive a 402 with a PAYMENT-REQUIRED envelope, settle it, then retry
 * with a PAYMENT-SIGNATURE header carrying the proof.
 */

export class NotImplementedError extends Error {
  constructor(subject: string) {
    super(`${subject} is not implemented yet — scaffolded in Phase 1, lands in Phase 4.`);
    this.name = 'NotImplementedError';
  }
}

export class X402Client {
  readonly protocol = 'x402' as const;
  private readonly gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  /**
   * TODO(Phase 4):
   *   1. GET  {gateway}/v1/x402/checkout/{cartId} -> expect 402 + PAYMENT-REQUIRED envelope
   *   2. settle the referenced amount against the Razorpay Payment Link / UPI intent
   *   3. POST {gateway}/v1/x402/checkout/{cartId} with a PAYMENT-SIGNATURE header
   *   4. record every request/response pair into the run trace
   */
  async purchase(cartId: string): Promise<void> {
    void cartId;
    void this.gatewayUrl;
    throw new NotImplementedError('X402Client.purchase');
  }
}
