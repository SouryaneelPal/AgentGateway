/**
 * Tests for §3.4 webhook HMAC-SHA256 verification.
 *
 * This module is genuinely implemented in Phase 1, so these are real assertions rather
 * than placeholders. The Phase 2 validation checklist ("a deliberately tampered
 * signature is rejected and logged") builds on top of this.
 */

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from '../src/razorpay/webhook-signature.js';

const SECRET = 'test_webhook_secret';
const BODY = Buffer.from(
  JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1' } } } }),
  'utf8',
);

describe('verifyWebhookSignature', () => {
  it('accepts a signature Razorpay would have produced for these exact bytes', () => {
    const signature = signWebhookPayload(BODY, SECRET);
    expect(verifyWebhookSignature(BODY, signature, SECRET)).toBe(true);
  });

  it('rejects a tampered signature of the correct length', () => {
    const signature = signWebhookPayload(BODY, SECRET);
    const tampered = `${signature.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`;
    expect(tampered).toHaveLength(signature.length);
    expect(verifyWebhookSignature(BODY, tampered, SECRET)).toBe(false);
  });

  it('rejects a valid signature computed over a different body', () => {
    const otherBody = Buffer.from(JSON.stringify({ event: 'order.paid' }), 'utf8');
    const signature = signWebhookPayload(otherBody, SECRET);
    expect(verifyWebhookSignature(BODY, signature, SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const signature = signWebhookPayload(BODY, 'not_the_secret');
    expect(verifyWebhookSignature(BODY, signature, SECRET)).toBe(false);
  });

  it('returns false rather than throwing on a wrong-length signature', () => {
    // timingSafeEqual throws on length mismatch; the guard must turn that into a
    // clean rejection instead of a 500.
    expect(() => verifyWebhookSignature(BODY, 'deadbeef', SECRET)).not.toThrow();
    expect(verifyWebhookSignature(BODY, 'deadbeef', SECRET)).toBe(false);
  });

  it('rejects an empty signature header and an empty secret', () => {
    expect(verifyWebhookSignature(BODY, '', SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, signWebhookPayload(BODY, SECRET), '')).toBe(false);
  });

  it('verifies over raw bytes, not a re-serialised object (§3.4)', () => {
    // Razorpay signs the bytes on the wire. A body carrying insignificant whitespace
    // is a different signature even though it parses to an equal object — which is
    // exactly the trap §3.4 warns about when a JSON parser runs before verification.
    const onWire = Buffer.from('{ "b": 2, "a": 1 }', 'utf8');
    const reSerialised = Buffer.from(JSON.stringify(JSON.parse(onWire.toString('utf8'))), 'utf8');
    const signature = signWebhookPayload(onWire, SECRET);

    expect(reSerialised.toString('utf8')).not.toBe(onWire.toString('utf8'));
    expect(verifyWebhookSignature(onWire, signature, SECRET)).toBe(true);
    expect(verifyWebhookSignature(reSerialised, signature, SECRET)).toBe(false);
  });

  it('matches a hand-rolled HMAC digest', () => {
    const expected = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(signWebhookPayload(BODY, SECRET)).toBe(expected);
    expect(expected).toHaveLength(64);
  });
});
