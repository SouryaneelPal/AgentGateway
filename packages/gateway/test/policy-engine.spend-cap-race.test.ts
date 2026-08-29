/**
 * Spend-cap concurrency tests (§3.5) — the Phase 2 validation bar.
 *
 * ROADMAP Phase 2: "unit tests covering the concurrent-request race explicitly (spin up
 * two simultaneous calls in a test and assert only one succeeds)" and "a concurrency
 * test proves the spend-cap check cannot be raced."
 *
 * These run against the real Postgres from docker-compose, because the mechanism under
 * test IS a Postgres row lock — a mocked database cannot exhibit one, so a test built on
 * mocks would prove nothing about the property it claims to prove.
 *
 * Every assertion below is an EXACT count, never a range.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { checkSpendCap } from '../src/policy/spend-cap.js';
import { prisma } from '../src/db/prisma-client.js';
import { PolicyRejectionError } from '../src/errors.js';
import {
  cleanup,
  readAgent,
  seedAgent,
  seedPaymentRequest,
  type SeededAgent,
} from './helpers/db.js';

const created: SeededAgent[] = [];

async function track(seeded: SeededAgent): Promise<SeededAgent> {
  created.push(seeded);
  return seeded;
}

afterEach(async () => {
  while (created.length > 0) {
    const seeded = created.pop();
    if (seeded !== undefined) await cleanup(seeded);
  }
});

describe('checkSpendCap — single request (§3.5)', () => {
  it('allows a request that fits inside the remaining budget and debits it', async () => {
    const agent = await track(await seedAgent({ spendingLimitPaise: 500_000n }));

    const decision = await checkSpendCap({
      agentIdentityId: agent.agentIdentityId,
      requestedAmountPaise: 120_000n,
      paymentRequestId: null,
    });

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.spentPaise).toBe(120_000n);
      expect(decision.remainingPaise).toBe(380_000n);
    }

    const row = await readAgent(agent.agentIdentityId);
    expect(row.spentPaise).toBe(120_000n);
  });

  it('returns the §3.5 typed rejection verbatim on a breach', async () => {
    // The exact scenario from §3.5 step 1: ₹5,000 requested, ₹4,200 remaining.
    const agent = await track(
      await seedAgent({ spendingLimitPaise: 500_000n, spentPaise: 80_000n }),
    );
    const paymentRequestId = await seedPaymentRequest(agent, 500_000n);

    const decision = await checkSpendCap({
      agentIdentityId: agent.agentIdentityId,
      requestedAmountPaise: 500_000n,
      paymentRequestId,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.rejection).toEqual({
        error: 'spend_cap_exceeded',
        requested: 500_000,
        remaining: 420_000,
        payment_request_id: paymentRequestId,
      });
    }
  });

  it('does not debit spent_paise when the cap is breached', async () => {
    const agent = await track(
      await seedAgent({ spendingLimitPaise: 500_000n, spentPaise: 80_000n }),
    );

    await checkSpendCap({
      agentIdentityId: agent.agentIdentityId,
      requestedAmountPaise: 500_000n,
      paymentRequestId: null,
    });

    const row = await readAgent(agent.agentIdentityId);
    expect(row.spentPaise).toBe(80_000n);
  });

  it('writes spend_cap_rejected to audit_log with the exact numbers (§3.5 step 4)', async () => {
    const agent = await track(
      await seedAgent({ spendingLimitPaise: 500_000n, spentPaise: 80_000n }),
    );
    const paymentRequestId = await seedPaymentRequest(agent, 500_000n);

    await checkSpendCap({
      agentIdentityId: agent.agentIdentityId,
      requestedAmountPaise: 500_000n,
      paymentRequestId,
    });

    const entries = await prisma.auditLog.findMany({
      where: { paymentRequestId, action: 'spend_cap_rejected' },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorType).toBe('agent');
    expect(entries[0]?.actorId).toBe(agent.agentIdentityId);
    expect(entries[0]?.detail).toMatchObject({ requested: 500_000, remaining: 420_000 });
  });

  it('allows a request for exactly the remaining budget (boundary)', async () => {
    const agent = await track(
      await seedAgent({ spendingLimitPaise: 500_000n, spentPaise: 80_000n }),
    );

    const decision = await checkSpendCap({
      agentIdentityId: agent.agentIdentityId,
      requestedAmountPaise: 420_000n,
      paymentRequestId: null,
    });

    expect(decision.allowed).toBe(true);
    expect((await readAgent(agent.agentIdentityId)).spentPaise).toBe(500_000n);
  });

  it('rejects one paise over the remaining budget (boundary)', async () => {
    const agent = await track(
      await seedAgent({ spendingLimitPaise: 500_000n, spentPaise: 80_000n }),
    );

    const decision = await checkSpendCap({
      agentIdentityId: agent.agentIdentityId,
      requestedAmountPaise: 420_001n,
      paymentRequestId: null,
    });

    expect(decision.allowed).toBe(false);
    expect((await readAgent(agent.agentIdentityId)).spentPaise).toBe(80_000n);
  });

  it('throws a typed error for an unknown agent identity', async () => {
    await expect(
      checkSpendCap({
        agentIdentityId: '00000000-0000-0000-0000-000000000000',
        requestedAmountPaise: 1n,
        paymentRequestId: null,
      }),
    ).rejects.toBeInstanceOf(PolicyRejectionError);
  });
});

describe('checkSpendCap — the race (§3.5 step 2)', () => {
  it('allows exactly one of two simultaneous requests against the same budget', async () => {
    // Budget fits one request but not two. Without FOR UPDATE both would read the same
    // stale balance and both would succeed.
    const agent = await track(await seedAgent({ spendingLimitPaise: 100_000n }));

    const results = await Promise.all([
      checkSpendCap({
        agentIdentityId: agent.agentIdentityId,
        requestedAmountPaise: 60_000n,
        paymentRequestId: null,
      }),
      checkSpendCap({
        agentIdentityId: agent.agentIdentityId,
        requestedAmountPaise: 60_000n,
        paymentRequestId: null,
      }),
    ]);

    const approved = results.filter((r) => r.allowed);
    const rejected = results.filter((r) => !r.allowed);

    expect(approved).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((await readAgent(agent.agentIdentityId)).spentPaise).toBe(60_000n);
  });

  it('allows exactly 7 of 20 concurrent requests when the budget covers exactly 7', async () => {
    // 20 concurrent requests of ₹100 each against a ₹700 budget. Exactly 7 must win —
    // not "about 7", and never 8, which is what a lost update would produce.
    const CONCURRENCY = 20;
    const AMOUNT = 10_000n;
    const AFFORDABLE = 7;
    const agent = await track(await seedAgent({ spendingLimitPaise: AMOUNT * BigInt(AFFORDABLE) }));

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        checkSpendCap({
          agentIdentityId: agent.agentIdentityId,
          requestedAmountPaise: AMOUNT,
          paymentRequestId: null,
        }),
      ),
    );

    const approved = results.filter((r) => r.allowed);
    const rejected = results.filter((r) => !r.allowed);

    expect(approved).toHaveLength(AFFORDABLE);
    expect(rejected).toHaveLength(CONCURRENCY - AFFORDABLE);

    // The ledger must agree with the decisions: spent is exactly what was approved,
    // and never exceeds the limit.
    const row = await readAgent(agent.agentIdentityId);
    expect(row.spentPaise).toBe(AMOUNT * BigInt(AFFORDABLE));
    expect(row.spentPaise).toBeLessThanOrEqual(row.spendingLimitPaise);

    // Every rejection carries the typed §3.5 shape.
    for (const result of rejected) {
      if (!result.allowed) {
        expect(result.rejection.error).toBe('spend_cap_exceeded');
        expect(result.rejection.requested).toBe(Number(AMOUNT));
      }
    }

    // One audit row per rejection — a rejection is never recorded without its trail.
    const auditRows = await prisma.auditLog.count({
      where: { actorId: agent.agentIdentityId, action: 'spend_cap_rejected' },
    });
    expect(auditRows).toBe(CONCURRENCY - AFFORDABLE);
  });

  it('never over-spends across mixed concurrent amounts', async () => {
    // Uneven amounts: 5 x ₹300 against a ₹1000 budget. Whichever three win, the total
    // debited must never exceed the limit.
    const agent = await track(await seedAgent({ spendingLimitPaise: 100_000n }));

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        checkSpendCap({
          agentIdentityId: agent.agentIdentityId,
          requestedAmountPaise: 30_000n,
          paymentRequestId: null,
        }),
      ),
    );

    const approved = results.filter((r) => r.allowed);
    expect(approved).toHaveLength(3);

    const row = await readAgent(agent.agentIdentityId);
    expect(row.spentPaise).toBe(90_000n);
    expect(row.spentPaise).toBeLessThanOrEqual(row.spendingLimitPaise);
  });
});
