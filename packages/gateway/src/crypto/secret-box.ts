/**
 * Authenticated encryption for secrets at rest (Phase 4.5).
 *
 * WHY THIS EXISTS: `merchants.razorpay_key_secret_encrypted` has been named as though
 * it were encrypted since §2.3, but nothing ever encrypted it — every write in the repo
 * stored a plaintext literal, and there was no cipher code anywhere. A column named
 * `_encrypted` holding plaintext is worse than an honestly-named one, because every
 * reader assumes the protection is already there.
 *
 * AES-256-GCM: authenticated, so tampering with the ciphertext is detected on decrypt
 * rather than silently yielding garbage. A random 96-bit IV per encryption means the
 * same plaintext never produces the same ciphertext twice.
 *
 * Envelope format: v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
 * The version prefix exists so the scheme can be rotated without guessing at old rows.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = 'v1';

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/** Decodes the base64 master key and refuses anything that is not exactly 32 bytes. */
export function parseEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError(
      `MERCHANT_SECRET_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(envelope: string, key: Buffer): string {
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretBoxError('malformed secret envelope');
  }

  const [, ivB64, tagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64 ?? '', 'base64');
  const authTag = Buffer.from(tagB64 ?? '', 'base64');
  const ciphertext = Buffer.from(ciphertextB64 ?? '', 'base64');

  if (iv.length !== IV_BYTES) throw new SecretBoxError('malformed IV');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM auth failure — the ciphertext or tag was tampered with, or the key is wrong.
    throw new SecretBoxError('secret failed authentication — tampered or wrong key');
  }
}

/** True when a stored value is in this module's envelope format rather than plaintext. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}:`) && value.split(':').length === 4;
}

/** Constant-time comparison, for anything secret-adjacent. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
