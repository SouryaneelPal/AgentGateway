/**
 * JSON canonicalization (§3.1) — IMPLEMENTED (Phase 3).
 *
 * Agents sign the canonicalized IntentMandate payload (JSON Canonicalization Scheme —
 * sorted keys, no whitespace ambiguity) so verification is deterministic no matter how
 * the agent serialised its JSON on the wire. The gateway recomputes the canonical form
 * server-side and verifies against that, never against the received bytes.
 *
 * This follows RFC 8785 (JCS):
 *   - object keys sorted by UTF-16 code unit, recursively
 *   - no insignificant whitespace
 *   - numbers serialised with ECMAScript `Number::toString`, which is exactly what
 *     JSON.stringify already emits (ES2019+ guarantees the shortest round-tripping
 *     representation, which is what JCS mandates)
 *   - NaN / Infinity / undefined / functions / symbols are not representable and are a
 *     hard error rather than being silently coerced to null, because a mandate that
 *     canonicalises differently on two machines is a signature that cannot be trusted
 */

/** Thrown when a value cannot be canonicalised deterministically. */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

function assertFiniteNumber(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(
      `Non-finite number at ${path} cannot be canonicalized (JCS forbids NaN and Infinity)`,
    );
  }
}

/**
 * Recursively rebuilds the value with object keys in sorted order. JSON.stringify
 * serialises object properties in insertion order, so sorting the keys here is what
 * makes the output canonical.
 */
function sortValue(value: unknown, path: string): unknown {
  if (value === null) return null;

  if (Array.isArray(value)) {
    // Array order is significant and must NOT be sorted.
    return value.map((entry, index) => sortValue(entry, `${path}[${index}]`));
  }

  switch (typeof value) {
    case 'number':
      assertFiniteNumber(value, path);
      // JCS serialises -0 as 0; JSON.stringify already does this.
      return value;
    case 'string':
    case 'boolean':
      return value;
    case 'bigint':
      throw new CanonicalizationError(
        `BigInt at ${path} cannot be canonicalized — convert to a number or string first`,
      );
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new CanonicalizationError(`${typeof value} at ${path} is not representable in JSON`);
    case 'object': {
      const source = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      // Default Array.prototype.sort is UTF-16 code-unit order, which is what JCS wants.
      for (const key of Object.keys(source).sort()) {
        const entry = source[key];
        if (entry === undefined) {
          // JSON.stringify drops undefined properties; drop them here too so the
          // canonical form matches what a JSON round-trip would produce.
          continue;
        }
        sorted[key] = sortValue(entry, `${path}.${key}`);
      }
      return sorted;
    }
    default:
      throw new CanonicalizationError(`Unsupported type at ${path}`);
  }
}

/**
 * Returns the canonical JSON string for a value — the exact bytes that get signed and
 * that are persisted to mandates.canonical_payload (§2.3).
 */
export function canonicalize(value: unknown): string {
  const sorted = sortValue(value, '$');
  const serialised = JSON.stringify(sorted);
  if (serialised === undefined) {
    throw new CanonicalizationError('Value is not JSON-serialisable');
  }
  return serialised;
}

/**
 * Canonicalizes a mandate for signing/verification, excluding the detached signature
 * itself — an agent cannot sign a payload that already contains its own signature.
 */
export function canonicalizeForSigning(
  mandate: Readonly<Record<string, unknown>>,
  signatureField = 'signature',
): string {
  const withoutSignature: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(mandate)) {
    if (key === signatureField) continue;
    withoutSignature[key] = entry;
  }
  return canonicalize(withoutSignature);
}
