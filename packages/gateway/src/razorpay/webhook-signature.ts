/**
 * Razorpay webhook HMAC-SHA256 verification (§3.4) — IMPLEMENTED.
 *
 * This is the only trustworthy settlement signal in the entire system. Per §1.3, an
 * x402 payment proof, an AP2 mandate signature and an optimistic client response are
 * all *claims*; only a signature-verified webhook is ground truth.
 *
 * Two details that matter more than they look (§3.4):
 *   1. The digest is computed over the UNPARSED raw body. If a JSON body-parser runs
 *      first, re-serialising the parsed object will not byte-match what Razorpay
 *      signed and every verification silently fails. server.ts captures the raw buffer
 *      in a content-type parser before any JSON parsing occurs.
 *   2. Comparison is constant-time. Never use === on a signature.
 */

import crypto from 'node:crypto';

/**
 * Verifies the X-Razorpay-Signature header against an HMAC-SHA256 digest of the raw body.
 *
 * @param rawBody         The exact bytes Razorpay POSTed — not a re-serialised object.
 * @param signatureHeader Value of the X-Razorpay-Signature header (lowercase hex).
 * @param secret          RAZORPAY_WEBHOOK_SECRET.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  if (secret.length === 0 || signatureHeader.length === 0) {
    return false;
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(signatureHeader, 'utf8');

  // timingSafeEqual throws on a length mismatch, which would turn a malformed header
  // into a 500 instead of a clean rejection. The length itself is not a secret — a
  // digest is always 64 hex chars — so returning early here leaks nothing.
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * Test/tooling helper: produce the signature Razorpay would send for a given body.
 * Used by the webhook-signature unit tests and, later, the Phase 6 chaos scripts that
 * deliver tampered and duplicate webhooks.
 */
export function signWebhookPayload(rawBody: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}
