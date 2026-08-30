/**
 * Proves the pipeline invariant that the Phase 3 report claimed architecturally:
 *
 *   settle() is unreachable except through runPaymentPipeline(), on the branch where
 *   PolicyEngine.evaluate() has already returned an approving outcome.
 *
 * The claim has three separable parts, and a test that only checks the happy path
 * proves none of them. Each is attacked directly below:
 *
 *   1. STRUCTURAL  — the pipeline is the only call site of `.settle(` in src/.
 *                    A future adapter or route cannot quietly add a second one without
 *                    this test failing.
 *   2. ORDERING    — when settle() does run, evaluate() ran first and approved.
 *   3. EXCLUSION   — on every rejecting branch, settle() is never called at all.
 *
 * And the honest counterweight (4): settle() is an exported public method, so it CAN be
 * invoked directly. The guarantee is not that the method is inaccessible — it is that
 * calling it outside the pipeline cannot fabricate a settlement, because it has no
 * persisted payment_requests row to attach to. That is asserted rather than asserted-away.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeForSigning } from '../src/crypto/canonicalize.js';
import { signCanonicalPayload } from '../src/crypto/ed25519-verify.js';
import { runPaymentPipeline } from '../src/pipeline/payment-pipeline.js';
import { ap2Adapter } from '../src/adapters/ap2.adapter.js';
import { policyEngine } from '../src/policy/policy-engine.js';
import { prisma } from '../src/db/prisma-client.js';
import { redis } from '../src/redis/redis-client.js';
import type { IncomingRequest } from '../src/adapters/protocol-adapter.interface.js';
import { cleanup, seedAgentWithKey, type SeededAgent } from './helpers/db.js';
import { installFakeRazorpay, type InstalledFakeRazorpay } from './helpers/fake-razorpay.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(here, '..', 'src');

const created: SeededAgent[] = [];
const nonces: string[] = [];
let razorpay: InstalledFakeRazorpay | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  razorpay?.restore();
  razorpay = undefined;
  for (const nonce of nonces.splice(0)) await redis.del(`nonce:${nonce}`);
  while (created.length > 0) {
    const seeded = created.pop();
    if (seeded !== undefined) await cleanup(seeded);
  }
});

// ---------------------------------------------------------------------------
// 1. STRUCTURAL
// ---------------------------------------------------------------------------

function walkTypeScript(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // The generated Prisma client is vendor output, not our source.
      if (entry.name === 'generated') continue;
      walkTypeScript(full, found);
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Comments mention settle() constantly; only real call sites count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('INVARIANT 1 — the pipeline is the only call site of settle()', () => {
  it('finds no `.settle(` call anywhere in src/ except payment-pipeline.ts', () => {
    const offenders: string[] = [];

    for (const file of walkTypeScript(SRC_ROOT)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (!/\.settle\s*\(/.test(code)) continue;

      const relativePath = relative(SRC_ROOT, file).split('\\').join('/');
      // The adapters DEFINE settle(); only calls matter, and a definition reads
      // `async settle(` with no leading dot, so it never matches the pattern above.
      if (relativePath !== 'pipeline/payment-pipeline.ts') offenders.push(relativePath);
    }

    expect(offenders).toEqual([]);
  });

  it('confirms the scan is real: it does see the pipeline call site', () => {
    const pipeline = stripComments(
      readFileSync(join(SRC_ROOT, 'pipeline', 'payment-pipeline.ts'), 'utf8'),
    );
    // Guards against the previous test passing vacuously because the regex or the
    // comment-stripper silently broke.
    expect(pipeline).toMatch(/adapter\.settle\s*\(/);
  });

  it('confirms every adapter still defines settle(), so the scan targets real methods', () => {
    for (const adapter of ['ap2.adapter.ts', 'x402.adapter.ts', 'fallback.adapter.ts']) {
      const code = stripComments(readFileSync(join(SRC_ROOT, 'adapters', adapter), 'utf8'));
      expect(code, adapter).toMatch(/async settle\s*\(/);
    }
  });

  it('finds no route that imports an adapter and calls settle on it', () => {
    const routeDir = join(SRC_ROOT, 'routes');
    for (const file of walkTypeScript(routeDir)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code, relative(SRC_ROOT, file)).not.toMatch(/\.settle\s*\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures for the behavioural halves
// ---------------------------------------------------------------------------

type KeyedAgent = Awaited<ReturnType<typeof seedAgentWithKey>>;

async function seed(options: Parameters<typeof seedAgentWithKey>[0]): Promise<KeyedAgent> {
  razorpay = installFakeRazorpay();
  const agent = await seedAgentWithKey(options);
  created.push(agent);
  return agent;
}

function mandateRequest(
  agent: KeyedAgent,
  overrides: Record<string, unknown> = {},
): IncomingRequest {
  const nonce = `n_${randomUUID()}`;
  nonces.push(nonce);

  const body: Record<string, unknown> = {
    mandateType: 'IntentMandate',
    agentId: agent.externalAgentId,
    merchantId: agent.merchantId,
    maxAmountPaise: 50_000,
    currency: 'INR',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...overrides,
    nonce,
  };
  body['signature'] = signCanonicalPayload(canonicalizeForSigning(body), agent.privateKeyBase64);

  return {
    method: 'POST',
    path: '/v1/ap2/mandates',
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
    body,
    params: {},
    query: {},
    receivedAt: new Date(),
  };
}

/** Records the interleaving of evaluate() and settle() so ordering can be asserted. */
function instrument(): { calls: string[] } {
  const calls: string[] = [];

  const realEvaluate = policyEngine.evaluate.bind(policyEngine);
  vi.spyOn(policyEngine, 'evaluate').mockImplementation(async (request, id) => {
    const decision = await realEvaluate(request, id);
    calls.push(`evaluate:${decision.outcome}`);
    return decision;
  });

  const realSettle = ap2Adapter.settle.bind(ap2Adapter);
  vi.spyOn(ap2Adapter, 'settle').mockImplementation(async (normalized) => {
    calls.push('settle');
    return realSettle(normalized);
  });

  return { calls };
}

// ---------------------------------------------------------------------------
// 2. ORDERING
// ---------------------------------------------------------------------------

describe('INVARIANT 2 — settle() only ever runs after an approving evaluate()', () => {
  it('records evaluate:approved strictly before settle on the happy path', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const { calls } = instrument();

    const outcome = await runPaymentPipeline(ap2Adapter, mandateRequest(agent));

    expect(outcome.kind).toBe('settled');
    expect(calls).toEqual(['evaluate:approved', 'settle']);
    // Ordering, stated as an index comparison so a reordering fails loudly.
    expect(calls.indexOf('evaluate:approved')).toBeLessThan(calls.indexOf('settle'));
  });

  it('never reaches settle without evaluate having been called at all', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const { calls } = instrument();

    await runPaymentPipeline(ap2Adapter, mandateRequest(agent));

    expect(calls.filter((c) => c === 'settle')).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('evaluate:'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. EXCLUSION
// ---------------------------------------------------------------------------

describe('INVARIANT 3 — every rejecting branch reaches settle() zero times', () => {
  it('spend cap breach: evaluate rejects, settle never runs', async () => {
    const agent = await seed({ spendingLimitPaise: 1_000n, protocol: 'ap2' });
    const { calls } = instrument();

    const outcome = await runPaymentPipeline(ap2Adapter, mandateRequest(agent));

    expect(outcome.kind).toBe('rejected');
    expect(calls).toEqual(['evaluate:rejected']);
    expect(calls).not.toContain('settle');
    expect(razorpay?.recorded.orders).toHaveLength(0);
  });

  it('revoked agent: settle never runs', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2', revoked: true });
    const { calls } = instrument();

    await runPaymentPipeline(ap2Adapter, mandateRequest(agent));

    expect(calls).not.toContain('settle');
    expect(razorpay?.recorded.orders).toHaveLength(0);
  });

  it('disabled protocol: settle never runs', async () => {
    const agent = await seed({
      spendingLimitPaise: 500_000n,
      protocol: 'ap2',
      enabledProtocols: ['fallback'],
    });
    const { calls } = instrument();

    await runPaymentPipeline(ap2Adapter, mandateRequest(agent));

    expect(calls).not.toContain('settle');
  });

  it('human-approval ceiling on a non-human-approval adapter: settle never runs', async () => {
    const agent = await seed({
      spendingLimitPaise: 500_000n,
      protocol: 'ap2',
      policy: { maxAutoApprovePaise: 10_000 },
    });
    const { calls } = instrument();

    await runPaymentPipeline(ap2Adapter, mandateRequest(agent, { maxAmountPaise: 50_000 }));

    expect(calls).toEqual(['evaluate:requires_human_approval']);
    expect(calls).not.toContain('settle');
  });

  it('failed validation: NEITHER evaluate nor settle runs (§3.1 hard reject)', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const { calls } = instrument();

    const request = mandateRequest(agent);
    // Tamper after signing.
    (request.body as Record<string, unknown>)['maxAmountPaise'] = 1;

    const outcome = await runPaymentPipeline(ap2Adapter, request);

    expect(outcome.kind).toBe('rejected');
    // The Policy Engine is never even consulted — that is §3.1's "never reaches the
    // Policy Engine or touches Razorpay".
    expect(calls).toEqual([]);
  });

  it('replayed nonce: settle never runs on the replay', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    const request = mandateRequest(agent);

    await runPaymentPipeline(ap2Adapter, { ...request, receivedAt: new Date() });

    const { calls } = instrument();
    await runPaymentPipeline(ap2Adapter, { ...request, receivedAt: new Date() });

    expect(calls).not.toContain('settle');
  });
});

// ---------------------------------------------------------------------------
// 4. THE HONEST LIMIT
// ---------------------------------------------------------------------------

describe('INVARIANT 4 — calling settle() directly cannot fabricate a settlement', () => {
  it('throws when invoked outside the pipeline, because no payment_requests row backs it', async () => {
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    razorpay = installFakeRazorpay();

    // Exactly what an attacker or a careless future caller would try: skip validate,
    // skip evaluate, hand settle() a well-formed NormalizedPaymentRequest directly.
    await expect(
      ap2Adapter.settle({
        merchantId: agent.merchantId,
        agentIdentityId: agent.agentIdentityId,
        amountPaise: 50_000,
        currency: 'INR',
        idempotencyKey: 'forged',
        sourceProtocol: 'ap2',
        requiresHumanApproval: false,
        metadata: {},
      }),
    ).rejects.toThrow(/requires a persisted payment_requests id/);

    // No Razorpay call was made, and no order row exists.
    expect(razorpay.recorded.orders).toHaveLength(0);
    expect(
      await prisma.razorpayOrder.count({
        where: { paymentRequest: { agentIdentityId: agent.agentIdentityId } },
      }),
    ).toBe(0);
  });

  it('documents the residual gap: a caller holding a real id CAN settle without policy', async () => {
    // Stated as a passing test rather than a comment, so the limit of the guarantee is
    // visible in the suite. settle() is a public method; the protection is structural
    // (invariant 1) plus the fact that a payment_requests row only exists because the
    // pipeline created one. If this ever needs to be a hard boundary, settle() would
    // have to take a capability object the pipeline alone can mint.
    const agent = await seed({ spendingLimitPaise: 500_000n, protocol: 'ap2' });
    razorpay = installFakeRazorpay();

    const paymentRequest = await prisma.paymentRequest.create({
      data: {
        merchantId: agent.merchantId,
        agentIdentityId: agent.agentIdentityId,
        protocol: 'ap2',
        rawPayload: {},
        normalizedAmountPaise: 50_000n,
        idempotencyKey: `direct-${randomUUID()}`,
        status: 'pending',
      },
      select: { id: true },
    });

    const result = await ap2Adapter.settle({
      merchantId: agent.merchantId,
      agentIdentityId: agent.agentIdentityId,
      amountPaise: 50_000,
      currency: 'INR',
      idempotencyKey: 'direct',
      sourceProtocol: 'ap2',
      requiresHumanApproval: false,
      metadata: { paymentRequestId: paymentRequest.id },
    });

    expect(result.status).toBe('awaiting_settlement');
    // Even here the trust boundary holds: settle() cannot mark anything 'settled'.
    expect(result.status).not.toBe('settled');
  });
});
