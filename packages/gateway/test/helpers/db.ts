/**
 * Test fixtures backed by the real Postgres from docker-compose.
 *
 * These tests deliberately do NOT mock the database: the thing under test in §3.5 is a
 * Postgres row lock, and a mock cannot exhibit a row lock. Every fixture is namespaced
 * with a random suffix so concurrent or repeated runs never collide, and each is torn
 * down by cascade from its merchant.
 */

import { randomUUID } from 'node:crypto';
import { type Prisma } from '../../src/generated/prisma/index.js';
import { prisma } from '../../src/db/prisma-client.js';
import { generateAgentKeypair } from '../../src/crypto/ed25519-verify.js';

export interface SeededAgent {
  readonly merchantId: string;
  readonly agentIdentityId: string;
}

export interface SeedAgentOptions {
  readonly spendingLimitPaise: bigint;
  readonly spentPaise?: bigint;
  readonly protocol?: 'x402' | 'ap2' | 'fallback';
  readonly enabledProtocols?: string[];
  readonly policy?: Prisma.InputJsonObject;
  readonly revoked?: boolean;
}

export async function seedAgent(options: SeedAgentOptions): Promise<SeededAgent> {
  const suffix = randomUUID().slice(0, 8);

  const merchant = await prisma.merchant.create({
    data: {
      name: `test-merchant-${suffix}`,
      razorpayKeyId: 'rzp_test_fixture',
      razorpayKeySecretEncrypted: 'fixture',
      enabledProtocols: options.enabledProtocols ?? ['x402', 'ap2', 'fallback'],
      policy: options.policy ?? {},
    },
    select: { id: true },
  });

  const agent = await prisma.agentIdentity.create({
    data: {
      merchantId: merchant.id,
      protocol: options.protocol ?? 'ap2',
      externalAgentId: `agent-${suffix}`,
      trustLevel: 'provisional',
      spendingLimitPaise: options.spendingLimitPaise,
      spentPaise: options.spentPaise ?? 0n,
      revokedAt: options.revoked === true ? new Date() : null,
    },
    select: { id: true },
  });

  return { merchantId: merchant.id, agentIdentityId: agent.id };
}

/** Seeds an agent with a registered Ed25519 public key, as §3.1's onboarding step does. */
export async function seedAgentWithKey(
  options: SeedAgentOptions & { protocol?: 'x402' | 'ap2' | 'fallback' },
): Promise<
  SeededAgent & { publicKeyBase64: string; privateKeyBase64: string; externalAgentId: string }
> {
  const keypair = generateAgentKeypair();
  const suffix = randomUUID().slice(0, 8);
  const externalAgentId = `agent-${suffix}`;

  const merchant = await prisma.merchant.create({
    data: {
      name: `test-merchant-${suffix}`,
      razorpayKeyId: 'rzp_test_fixture',
      razorpayKeySecretEncrypted: 'fixture',
      enabledProtocols: options.enabledProtocols ?? ['x402', 'ap2', 'fallback'],
      policy: options.policy ?? {},
    },
    select: { id: true },
  });

  const agent = await prisma.agentIdentity.create({
    data: {
      merchantId: merchant.id,
      protocol: options.protocol ?? 'ap2',
      externalAgentId,
      publicKey: keypair.publicKeyBase64,
      trustLevel: 'provisional',
      spendingLimitPaise: options.spendingLimitPaise,
      spentPaise: options.spentPaise ?? 0n,
      revokedAt: options.revoked === true ? new Date() : null,
    },
    select: { id: true },
  });

  return {
    merchantId: merchant.id,
    agentIdentityId: agent.id,
    externalAgentId,
    publicKeyBase64: keypair.publicKeyBase64,
    privateKeyBase64: keypair.privateKeyBase64,
  };
}

/** Creates a payment_requests row so audit_log's FK has something real to point at. */
export async function seedPaymentRequest(
  seeded: SeededAgent,
  amountPaise: bigint,
): Promise<string> {
  const row = await prisma.paymentRequest.create({
    data: {
      merchantId: seeded.merchantId,
      agentIdentityId: seeded.agentIdentityId,
      protocol: 'ap2',
      rawPayload: { fixture: true },
      normalizedAmountPaise: amountPaise,
      idempotencyKey: `idem-${randomUUID()}`,
    },
    select: { id: true },
  });
  return row.id;
}

export async function readAgent(
  agentIdentityId: string,
): Promise<{ spentPaise: bigint; spendingLimitPaise: bigint }> {
  return prisma.agentIdentity.findUniqueOrThrow({
    where: { id: agentIdentityId },
    select: { spentPaise: true, spendingLimitPaise: true },
  });
}

/** Removes every row this fixture created, children first. */
export async function cleanup(seeded: SeededAgent): Promise<void> {
  const requests = await prisma.paymentRequest.findMany({
    where: { merchantId: seeded.merchantId },
    select: { id: true },
  });
  const requestIds = requests.map((r) => r.id);

  await prisma.auditLog.deleteMany({ where: { paymentRequestId: { in: requestIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: seeded.agentIdentityId } });
  // mandates / razorpay_orders / receipts cascade from payment_requests (§2.3).
  await prisma.paymentRequest.deleteMany({ where: { merchantId: seeded.merchantId } });
  await prisma.agentIdentity.deleteMany({ where: { merchantId: seeded.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: seeded.merchantId } });
}
