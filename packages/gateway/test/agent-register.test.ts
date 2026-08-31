/**
 * POST /v1/merchant/agents/register — hardening tests.
 *
 * This route is a demo-only onboarding convenience (§3.1 step 1) and is NOT in §2.4's
 * route table. It is unauthenticated by design for now, with authentication scheduled
 * for Phase 4.5. These tests cover the weaknesses that are NOT the missing auth — the
 * ones a security review flagged and that are fixable without waiting for 4.5.
 *
 * The revocation case below is the important one: on an unauthenticated route, clearing
 * revokedAt during registration would let anyone un-revoke a revoked agent, defeating
 * the guardrail entirely.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db/prisma-client.js';
import { generateAgentKeypair } from '../src/crypto/ed25519-verify.js';
import { cleanup, seedAgent, type SeededAgent } from './helpers/db.js';

let app: FastifyInstance;
const created: SeededAgent[] = [];
const merchantNames: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  while (created.length > 0) {
    const seeded = created.pop();
    if (seeded !== undefined) await cleanup(seeded);
  }
  for (const name of merchantNames.splice(0)) {
    const merchants = await prisma.merchant.findMany({ where: { name }, select: { id: true } });
    for (const merchant of merchants) {
      await cleanup({ merchantId: merchant.id, agentIdentityId: '' });
    }
  }
});

function register(body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/merchant/agents/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

const validKey = (): string => generateAgentKeypair().publicKeyBase64;

describe('agent registration — happy path', () => {
  it('registers an ap2 agent with a valid Ed25519 key', async () => {
    const name = `reg-test-${randomUUID().slice(0, 8)}`;
    merchantNames.push(name);

    const response = await register({
      merchantName: name,
      protocol: 'ap2',
      externalAgentId: 'agent-1',
      publicKey: validKey(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ protocol: 'ap2', external_agent_id: 'agent-1' });
  });
});

describe('agent registration — revocation cannot be cleared by re-registering', () => {
  it('leaves revokedAt intact when a revoked agent re-registers', async () => {
    const seeded = await seedAgent({ spendingLimitPaise: 100_000n, protocol: 'ap2' });
    created.push(seeded);

    const agent = await prisma.agentIdentity.findUniqueOrThrow({
      where: { id: seeded.agentIdentityId },
      select: { externalAgentId: true },
    });

    // Merchant revokes the agent (§2.4).
    await prisma.agentIdentity.update({
      where: { id: seeded.agentIdentityId },
      data: { revokedAt: new Date() },
    });

    // Anyone can reach this unauthenticated route. Re-registering must NOT reinstate.
    const response = await register({
      merchantId: seeded.merchantId,
      protocol: 'ap2',
      externalAgentId: agent.externalAgentId,
      publicKey: validKey(),
    });

    expect(response.statusCode).toBe(201);

    const after = await prisma.agentIdentity.findUniqueOrThrow({
      where: { id: seeded.agentIdentityId },
      select: { revokedAt: true },
    });
    expect(after.revokedAt).not.toBeNull();
  });
});

describe('agent registration — input validation', () => {
  it('rejects a negative spending limit', async () => {
    const name = `reg-test-${randomUUID().slice(0, 8)}`;
    merchantNames.push(name);

    // Number.isInteger(-5) is true — the earlier check let this through.
    const response = await register({
      merchantName: name,
      protocol: 'ap2',
      externalAgentId: 'agent-neg',
      publicKey: validKey(),
      spendingLimitPaise: -500_000,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'malformed_request' });
  });

  it('rejects an absurdly large spending limit', async () => {
    const name = `reg-test-${randomUUID().slice(0, 8)}`;
    merchantNames.push(name);

    const response = await register({
      merchantName: name,
      protocol: 'ap2',
      externalAgentId: 'agent-big',
      publicKey: validKey(),
      spendingLimitPaise: 999_999_999_999,
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a publicKey that is not a 32-byte Ed25519 key', async () => {
    const name = `reg-test-${randomUUID().slice(0, 8)}`;
    merchantNames.push(name);

    for (const badKey of ['not-a-key', Buffer.from('short').toString('base64'), '']) {
      const response = await register({
        merchantName: name,
        protocol: 'ap2',
        externalAgentId: 'agent-badkey',
        publicKey: badKey,
      });
      expect(response.statusCode, `key: ${badKey}`).toBe(400);
    }
  });

  it('rejects an over-long externalAgentId', async () => {
    const name = `reg-test-${randomUUID().slice(0, 8)}`;
    merchantNames.push(name);

    const response = await register({
      merchantName: name,
      protocol: 'ap2',
      externalAgentId: 'a'.repeat(500),
      publicKey: validKey(),
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an over-long merchantName rather than creating it', async () => {
    const longName = 'm'.repeat(500);
    const response = await register({
      merchantName: longName,
      protocol: 'ap2',
      externalAgentId: 'agent-longmerchant',
      publicKey: validKey(),
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.merchant.count({ where: { name: longName } })).toBe(0);
  });

  it('rejects an unknown merchantId instead of silently creating one', async () => {
    const response = await register({
      merchantId: '00000000-0000-0000-0000-000000000000',
      protocol: 'ap2',
      externalAgentId: 'agent-ghost',
      publicKey: validKey(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'unknown_merchant' });
  });
});
