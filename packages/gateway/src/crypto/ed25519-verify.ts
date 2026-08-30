/**
 * Ed25519 mandate signature verification (§3.1) — IMPLEMENTED (Phase 3).
 *
 * At onboarding each agent registers an Ed25519 public key against its
 * agent_identities row; the private key never touches the gateway. A failed
 * verification is a HARD reject — the request never reaches the Policy Engine or
 * touches Razorpay, and it is logged to audit_log with action = 'mandate_rejected'
 * and detail.reason = 'signature_invalid' (§3.1 step 4).
 *
 * LIBRARY CHOICE: @noble/ed25519 rather than tweetnacl (the Phase 3 stack note allows
 * either). Both are correct; noble is chosen because it is independently audited, still
 * actively maintained (tweetnacl-js has had no release since 2020), has zero
 * dependencies, and operates directly on the raw 32-byte keys that §3.1 assumes. The
 * whitepaper's snippet shows `nacl.sign.detached.verify`; this is the same detached
 * Ed25519 verification with a different vendor.
 *
 * noble's synchronous `verify` requires a SHA-512 implementation to be supplied. It is
 * wired to node:crypto below rather than pulling in a JS hash implementation.
 */

import { createHash } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';

// Wire noble's sync hash hook to Node's native SHA-512 once, at module load.
ed25519.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array =>
  new Uint8Array(
    createHash('sha512')
      .update(Buffer.concat(messages.map((m) => Buffer.from(m))))
      .digest(),
  );

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

export interface VerifyMandateSignatureInput {
  /** Output of canonicalize() — the exact bytes that were signed. */
  readonly canonicalPayload: string;
  /** base64 Ed25519 detached signature (64 bytes). */
  readonly signature: string;
  /** base64 (raw 32-byte) public key from agent_identities.public_key. */
  readonly publicKey: string;
}

/**
 * Decodes base64 strictly. Node's Buffer.from(..., 'base64') silently ignores garbage,
 * so the result is re-encoded and compared: a key or signature that does not round-trip
 * is malformed input, and malformed input on a signature path is a rejection, never a
 * best-effort parse.
 */
function decodeBase64(value: string, label: string, expectedBytes: number): Uint8Array | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }

  if (decoded.length !== expectedBytes) return null;

  // Reject input that is not canonical base64 (Buffer would otherwise accept it).
  if (decoded.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')) {
    return null;
  }

  void label;
  return new Uint8Array(decoded);
}

/**
 * Verifies a detached Ed25519 signature over the canonicalized payload.
 *
 * Returns false rather than throwing for every category of bad input — malformed
 * base64, a wrong-length key, a signature that simply does not verify. A caller on the
 * mandate path treats all of them identically: hard reject.
 */
export function verifyMandateSignature(input: VerifyMandateSignatureInput): boolean {
  const publicKey = decodeBase64(input.publicKey, 'publicKey', ED25519_PUBLIC_KEY_BYTES);
  const signature = decodeBase64(input.signature, 'signature', ED25519_SIGNATURE_BYTES);

  if (publicKey === null || signature === null) return false;

  const message = new TextEncoder().encode(input.canonicalPayload);

  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    // noble throws on points that are not on the curve; that is a failed verification.
    return false;
  }
}

/**
 * Test/tooling helper — generates a keypair and signs a canonical payload the way a
 * real agent would. Used by the Phase 3 tests and, later, by the Phase 4 reference
 * agent's AP2 run.
 */
export function generateAgentKeypair(): { publicKeyBase64: string; privateKeyBase64: string } {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    publicKeyBase64: Buffer.from(publicKey).toString('base64'),
    privateKeyBase64: Buffer.from(privateKey).toString('base64'),
  };
}

/** Test/tooling helper — the signing side of verifyMandateSignature. */
export function signCanonicalPayload(canonicalPayload: string, privateKeyBase64: string): string {
  const privateKey = new Uint8Array(Buffer.from(privateKeyBase64, 'base64'));
  const message = new TextEncoder().encode(canonicalPayload);
  return Buffer.from(ed25519.sign(message, privateKey)).toString('base64');
}
