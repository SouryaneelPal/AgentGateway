/**
 * x402 buyer-side client (Phase 4) — IMPLEMENTED.
 *
 * The other side of the gateway's x402Adapter. Shapes are taken from that adapter's
 * actual code, not from the whitepaper prose, because Phase 3 refined them:
 *   - the challenge arrives in the PAYMENT-REQUIRED response header, as JSON
 *   - the proof goes back in the PAYMENT-SIGNATURE request header, as JSON carrying
 *     { reference, amount, razorpayPaymentId }
 *   - `reference` IS the one-time nonce; the gateway will only redeem it once (§3.2)
 */

import type { RunTrace } from './trace.js';

export interface X402Envelope {
  readonly scheme: string;
  readonly amount: number;
  readonly currency: string;
  readonly payTo: string;
  readonly expiry: string;
  readonly reference: string;
}

export interface X402Result {
  readonly settledResponse: unknown;
  readonly paymentRequestId: string | null;
  readonly envelope: X402Envelope;
  readonly httpStatus: number;
}

export class X402Client {
  readonly protocol = 'x402' as const;

  constructor(
    private readonly gatewayUrl: string,
    private readonly trace: RunTrace,
  ) {}

  /** Step 1: GET the resource, expect 402 + the PAYMENT-REQUIRED envelope. */
  async requestChallenge(options: {
    cartId: string;
    agentId: string;
    merchantId: string;
    amountPaise: number;
  }): Promise<X402Envelope> {
    const url =
      `${this.gatewayUrl}/v1/x402/checkout/${encodeURIComponent(options.cartId)}` +
      `?agentId=${encodeURIComponent(options.agentId)}` +
      `&merchantId=${encodeURIComponent(options.merchantId)}` +
      `&amountPaise=${options.amountPaise}`;

    const response = await fetch(url, { method: 'GET' });
    const header = response.headers.get('payment-required');
    const body: unknown = await response.json().catch(() => null);

    this.trace.recordHttp(
      'x402.challenge',
      { method: 'GET', url },
      {
        status: response.status,
        body: { headers: { 'payment-required': header }, body },
      },
    );

    if (response.status !== 402) {
      throw new Error(`expected 402 Payment Required, got ${response.status}`);
    }
    if (header === null) {
      throw new Error('402 response carried no PAYMENT-REQUIRED header');
    }

    const envelope = JSON.parse(header) as X402Envelope;
    this.trace.record('x402.envelope_parsed', { envelope });
    return envelope;
  }

  /**
   * Step 2: build the proof and retry.
   *
   * The gateway reinterprets x402 onto INR rails (§2.2), so "payment proof" is a signed
   * reference to a Razorpay payment rather than an on-chain transaction hash. The
   * binding that matters is the one-time `reference` the gateway itself issued.
   */
  async redeem(cartId: string, envelope: X402Envelope): Promise<X402Result> {
    const proof = {
      reference: envelope.reference,
      amount: envelope.amount,
      razorpayPaymentId: `agentproof_${envelope.reference.slice(3, 19)}`,
    };

    const url = `${this.gatewayUrl}/v1/x402/checkout/${encodeURIComponent(cartId)}`;
    const headers = {
      'content-type': 'application/json',
      'payment-signature': JSON.stringify(proof),
    };

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) });
    const body: unknown = await response.json().catch(() => null);

    this.trace.recordHttp(
      'x402.redeem',
      { method: 'POST', url, headers, body: { proof } },
      { status: response.status, body },
    );

    const paymentRequestId =
      typeof body === 'object' && body !== null && 'payment_request_id' in body
        ? String((body as { payment_request_id: unknown }).payment_request_id)
        : null;

    return { settledResponse: body, paymentRequestId, envelope, httpStatus: response.status };
  }

  /** Convenience: the whole flow, challenge through redemption. */
  async purchase(options: {
    cartId: string;
    agentId: string;
    merchantId: string;
    amountPaise: number;
  }): Promise<X402Result> {
    const envelope = await this.requestChallenge(options);
    return this.redeem(options.cartId, envelope);
  }
}
