/**
 * AP2 buyer-side client (Phase 4) — IMPLEMENTED.
 *
 * Builds, canonicalizes and signs a real IntentMandate, then submits it to
 * POST /v1/ap2/mandates and polls GET /v1/ap2/mandates/:id for settlement.
 *
 * CANONICALIZATION: the gateway recomputes the canonical form server-side and verifies
 * against THAT (§3.1 step 3), so the two implementations must agree byte-for-byte or
 * every signature fails. This is a deliberate re-implementation of the same JCS rules
 * rather than an import: agent and gateway are separate processes that in reality would
 * be written by different parties, and sharing the code would hide exactly the
 * interoperability bug this client exists to prove doesn't happen. `canonicalize.test.ts`
 * pins the two against each other on shared vectors — if they ever diverge, that is a
 * bug to report, not to paper over.
 *
 * The private key never leaves this process, which is the property §3.1 relies on.
 */

import * as ed25519 from '@noble/ed25519';
import { createHash, randomUUID } from 'node:crypto';
import type { RunTrace } from './trace.js';

// @noble/ed25519 v2 needs a SHA-512 implementation supplied for its sync API.
ed25519.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array =>
  new Uint8Array(
    createHash('sha512')
      .update(Buffer.concat(messages.map((m) => Buffer.from(m))))
      .digest(),
  );

export interface Ed25519Keypair {
  readonly publicKeyBase64: string;
  readonly privateKeyBase64: string;
}

export function generateKeypair(): Ed25519Keypair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    publicKeyBase64: Buffer.from(publicKey).toString('base64'),
    privateKeyBase64: Buffer.from(privateKey).toString('base64'),
  };
}

/**
 * JSON Canonicalization Scheme (RFC 8785) — must match the gateway's
 * crypto/canonicalize.ts exactly: recursively sorted keys, no insignificant whitespace,
 * arrays left in order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('non-finite numbers cannot be canonicalized');
  }
  if (typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    sorted[key] = sortValue(entry);
  }
  return sorted;
}

/** Canonicalizes for signing, excluding the detached signature itself. */
export function canonicalizeForSigning(mandate: Record<string, unknown>): string {
  const withoutSignature: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(mandate)) {
    if (key === 'signature') continue;
    withoutSignature[key] = entry;
  }
  return canonicalize(withoutSignature);
}

export function sign(canonicalPayload: string, privateKeyBase64: string): string {
  const privateKey = new Uint8Array(Buffer.from(privateKeyBase64, 'base64'));
  const message = new TextEncoder().encode(canonicalPayload);
  return Buffer.from(ed25519.sign(message, privateKey)).toString('base64');
}

export interface Ap2Result {
  readonly submitResponse: unknown;
  readonly httpStatus: number;
  readonly paymentRequestId: string | null;
  readonly finalStatus: string | null;
  readonly mandate: Record<string, unknown>;
}

export class Ap2Client {
  readonly protocol = 'ap2' as const;

  constructor(
    private readonly gatewayUrl: string,
    private readonly trace: RunTrace,
  ) {}

  buildMandate(options: {
    agentId: string;
    merchantId: string;
    amountPaise: number;
    privateKeyBase64: string;
    /** Test hook: corrupt the signature after signing, to prove the gateway rejects it. */
    corruptSignature?: boolean;
  }): Record<string, unknown> {
    const mandate: Record<string, unknown> = {
      mandateType: 'IntentMandate',
      agentId: options.agentId,
      merchantId: options.merchantId,
      maxAmountPaise: options.amountPaise,
      currency: 'INR',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      nonce: `n_${randomUUID()}`,
    };

    const canonicalPayload = canonicalizeForSigning(mandate);
    let signature = sign(canonicalPayload, options.privateKeyBase64);

    if (options.corruptSignature === true) {
      // Flip the last base64 character — same length, invalid signature.
      signature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    }

    mandate['signature'] = signature;

    this.trace.record('ap2.mandate_signed', {
      canonicalPayload,
      signature,
      corrupted: options.corruptSignature === true,
      nonce: mandate['nonce'],
    });

    return mandate;
  }

  async submit(mandate: Record<string, unknown>): Promise<Ap2Result> {
    const url = `${this.gatewayUrl}/v1/ap2/mandates`;
    const headers = { 'content-type': 'application/json' };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(mandate),
    });
    const body: unknown = await response.json().catch(() => null);

    this.trace.recordHttp(
      'ap2.submit',
      { method: 'POST', url, headers, body: mandate },
      { status: response.status, body },
    );

    const paymentRequestId =
      typeof body === 'object' && body !== null && 'payment_request_id' in body
        ? String((body as { payment_request_id: unknown }).payment_request_id)
        : null;

    return {
      submitResponse: body,
      httpStatus: response.status,
      paymentRequestId,
      finalStatus: null,
      mandate,
    };
  }

  /**
   * Polls GET /v1/ap2/mandates/:id. Note what this can and cannot observe: the request
   * reaches 'awaiting_settlement' from the adapter, and only a verified Razorpay webhook
   * ever moves it to 'settled' (§1.3). An agent polling here cannot make that happen.
   */
  async pollStatus(paymentRequestId: string, attempts = 3): Promise<string | null> {
    const url = `${this.gatewayUrl}/v1/ap2/mandates/${encodeURIComponent(paymentRequestId)}`;
    let status: string | null = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await fetch(url, { method: 'GET' });
      const body: unknown = await response.json().catch(() => null);

      this.trace.recordHttp(
        `ap2.poll.${attempt}`,
        { method: 'GET', url },
        { status: response.status, body },
      );

      if (typeof body === 'object' && body !== null && 'status' in body) {
        status = String((body as { status: unknown }).status);
        if (status === 'settled' || status === 'rejected' || status === 'failed') break;
      }

      if (attempt < attempts) await new Promise((r) => setTimeout(r, 400));
    }

    return status;
  }

  async purchase(options: {
    agentId: string;
    merchantId: string;
    amountPaise: number;
    privateKeyBase64: string;
    corruptSignature?: boolean;
  }): Promise<Ap2Result> {
    const mandate = this.buildMandate(options);
    const result = await this.submit(mandate);

    if (result.paymentRequestId === null) return result;

    const finalStatus = await this.pollStatus(result.paymentRequestId);
    return { ...result, finalStatus };
  }
}
