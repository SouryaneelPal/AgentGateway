/**
 * Ed25519 mandate signature verification (§3.1) — Phase 3 scope, scaffolded here.
 *
 * At onboarding each agent registers an Ed25519 public key against its
 * agent_identities row; the private key never touches the gateway. A failed
 * verification is a HARD reject — the request never reaches the Policy Engine or
 * touches Razorpay, and it is logged to audit_log with action = 'mandate_rejected'
 * and detail.reason = 'signature_invalid'.
 */

import { NotImplementedError } from '../errors.js';

export interface VerifyMandateSignatureInput {
  /** Output of canonicalize() — the exact bytes that were signed. */
  readonly canonicalPayload: string;
  /** base64 Ed25519 detached signature. */
  readonly signature: string;
  /** base64/PEM public key from agent_identities.public_key. */
  readonly publicKey: string;
}

/**
 * TODO(Phase 3): implement per §3.1 —
 *
 *   const isValid = nacl.sign.detached.verify(
 *     new TextEncoder().encode(canonicalPayload),
 *     base64ToBytes(mandate.signature),
 *     base64ToBytes(agentIdentity.publicKey)
 *   );
 *
 * tweetnacl or @noble/ed25519 per the Phase 3 stack note; node:crypto's
 * verify('ed25519', ...) is also viable and drops a dependency.
 */
export function verifyMandateSignature(input: VerifyMandateSignatureInput): boolean {
  void input;
  throw new NotImplementedError('verifyMandateSignature', 'Phase 3');
}
