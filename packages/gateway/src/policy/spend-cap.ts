/**
 * Spend-cap enforcement (§3.5) — IMPLEMENTED (Phase 2).
 *
 * The whole point of this module is the race: two concurrent requests must never both
 * succeed against the same remaining budget. §5.3 records the decision to use
 * pessimistic locking (SELECT ... FOR UPDATE) over optimistic concurrency, because
 * spend-cap checks are low-frequency, high-consequence operations and a little lock
 * contention is a fine price for that guarantee.
 *
 * DELIBERATE DEVIATION FROM THE §3.5 PSEUDO-SQL: step 2 says "if false: ROLLBACK", but
 * step 4 requires the rejection to be written to audit_log. A ROLLBACK would discard
 * that audit row along with everything else. So on a breach this commits — writing the
 * audit row and leaving spent_paise untouched — which is identical to a rollback as far
 * as the money is concerned, and is the only way to satisfy both steps at once. The
 * rejection and its audit trail are therefore atomic: never one without the other.
 */

import { type Prisma } from '../generated/prisma/index.js';
import { prisma } from '../db/prisma-client.js';
import { PolicyRejectionError } from '../errors.js';

export interface SpendCapQuery {
  readonly agentIdentityId: string;
  readonly requestedAmountPaise: bigint;
  /**
   * The payment_requests row this check is for, echoed back in the rejection and
   * linked from the audit row. Null is allowed because the cap can be checked before a
   * payment_request exists (audit_log.payment_request_id is nullable in §2.3).
   */
  readonly paymentRequestId: string | null;
}

/**
 * The typed, machine-readable rejection from §3.5 step 3, verbatim:
 *   { "error": "spend_cap_exceeded", "requested": 500000, "remaining": 420000,
 *     "payment_request_id": "pr_..." }
 *
 * Snake-case `payment_request_id` is intentional — this object is the wire shape, so a
 * route can serialise it directly without reshaping.
 */
export interface SpendCapRejection {
  readonly error: 'spend_cap_exceeded';
  readonly requested: number;
  readonly remaining: number;
  readonly payment_request_id: string | null;
}

export type SpendCapDecision =
  | {
      readonly allowed: true;
      /** Budget left AFTER this request was debited. */
      readonly remainingPaise: bigint;
      readonly spentPaise: bigint;
    }
  | { readonly allowed: false; readonly rejection: SpendCapRejection };

interface AgentBudgetRow {
  readonly spending_limit_paise: unknown;
  readonly spent_paise: unknown;
}

/**
 * Postgres BIGINT arrives as bigint, number or string depending on the driver adapter
 * in play. Normalise rather than trusting one shape.
 */
function toBigInt(value: unknown, column: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return BigInt(value);
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  throw new TypeError(`Cannot read ${column} as BIGINT (received ${typeof value})`);
}

/** Paise always fit in a double; refuse to silently round if that ever stops being true. */
function toSafeNumber(value: bigint, label: string): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError(`${label} (${value.toString()}) exceeds Number.MAX_SAFE_INTEGER`);
  }
  return asNumber;
}

/**
 * Row-locked check-and-increment, exactly the transaction from §3.5:
 *
 *   BEGIN;
 *   SELECT spending_limit_paise, spent_paise FROM agent_identities WHERE id = $1 FOR UPDATE;
 *   -- (spending_limit_paise - spent_paise) >= requested_amount ?
 *   -- no  : write the audit row, commit without incrementing, return typed rejection
 *   -- yes : UPDATE agent_identities SET spent_paise = spent_paise + $amount WHERE id = $1;
 *   COMMIT;
 *
 * The FOR UPDATE is what makes this safe: a second concurrent transaction blocks on the
 * row lock until the first commits, so it reads the *post-increment* balance rather
 * than the stale one.
 */
export async function checkSpendCap(query: SpendCapQuery): Promise<SpendCapDecision> {
  const { agentIdentityId, requestedAmountPaise, paymentRequestId } = query;

  if (requestedAmountPaise <= 0n) {
    throw new RangeError('requestedAmountPaise must be positive');
  }

  return prisma.$transaction(
    async (tx): Promise<SpendCapDecision> => {
      // Prisma's query builder cannot express row locks, so the SELECT is raw. It runs
      // on the transaction's own connection, so the lock is held for the whole block.
      const rows = await tx.$queryRaw<AgentBudgetRow[]>`
        SELECT spending_limit_paise, spent_paise
        FROM agent_identities
        WHERE id = ${agentIdentityId}::uuid
        FOR UPDATE
      `;

      const row = rows[0];
      if (row === undefined) {
        throw new PolicyRejectionError(
          'unknown_agent',
          `No agent_identities row for id ${agentIdentityId}`,
          { agentIdentityId },
        );
      }

      const limit = toBigInt(row.spending_limit_paise, 'spending_limit_paise');
      const spent = toBigInt(row.spent_paise, 'spent_paise');
      const remaining = limit - spent;

      if (remaining < requestedAmountPaise) {
        // Breach. Record it with the exact numbers (§3.5 step 4) and commit without
        // touching spent_paise — see the deviation note at the top of this file.
        const rejection: SpendCapRejection = {
          error: 'spend_cap_exceeded',
          requested: toSafeNumber(requestedAmountPaise, 'requested'),
          remaining: toSafeNumber(remaining < 0n ? 0n : remaining, 'remaining'),
          payment_request_id: paymentRequestId,
        };

        await tx.auditLog.create({
          data: {
            actorType: 'agent',
            actorId: agentIdentityId,
            action: 'spend_cap_rejected',
            paymentRequestId,
            detail: {
              requested: rejection.requested,
              remaining: rejection.remaining,
              spendingLimitPaise: toSafeNumber(limit, 'spendingLimitPaise'),
              spentPaise: toSafeNumber(spent, 'spentPaise'),
            } satisfies Prisma.InputJsonObject,
          },
        });

        return { allowed: false, rejection };
      }

      const updated = await tx.agentIdentity.update({
        where: { id: agentIdentityId },
        data: { spentPaise: { increment: requestedAmountPaise } },
        select: { spentPaise: true, spendingLimitPaise: true },
      });

      return {
        allowed: true,
        spentPaise: updated.spentPaise,
        remainingPaise: updated.spendingLimitPaise - updated.spentPaise,
      };
    },
    {
      // Generous relative to the work done, because under contention a transaction
      // spends most of its time blocked on another holder's row lock.
      timeout: 20_000,
      maxWait: 20_000,
    },
  );
}
