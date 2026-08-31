/**
 * Phase 4.5 — merchant authentication, cross-tenant isolation, and secret encryption.
 *
 * The IDOR test is the one that matters. Adding authentication *alongside* a
 * body-supplied merchantId would not have fixed anything: a caller could still
 * authenticate as merchant A and name merchant B. So the test below authenticates as A
 * and explicitly supplies B's id, and asserts nothing lands on B.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db/prisma-client.js';
import { env } from '../src/config/env.js';
import { generateApiKey, hashApiKey } from '../src/auth/merchant-auth.js';
import { generateAgentKeypair } from '../src/crypto/ed25519-verify.js';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  parseEncryptionKey,
  SecretBoxError,
} from '../src/crypto/secret-box.js';

let app: FastifyInstance;
const merchantIds: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  for (const id of merchantIds.splice(0)) {
    await prisma.auditLog.deleteMany({ where: { actorId: id } });
    const agents = await prisma.agentIdentity.findMany({
      where: { merchantId: id },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: agents.map((a) => a.id) } } });
    await prisma.agentIdentity.deleteMany({ where: { merchantId: id } });
    await prisma.merchantApiKey.deleteMany({ where: { merchantId: id } });
    await prisma.merchant.deleteMany({ where: { id } });
  }
});

/** Creates a merchant with an encrypted secret and one active API key. */
async function seedMerchantWithKey(): Promise<{ merchantId: string; apiKey: string }> {
  const key = parseEncryptionKey(env.MERCHANT_SECRET_ENCRYPTION_KEY);
  const merchant = await prisma.merchant.create({
    data: {
      name: `auth-test-${randomUUID().slice(0, 8)}`,
      razorpayKeyId: 'rzp_test_fixture',
      razorpayKeySecretEncrypted: encryptSecret('super-secret-value', key),
      enabledProtocols: ['x402', 'ap2', 'fallback'],
    },
    select: { id: true },
  });
  merchantIds.push(merchant.id);

  const generated = generateApiKey();
  await prisma.merchantApiKey.create({
    data: {
      merchantId: merchant.id,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      label: 'test',
    },
  });

  return { merchantId: merchant.id, apiKey: generated.plaintext };
}

const MERCHANT_ROUTES = [
  { method: 'GET' as const, url: '/v1/merchant/policy' },
  { method: 'PUT' as const, url: '/v1/merchant/policy' },
  { method: 'GET' as const, url: '/v1/merchant/transactions' },
  { method: 'GET' as const, url: '/v1/merchant/audit-log' },
  { method: 'GET' as const, url: '/v1/merchant/stream' },
  { method: 'POST' as const, url: '/v1/merchant/agents/register' },
];

describe('every /v1/merchant/* route requires authentication', () => {
  it('rejects an unauthenticated request with 401 — agents/register included', async () => {
    for (const route of MERCHANT_ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(response.json()).toMatchObject({ error: 'unauthorized' });
    }
  });

  it('rejects a malformed Authorization header', async () => {
    for (const header of ['', 'Bearer', 'Basic abc', 'Bearer    ', 'token agk_x']) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/merchant/policy',
        headers: { authorization: header },
      });
      expect(response.statusCode, `header: "${header}"`).toBe(401);
    }
  });

  it('rejects a well-formed but unknown key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/merchant/policy',
      headers: { authorization: `Bearer ${generateApiKey().plaintext}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a revoked key', async () => {
    const { merchantId, apiKey } = await seedMerchantWithKey();
    await prisma.merchantApiKey.updateMany({
      where: { merchantId },
      data: { revokedAt: new Date() },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/merchant/policy',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a valid key — 401 gone (501 is the Phase 5 stub, i.e. past auth)', async () => {
    const { apiKey } = await seedMerchantWithKey();

    for (const route of [{ method: 'GET' as const, url: '/v1/merchant/policy' }]) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).toBe(501);
    }
  });

  it('accepts a valid key on agents/register and derives the merchant from it', async () => {
    const { merchantId, apiKey } = await seedMerchantWithKey();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/merchant/agents/register',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        protocol: 'ap2',
        externalAgentId: 'agent-authed',
        publicKey: generateAgentKeypair().publicKeyBase64,
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ merchant_id: merchantId });
  });

  it('records lastUsedAt on the key that authenticated', async () => {
    const { merchantId, apiKey } = await seedMerchantWithKey();

    await app.inject({
      method: 'GET',
      url: '/v1/merchant/policy',
      headers: { authorization: `Bearer ${apiKey}` },
    });

    // The update is fire-and-forget; give it a moment to land.
    await new Promise((r) => setTimeout(r, 250));
    const key = await prisma.merchantApiKey.findFirstOrThrow({ where: { merchantId } });
    expect(key.lastUsedAt).not.toBeNull();
  });
});

describe('cross-tenant IDOR is closed, not merely fronted by auth', () => {
  it("refuses merchant A's key when merchant B's id is supplied in the body", async () => {
    const alice = await seedMerchantWithKey();
    const bob = await seedMerchantWithKey();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/merchant/agents/register',
      headers: { authorization: `Bearer ${alice.apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        merchantId: bob.merchantId, // the attack
        protocol: 'ap2',
        externalAgentId: 'idor-probe',
        publicKey: generateAgentKeypair().publicKeyBase64,
      }),
    });

    // Rejected loudly rather than silently ignored, so a stale client is corrected.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'malformed_request' });

    // The assertion that matters: nothing was created on Bob's merchant.
    expect(await prisma.agentIdentity.count({ where: { merchantId: bob.merchantId } })).toBe(0);
    expect(await prisma.agentIdentity.count({ where: { externalAgentId: 'idor-probe' } })).toBe(0);
  });

  it('refuses merchantName too, so a merchant cannot be conjured', async () => {
    const alice = await seedMerchantWithKey();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/merchant/agents/register',
      headers: { authorization: `Bearer ${alice.apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        merchantName: 'brand-new-merchant',
        protocol: 'ap2',
        externalAgentId: 'agent-x',
        publicKey: generateAgentKeypair().publicKeyBase64,
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.merchant.count({ where: { name: 'brand-new-merchant' } })).toBe(0);
  });

  it('two merchants stay isolated: each key only ever yields its own merchant', async () => {
    const alice = await seedMerchantWithKey();
    const bob = await seedMerchantWithKey();

    for (const who of [alice, bob]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/merchant/agents/register',
        headers: { authorization: `Bearer ${who.apiKey}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          protocol: 'ap2',
          externalAgentId: `agent-${who.merchantId.slice(0, 8)}`,
          publicKey: generateAgentKeypair().publicKeyBase64,
        }),
      });
      expect(response.json()).toMatchObject({ merchant_id: who.merchantId });
    }

    expect(await prisma.agentIdentity.count({ where: { merchantId: alice.merchantId } })).toBe(1);
    expect(await prisma.agentIdentity.count({ where: { merchantId: bob.merchantId } })).toBe(1);
  });
});

describe('API keys are stored hashed, never in plaintext', () => {
  it('stores only a SHA-256 hash and a non-secret prefix', async () => {
    const { merchantId, apiKey } = await seedMerchantWithKey();
    const stored = await prisma.merchantApiKey.findFirstOrThrow({ where: { merchantId } });

    expect(stored.keyHash).toBe(hashApiKey(apiKey));
    expect(stored.keyHash).not.toBe(apiKey);
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
    // The prefix must not be enough to reconstruct the key.
    expect(apiKey.startsWith(stored.keyPrefix)).toBe(true);
    expect(stored.keyPrefix.length).toBeLessThan(apiKey.length / 2);
  });
});

describe('merchants.razorpay_key_secret_encrypted is genuinely encrypted at rest', () => {
  const key = parseEncryptionKey(env.MERCHANT_SECRET_ENCRYPTION_KEY);

  it('round-trips through AES-256-GCM', () => {
    const envelope = encryptSecret('a-real-razorpay-secret', key);
    expect(decryptSecret(envelope, key)).toBe('a-real-razorpay-secret');
  });

  it('never stores the plaintext in the column', async () => {
    const { merchantId } = await seedMerchantWithKey();
    const row = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { razorpayKeySecretEncrypted: true },
    });

    expect(row.razorpayKeySecretEncrypted).not.toContain('super-secret-value');
    expect(isEncrypted(row.razorpayKeySecretEncrypted)).toBe(true);
    expect(row.razorpayKeySecretEncrypted).toMatch(/^v1:/);
    expect(decryptSecret(row.razorpayKeySecretEncrypted, key)).toBe('super-secret-value');
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('detects tampering rather than returning garbage', () => {
    const envelope = encryptSecret('tamper-me', key);
    const parts = envelope.split(':');
    const cipher = Buffer.from(parts[3] ?? '', 'base64');
    cipher[0] = (cipher[0] ?? 0) ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], cipher.toString('base64')].join(':');

    expect(() => decryptSecret(tampered, key)).toThrow(SecretBoxError);
  });

  it('rejects a wrong master key', () => {
    const envelope = encryptSecret('secret', key);
    const otherKey = parseEncryptionKey(Buffer.alloc(32, 7).toString('base64'));
    expect(() => decryptSecret(envelope, otherKey)).toThrow(SecretBoxError);
  });

  it('refuses a master key that is not 32 bytes', () => {
    expect(() => parseEncryptionKey(Buffer.from('short').toString('base64'))).toThrow(
      SecretBoxError,
    );
  });
});
