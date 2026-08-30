/**
 * Crypto primitive tests (§3.1) — Phase 3.
 *
 * Canonicalization is the part that silently breaks signatures if it is wrong, so these
 * assert the property that actually matters: two different serialisations of the same
 * logical object must produce identical bytes, and any change to the content must not.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  canonicalizeForSigning,
  CanonicalizationError,
} from '../src/crypto/canonicalize.js';
import {
  generateAgentKeypair,
  signCanonicalPayload,
  verifyMandateSignature,
} from '../src/crypto/ed25519-verify.js';

describe('canonicalize (JCS, §3.1)', () => {
  it('produces identical bytes regardless of key insertion order', () => {
    const a = canonicalize({ b: 2, a: 1, c: { z: true, y: null } });
    const b = canonicalize({ c: { y: null, z: true }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2,"c":{"y":null,"z":true}}');
  });

  it('produces identical bytes regardless of whitespace in the source JSON', () => {
    const compact: unknown = JSON.parse('{"b":2,"a":1}');
    const spaced: unknown = JSON.parse('{\n  "a" : 1,\n  "b" : 2\n}');
    expect(canonicalize(compact)).toBe(canonicalize(spaced));
  });

  it('sorts nested object keys recursively', () => {
    expect(canonicalize({ outer: { d: 1, a: { z: 1, b: 2 } } })).toBe(
      '{"outer":{"a":{"b":2,"z":1},"d":1}}',
    );
  });

  it('preserves array order, which is significant', () => {
    expect(canonicalize({ items: [3, 1, 2] })).toBe('{"items":[3,1,2]}');
  });

  it('changes output when any value changes', () => {
    expect(canonicalize({ amount: 250000 })).not.toBe(canonicalize({ amount: 250001 }));
  });

  it('rejects NaN and Infinity rather than coercing them to null', () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
  });

  it('rejects BigInt, which JSON.stringify would throw on unhelpfully', () => {
    expect(() => canonicalize({ x: 1n })).toThrow(CanonicalizationError);
  });

  it('drops the signature field when canonicalizing for signing', () => {
    const canonical = canonicalizeForSigning({ a: 1, signature: 'sig' });
    expect(canonical).toBe('{"a":1}');
    expect(canonical).not.toContain('signature');
  });
});

describe('verifyMandateSignature (Ed25519, §3.1)', () => {
  const keypair = generateAgentKeypair();
  const mandate = {
    mandateType: 'IntentMandate',
    agentId: 'agent_claude_ref_01',
    merchantId: 'mrc_1a2b3c',
    maxAmountPaise: 250000,
    currency: 'INR',
    expiresAt: '2026-08-29T10:00:00Z',
    nonce: '5f0c9e',
  };
  const canonicalPayload = canonicalizeForSigning(mandate);
  const signature = signCanonicalPayload(canonicalPayload, keypair.privateKeyBase64);

  it('accepts a genuine signature over the canonical payload', () => {
    expect(
      verifyMandateSignature({
        canonicalPayload,
        signature,
        publicKey: keypair.publicKeyBase64,
      }),
    ).toBe(true);
  });

  it('verifies regardless of how the agent ordered its JSON keys', () => {
    // Same mandate, different insertion order — canonicalization must make it verify.
    const reordered = canonicalizeForSigning({
      nonce: '5f0c9e',
      currency: 'INR',
      maxAmountPaise: 250000,
      expiresAt: '2026-08-29T10:00:00Z',
      merchantId: 'mrc_1a2b3c',
      agentId: 'agent_claude_ref_01',
      mandateType: 'IntentMandate',
    });
    expect(reordered).toBe(canonicalPayload);
    expect(
      verifyMandateSignature({
        canonicalPayload: reordered,
        signature,
        publicKey: keypair.publicKeyBase64,
      }),
    ).toBe(true);
  });

  it('rejects a signature over a tampered amount', () => {
    const tampered = canonicalizeForSigning({ ...mandate, maxAmountPaise: 1 });
    expect(
      verifyMandateSignature({
        canonicalPayload: tampered,
        signature,
        publicKey: keypair.publicKeyBase64,
      }),
    ).toBe(false);
  });

  it("rejects a valid signature checked against another agent's key", () => {
    const other = generateAgentKeypair();
    expect(
      verifyMandateSignature({
        canonicalPayload,
        signature,
        publicKey: other.publicKeyBase64,
      }),
    ).toBe(false);
  });

  it('returns false rather than throwing on malformed base64 input', () => {
    for (const bad of ['', 'not base64!!', 'AAAA', 'x'.repeat(200)]) {
      expect(() =>
        verifyMandateSignature({
          canonicalPayload,
          signature: bad,
          publicKey: keypair.publicKeyBase64,
        }),
      ).not.toThrow();
      expect(
        verifyMandateSignature({
          canonicalPayload,
          signature: bad,
          publicKey: keypair.publicKeyBase64,
        }),
      ).toBe(false);
    }
  });

  it('rejects a wrong-length public key', () => {
    expect(
      verifyMandateSignature({
        canonicalPayload,
        signature,
        publicKey: Buffer.from('too short').toString('base64'),
      }),
    ).toBe(false);
  });
});
