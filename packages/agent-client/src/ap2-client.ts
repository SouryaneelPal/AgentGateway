/**
 * AP2 buyer-side client (Phase 4) — scaffolded in Phase 1.
 *
 * Generates its own Ed25519 keypair, registers the public key with the merchant
 * (simulating agent onboarding), then submits a signed IntentMandate. The private key
 * never leaves this process — that is the property §3.1 relies on.
 */

export class NotImplementedError extends Error {
  constructor(subject: string) {
    super(`${subject} is not implemented yet — scaffolded in Phase 1, lands in Phase 4.`);
    this.name = 'NotImplementedError';
  }
}

export interface Ed25519Keypair {
  readonly publicKeyBase64: string;
  readonly privateKeyBase64: string;
}

export class Ap2Client {
  readonly protocol = 'ap2' as const;
  private readonly gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  /** TODO(Phase 4): generate an Ed25519 keypair via node:crypto generateKeyPairSync. */
  generateKeypair(): Ed25519Keypair {
    throw new NotImplementedError('Ap2Client.generateKeypair');
  }

  /**
   * TODO(Phase 4):
   *   1. canonicalize the IntentMandate (same JCS rules the gateway uses, §3.1)
   *   2. sign it with the private key; send the base64 detached signature
   *   3. POST {gateway}/v1/ap2/mandates -> expect 202 + payment_request_id
   *   4. poll GET /v1/ap2/mandates/{id} until the webhook promotes it to settled
   *   5. record every request/response pair into the run trace
   */
  async purchase(cartId: string): Promise<void> {
    void cartId;
    void this.gatewayUrl;
    throw new NotImplementedError('Ap2Client.purchase');
  }
}
