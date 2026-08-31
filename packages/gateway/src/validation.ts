/**
 * Shared input bounds (Phase 7).
 *
 * Every string that reaches this system comes from an untrusted agent. Two properties
 * matter before any of it touches the database:
 *
 *   1. LENGTH. Without a cap, a caller can hand us a multi-megabyte identifier that gets
 *      carried through canonicalization, hashing and a database query before anything
 *      objects. Fastify's bodyLimit stops the truly enormous case; these caps stop the
 *      merely abusive one.
 *
 *   2. NULL BYTES AND CONTROL CHARACTERS. Postgres text columns cannot store U+0000 at
 *      all — it raises error 22021 — so a null byte in an agent id produced an HTTP 500
 *      from deep inside Prisma rather than a 400 from the edge. That was a real defect
 *      found by probing during Phase 7, not a theoretical one.
 *
 * On SQL injection specifically: Prisma parameterizes every query, including the raw
 * `$queryRaw` template used for the row-locked spend cap, so injection-shaped strings are
 * stored and compared as literal text. That is asserted by a real test
 * (test/input-validation.test.ts) rather than assumed — the point of that test is that the
 * string survives a round-trip *as data*, which is only true if it was never interpreted.
 * These rules exist for length and encoding safety, NOT as an injection defence. Treating
 * character filtering as an injection defence is how people end up with both a broken
 * filter and an injectable query.
 */

/** Identifiers: agent ids, merchant names, cart ids, categories, labels. */
export const MAX_IDENTIFIER_LENGTH = 128;

/** Nonces and references — generous, since some protocols use long opaque tokens. */
export const MAX_NONCE_LENGTH = 256;

/** Base64 signatures and keys. An Ed25519 signature is 88 chars; leave headroom. */
export const MAX_SIGNATURE_LENGTH = 1024;

/** URLs returned by Razorpay (payment links, short URLs). */
export const MAX_URL_LENGTH = 2048;

/** Free-text descriptions surfaced to a human. */
export const MAX_DESCRIPTION_LENGTH = 512;

/** ₹10,00,000. Generous for test mode, finite by design. */
export const MAX_SPENDING_LIMIT_PAISE = 100_000_000;

/** Largest single payment the gateway will normalize. */
export const MAX_AMOUNT_PAISE = 100_000_000;

/**
 * True for C0 controls (U+0000–U+001F, which includes the null byte) and C1 controls
 * (U+007F–U+009F).
 *
 * Written as a code-point scan rather than a regex character class on purpose: a literal
 * control character inside a regex is invisible in a diff and trivially corrupted by any
 * tool that touches the file. This form says exactly what it means.
 */
function isControlCodePoint(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Control characters are REJECTED, never stripped. Silently mutating a value that is about
 * to be canonicalized and signature-checked would change the bytes the signature covers,
 * and a mandate that verifies against something other than what the agent sent is a worse
 * outcome than a refused one.
 *
 * Note this also rejects tabs and newlines. Every string field in this system is an
 * identifier, a nonce, a signature or a short product description — none of them have a
 * legitimate reason to contain a line break, and allowing them would mean audit-log
 * entries that can forge their own line structure when rendered.
 */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (isControlCodePoint(value.charCodeAt(index))) return true;
  }
  return false;
}

/** A non-empty string, within bounds, free of control characters. */
export function isSafeString(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !hasControlCharacters(value)
  );
}

/**
 * True for a well-formed UUID (any version).
 *
 * merchantId and agentIdentityId are `uuid` columns in Postgres, not text. A value that
 * is not a syntactically valid UUID never reaches a row — it fails inside Postgres with
 * "invalid input syntax for type uuid", which Prisma raises and which surfaced as an
 * HTTP 500. Any caller could produce that 500 with a one-character merchantId, so the
 * shape has to be checked before the query, not discovered by it.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** A positive integer amount inside the accepted range. */
export function isValidAmountPaise(value: unknown, max = MAX_AMOUNT_PAISE): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max;
}

/**
 * Walks a parsed JSON value and returns the path of the first string containing a control
 * character, or null if there is none.
 *
 * Per-field validation is not sufficient on its own. The fallback adapter persists the
 * whole request body — `canonicalPayload: JSON.stringify(body)` and `raw: { ...body }` —
 * so a null byte in a field no adapter reads still reaches Postgres and still raises
 * 22021. Validating only the fields we happen to look at protects the fields we happen to
 * look at.
 *
 * Object keys are checked as well as values: a key is just as capable of carrying a null
 * byte into a jsonb column as a value is.
 */
export function findControlCharacterPath(value: unknown, path = 'body'): string | null {
  if (typeof value === 'string') {
    return hasControlCharacters(value) ? path : null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findControlCharacterPath(value[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }

  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (hasControlCharacters(key)) return `${path}.<key>`;
      const found = findControlCharacterPath(nested, `${path}.${key}`);
      if (found !== null) return found;
    }
  }

  return null;
}

/**
 * Describes why a string was refused, so the caller gets a useful 400 instead of a bare
 * "malformed_request" it has to guess at.
 */
export function describeStringProblem(
  value: unknown,
  field: string,
  maxLength = MAX_IDENTIFIER_LENGTH,
): string | null {
  if (typeof value !== 'string') return `${field} must be a string`;
  if (value.length === 0) return `${field} must not be empty`;
  if (value.length > maxLength) return `${field} exceeds ${maxLength} characters`;
  if (hasControlCharacters(value)) {
    return `${field} contains control characters, which cannot be stored`;
  }
  return null;
}
