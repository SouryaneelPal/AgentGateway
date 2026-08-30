/**
 * Canonicalization parity (§3.1).
 *
 * The agent canonicalizes a mandate and signs it; the gateway independently recomputes
 * the canonical form server-side and verifies against THAT. If the two implementations
 * disagree by a single byte, every signature fails.
 *
 * They are deliberately separate implementations — agent and gateway are separate
 * processes that in reality would be written by different parties, and sharing the code
 * would hide exactly the interoperability bug this client exists to disprove. So instead
 * of importing the gateway's version, both suites pin the SAME expected output strings.
 * The vectors below are byte-identical to the ones asserted in
 * packages/gateway/test/crypto.test.ts; if either side drifts, one of the two suites
 * goes red.
 *
 * The end-to-end proof is stronger still: a live AP2 run only returns 202 if the
 * gateway's recomputed canonical form matched the bytes this client signed.
 */

import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalizeForSigning } from '../src/ap2-client.js';

describe('canonicalize — parity with the gateway (§3.1)', () => {
  it('matches the gateway vector for key ordering', () => {
    expect(canonicalize({ b: 2, a: 1, c: { z: true, y: null } })).toBe(
      '{"a":1,"b":2,"c":{"y":null,"z":true}}',
    );
  });

  it('matches the gateway vector for nested sorting', () => {
    expect(canonicalize({ outer: { d: 1, a: { z: 1, b: 2 } } })).toBe(
      '{"outer":{"a":{"b":2,"z":1},"d":1}}',
    );
  });

  it('preserves array order, like the gateway', () => {
    expect(canonicalize({ items: [3, 1, 2] })).toBe('{"items":[3,1,2]}');
  });

  it('is insensitive to source whitespace and insertion order', () => {
    const compact: unknown = JSON.parse('{"b":2,"a":1}');
    const spaced: unknown = JSON.parse('{\n  "a" : 1,\n  "b" : 2\n}');
    expect(canonicalize(compact)).toBe(canonicalize(spaced));
  });

  it('drops the signature field when canonicalizing for signing', () => {
    expect(canonicalizeForSigning({ a: 1, signature: 'sig' })).toBe('{"a":1}');
  });

  it('canonicalizes a full IntentMandate identically regardless of field order', () => {
    const fields = {
      mandateType: 'IntentMandate',
      agentId: 'agent_x',
      merchantId: 'mrc_1',
      maxAmountPaise: 45000,
      currency: 'INR',
      expiresAt: '2026-08-31T10:00:00.000Z',
      nonce: 'n_1',
    };
    const reversed = Object.fromEntries(Object.entries(fields).reverse());
    expect(canonicalizeForSigning(fields)).toBe(canonicalizeForSigning(reversed));
  });

  it('refuses non-finite numbers rather than emitting null', () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
  });
});
