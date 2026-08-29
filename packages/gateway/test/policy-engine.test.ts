/**
 * PolicyEngine guardrail-chain tests (§2.3 merchants.policy, §3.5) — Phase 2.
 *
 * Covers the ordering property that matters: the spend cap is checked LAST, so a
 * request rejected by a cheaper guardrail — or one still awaiting human approval —
 * never debits spent_paise.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { PolicyEngine, parseMerchantPolicy } from '../src/policy/policy-engine.js';
import { prisma } from '../src/db/prisma-client.js';
import type { NormalizedPaymentRequest } from '../src/adapters/protocol-adapter.interface.js';
import { cleanup, readAgent, seedAgent, type SeededAgent } from './helpers/db.js';

const engine = new PolicyEngine();
const created: SeededAgent[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const seeded = created.pop();
    if (seeded !== undefined) await cleanup(seeded);
  }
});

function request(
  seeded: SeededAgent,
  overrides: Partial<NormalizedPaymentRequest> = {},
): NormalizedPaymentRequest {
  return {
    merchantId: seeded.merchantId,
    agentIdentityId: seeded.agentIdentityId,
    amountPaise: 50_000,
    currency: 'INR',
    idempotencyKey: 'test-key',
    sourceProtocol: 'ap2',
    requiresHumanApproval: false,
    metadata: {},
    ...overrides,
  };
}

describe('parseMerchantPolicy', () => {
  it('falls back to safe defaults for a malformed policy blob', () => {
    const policy = parseMerchantPolicy({ maxAutoApprovePaise: 'lots', blockedCategories: 7 }, []);
    expect(policy.maxAutoApprovePaise).toBe(0);
    expect(policy.blockedCategories).toEqual([]);
    expect(policy.enabledProtocols).toEqual(['fallback']);
  });

  it('treats the enabled_protocols column as authoritative over the JSON mirror', () => {
    const policy = parseMerchantPolicy({ enabledProtocols: ['fallback'] }, ['x402', 'ap2']);
    expect(policy.enabledProtocols).toEqual(['x402', 'ap2']);
  });

  it('discards protocol names that are not in the §2.3 CHECK list', () => {
    const policy = parseMerchantPolicy({}, ['x402', 'uap', 'nonsense']);
    expect(policy.enabledProtocols).toEqual(['x402']);
  });
});

describe('PolicyEngine.evaluate', () => {
  it('approves a request inside every guardrail and debits the cap', async () => {
    const seeded = await seedAgent({ spendingLimitPaise: 200_000n });
    created.push(seeded);

    const decision = await engine.evaluate(request(seeded));

    expect(decision.outcome).toBe('approved');
    expect((await readAgent(seeded.agentIdentityId)).spentPaise).toBe(50_000n);
  });

  it('rejects a revoked agent without debiting', async () => {
    const seeded = await seedAgent({ spendingLimitPaise: 200_000n, revoked: true });
    created.push(seeded);

    const decision = await engine.evaluate(request(seeded));

    expect(decision).toMatchObject({ outcome: 'rejected', code: 'agent_revoked' });
    expect((await readAgent(seeded.agentIdentityId)).spentPaise).toBe(0n);
    expect(
      await prisma.auditLog.count({
        where: { actorId: seeded.agentIdentityId, action: 'agent_revoked_rejected' },
      }),
    ).toBe(1);
  });

  it('rejects a protocol the merchant has not enabled', async () => {
    const seeded = await seedAgent({
      spendingLimitPaise: 200_000n,
      enabledProtocols: ['fallback'],
    });
    created.push(seeded);

    const decision = await engine.evaluate(request(seeded, { sourceProtocol: 'ap2' }));

    expect(decision).toMatchObject({ outcome: 'rejected', code: 'protocol_disabled' });
    expect((await readAgent(seeded.agentIdentityId)).spentPaise).toBe(0n);
  });

  it('rejects a blocked category', async () => {
    const seeded = await seedAgent({
      spendingLimitPaise: 200_000n,
      policy: { blockedCategories: ['gambling'] },
    });
    created.push(seeded);

    const decision = await engine.evaluate(request(seeded, { metadata: { category: 'gambling' } }));

    expect(decision).toMatchObject({ outcome: 'rejected', code: 'category_blocked' });
    expect((await readAgent(seeded.agentIdentityId)).spentPaise).toBe(0n);
  });

  it('requires human approval above the ceiling, and does NOT debit the cap', async () => {
    const seeded = await seedAgent({
      spendingLimitPaise: 200_000n,
      policy: { maxAutoApprovePaise: 10_000 },
    });
    created.push(seeded);

    const decision = await engine.evaluate(request(seeded, { amountPaise: 50_000 }));

    expect(decision.outcome).toBe('requires_human_approval');
    // Budget must not be consumed for something a human has not approved yet.
    expect((await readAgent(seeded.agentIdentityId)).spentPaise).toBe(0n);
  });

  it('returns the §3.5 typed rejection when the cap is breached', async () => {
    const seeded = await seedAgent({ spendingLimitPaise: 40_000n });
    created.push(seeded);

    const decision = await engine.evaluate(request(seeded, { amountPaise: 50_000 }));

    expect(decision).toMatchObject({
      outcome: 'rejected',
      code: 'spend_cap_exceeded',
      detail: { error: 'spend_cap_exceeded', requested: 50_000, remaining: 40_000 },
    });
  });
});
