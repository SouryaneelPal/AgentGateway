/**
 * JSON canonicalization (§3.1) — Phase 3 scope, scaffolded here.
 *
 * Agents sign the canonicalized IntentMandate payload (JSON Canonicalization Scheme —
 * sorted keys, no whitespace ambiguity) so that verification is deterministic no matter
 * how the agent serialised its JSON on the wire. The gateway recomputes the canonical
 * form server-side and verifies against that, never against the received bytes.
 */

import { NotImplementedError } from '../errors.js';

/**
 * TODO(Phase 3): implement JCS (RFC 8785) — recursively sort object keys, emit with no
 * insignificant whitespace, and use the RFC's number serialisation rules.
 */
export function canonicalize(value: unknown): string {
  void value;
  throw new NotImplementedError('canonicalize', 'Phase 3');
}
