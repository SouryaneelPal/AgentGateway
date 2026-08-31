/**
 * POST /v1/merchant/agents/register — input validation.
 *
 * UPDATED IN PHASE 4.5. These tests were written when the route was unauthenticated;
 * every case now presents a real merchant API key. The two cases that used to assert
 * behaviour around a body-supplied merchantId/merchantName are gone — those parameters
 * are no longer accepted at all, and rejecting them is now covered as a tenant-isolation
 * concern in merchant-auth.test.ts rather than as input validation here.
 *
 * What remains is the validation that is orthogonal to auth: a revoked agent must not be
 * reinstated by re-registering, and malformed inputs must be refused.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db/prisma-client.js';
import { env } from '../src/config/env.js';
import { generateAgentKeypair } from '../src/crypto/ed25519-verify.js';
import { generateApiKey } from '../src/auth/merchant-auth.js';
import { encryptSecret, parseEncryptionKey } from '../src/crypto/secret-box.js';

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
    const agents = await prisma.agentIdentity.findMany({
      where: { merchantId: id },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: agents.map((a) => a.id) } } });
    await prisma.auditLog.deleteMany({ where: { actorId: id } });
    await prisma.agentIdentity.deleteMany({ where: { merchantId: id } });
    await prisma.merchantApiKey.deleteMany({ where: { merchantId: id } });
    await prisma.merchant.deleteMany({ where: { id } });
  }
});

async function seedMerchantWithKey(): Promise<{ merchantId: string; apiKey: string }> {
  const encryptionKey = parseEncryptionKey(env.MERCHANT_SECRET_ENCRYPTION_KEY);
  const merchant = await prisma.merchant.create({
    data: {
      name: `reg-test-${randomUUID().slice(0, 8)}`,
      razorpayKeyId: 'rzp_test_fixture',
      razorpayKeySecretEncrypted: encryptSecret('fixture-secret', encryptionKey),
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

function register(apiKey: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/merchant/agents/register',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

const validKey = (): string => generateAgentKeypair().publicKeyBase64;

describe('agent registration — happy path', () => {
  it('registers an ap2 agent with a valid Ed25519 key', async () => {
    const { merchantId, apiKey } = await seedMerchantWithKey();

    const response = await register(apiKey, {
      protocol: 'ap2',
      externalAgentId: 'agent-1',
      publicKey: validKey(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      protocol: 'ap2',
      external_agent_id: 'agent-1',
      merchant_id: merchantId,
    });
  });
});

describe('agent registration — revocation cannot be cleared by re-registering', () => {
  it('leaves revokedAt intact when a revoked agent re-registers', async () => {
    const { merchantId, apiKey } = await seedMerchantWithKey();

    const first = await register(apiKey, {
      protocol: 'ap2',
      externalAgentId: 'agent-revoked',
      publicKey: validKey(),
    });
    const agentIdentityId = (first.json() as { agent_identity_id: string }).agent_identity_id;

    // Merchant revokes the agent (§2.4).
    await prisma.agentIdentity.update({
      where: { id: agentIdentityId },
      data: { revokedAt: new Date() },
    });

    // Re-registering must NOT reinstate it — reinstatement is a separate, explicit act.
    const again = await register(apiKey, {
      protocol: 'ap2',
      externalAgentId: 'agent-revoked',
      publicKey: validKey(),
    });
    expect(again.statusCode).toBe(201);

    const after = await prisma.agentIdentity.findUniqueOrThrow({
      where: { id: agentIdentityId },
      select: { revokedAt: true, merchantId: true },
    });
    expect(after.revokedAt).not.toBeNull();
    expect(after.merchantId).toBe(merchantId);
  });
});

describe('agent registration — input validation', () => {
  it('rejects a negative spending limit', async () => {
    const { apiKey } = await seedMerchantWithKey();

    // Number.isInteger(-5) is true — an earlier version let this through.
    const response = await register(apiKey, {
      protocol: 'ap2',
      externalAgentId: 'agent-neg',
      publicKey: validKey(),
      spendingLimitPaise: -500_000,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'malformed_request' });
  });

  it('rejects an absurdly large spending limit', async () => {
    const { apiKey } = await seedMerchantWithKey();

    const response = await register(apiKey, {
      protocol: 'ap2',
      externalAgentId: 'agent-big',
      publicKey: validKey(),
      spendingLimitPaise: 999_999_999_999,
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a publicKey that is not a 32-byte Ed25519 key', async () => {
    const { apiKey } = await seedMerchantWithKey();

    for (const badKey of ['not-a-key', Buffer.from('short').toString('base64'), '']) {
      const response = await register(apiKey, {
        protocol: 'ap2',
        externalAgentId: 'agent-badkey',
        publicKey: badKey,
      });
      expect(response.statusCode, `key: ${badKey}`).toBe(400);
    }
  });

  it('rejects an over-long externalAgentId', async () => {
    const { apiKey } = await seedMerchantWithKey();

    const response = await register(apiKey, {
      protocol: 'ap2',
      externalAgentId: 'a'.repeat(500),
      publicKey: validKey(),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an invalid protocol', async () => {
    const { apiKey } = await seedMerchantWithKey();

    const response = await register(apiKey, {
      protocol: 'uap',
      externalAgentId: 'agent-uap',
      publicKey: validKey(),
    });

    expect(response.statusCode).toBe(400);
  });

  it('requires a publicKey for ap2 but not for x402', async () => {
    const { apiKey } = await seedMerchantWithKey();

    const withoutKey = await register(apiKey, { protocol: 'ap2', externalAgentId: 'a-nokey' });
    expect(withoutKey.statusCode).toBe(400);

    // x402 binds to a gateway-issued one-time reference, not to a signature (§3.2).
    const x402 = await register(apiKey, { protocol: 'x402', externalAgentId: 'x-nokey' });
    expect(x402.statusCode).toBe(201);
  });
});
