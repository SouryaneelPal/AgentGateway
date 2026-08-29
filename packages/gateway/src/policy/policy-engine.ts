/**
 * Policy Engine (§2.1) — IMPLEMENTED (Phase 2).
 *
 * Enforces merchant-defined guardrails centrally, independent of which protocol the
 * request arrived on: agent revocation, enabled protocols, category restrictions,
 * human-approval thresholds, and the row-locked spend cap from §3.5.
 *
 * Guardrail order matters. The spend cap is checked LAST, because passing it debits
 * spent_paise — there is no point consuming budget for a request that a cheaper check
 * would have rejected, and no point debiting for one that still needs a human to say
 * yes. Everything above the cap is a pure read.
 */

import { type Prisma } from '../generated/prisma/index.js';
import { prisma } from '../db/prisma-client.js';
import type { NormalizedPaymentRequest } from '../adapters/protocol-adapter.interface.js';
import { checkSpendCap, type SpendCapDecision, type SpendCapRejection } from './spend-cap.js';

/** Mirrors merchants.policy in §2.3. */
export interface MerchantPolicy {
  readonly maxAutoApprovePaise: number;
  readonly blockedCategories: readonly string[];
  readonly enabledProtocols: readonly ('x402' | 'ap2' | 'fallback')[];
}

export type PolicyDecision =
  | { readonly outcome: 'approved'; readonly remainingPaise: bigint }
  | { readonly outcome: 'requires_human_approval'; readonly reason: string }
  | {
      readonly outcome: 'rejected';
      readonly code: 'spend_cap_exceeded';
      readonly detail: SpendCapRejection;
    }
  | {
      readonly outcome: 'rejected';
      readonly code: 'category_blocked' | 'protocol_disabled' | 'agent_revoked';
      readonly detail: Readonly<Record<string, unknown>>;
    };

const DEFAULT_POLICY: MerchantPolicy = {
  // 0 means "no auto-approval ceiling configured" — treated as unlimited rather than
  // as "approve nothing", so an unconfigured merchant is not silently bricked.
  maxAutoApprovePaise: 0,
  blockedCategories: [],
  enabledProtocols: ['fallback'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * merchants.policy is free-form JSONB (§2.3), so every field is validated rather than
 * cast. A malformed policy falls back to the safe default for that field alone.
 */
export function parseMerchantPolicy(
  raw: unknown,
  enabledProtocolsColumn: string[],
): MerchantPolicy {
  const source = isRecord(raw) ? raw : {};

  const ceiling = source['maxAutoApprovePaise'];
  const blocked = readStringArray(source['blockedCategories']);

  // The dedicated enabled_protocols column is authoritative; the JSON mirror is a
  // convenience copy and is only consulted if the column is empty.
  const fromColumn = enabledProtocolsColumn.filter(
    (p): p is 'x402' | 'ap2' | 'fallback' => p === 'x402' || p === 'ap2' || p === 'fallback',
  );
  const fromJson = (readStringArray(source['enabledProtocols']) ?? []).filter(
    (p): p is 'x402' | 'ap2' | 'fallback' => p === 'x402' || p === 'ap2' || p === 'fallback',
  );

  return {
    maxAutoApprovePaise:
      typeof ceiling === 'number' && Number.isInteger(ceiling) && ceiling >= 0
        ? ceiling
        : DEFAULT_POLICY.maxAutoApprovePaise,
    blockedCategories: blocked ?? DEFAULT_POLICY.blockedCategories,
    enabledProtocols:
      fromColumn.length > 0
        ? fromColumn
        : fromJson.length > 0
          ? fromJson
          : DEFAULT_POLICY.enabledProtocols,
  };
}

/** Best-effort category extraction from the adapter's metadata bag (§2.2). */
function readCategory(metadata: Record<string, unknown>): string | undefined {
  const category = metadata['category'];
  return typeof category === 'string' ? category : undefined;
}

export class PolicyEngine {
  /**
   * Runs the guardrails in order:
   *   1. agent revoked?        (agent_identities.revoked_at, checked on every request)
   *   2. protocol enabled?     (merchants.enabled_protocols)
   *   3. category blocked?     (merchants.policy.blockedCategories)
   *   4. over the ceiling?     -> requires_human_approval, budget NOT debited
   *   5. spend cap available?  (row-locked, §3.5 — debits on success)
   *
   * Every rejecting branch writes to audit_log so the merchant dashboard can explain
   * the decision without anyone reading server logs.
   */
  async evaluate(
    request: NormalizedPaymentRequest,
    paymentRequestId: string | null = null,
  ): Promise<PolicyDecision> {
    const agent = await prisma.agentIdentity.findUnique({
      where: { id: request.agentIdentityId },
      select: {
        id: true,
        protocol: true,
        revokedAt: true,
        merchant: { select: { id: true, policy: true, enabledProtocols: true } },
      },
    });

    if (agent === null) {
      return this.reject('agent_revoked', request, paymentRequestId, {
        reason: 'unknown_agent_identity',
        agentIdentityId: request.agentIdentityId,
      });
    }

    if (agent.revokedAt !== null) {
      return this.reject('agent_revoked', request, paymentRequestId, {
        revokedAt: agent.revokedAt.toISOString(),
      });
    }

    const policy = parseMerchantPolicy(agent.merchant.policy, agent.merchant.enabledProtocols);

    if (!policy.enabledProtocols.includes(request.sourceProtocol)) {
      return this.reject('protocol_disabled', request, paymentRequestId, {
        protocol: request.sourceProtocol,
        enabledProtocols: [...policy.enabledProtocols],
      });
    }

    const category = readCategory(request.metadata);
    if (category !== undefined && policy.blockedCategories.includes(category)) {
      return this.reject('category_blocked', request, paymentRequestId, {
        category,
        blockedCategories: [...policy.blockedCategories],
      });
    }

    const amountPaise = BigInt(request.amountPaise);
    const ceiling = BigInt(policy.maxAutoApprovePaise);
    const overCeiling = ceiling > 0n && amountPaise > ceiling;

    if (request.requiresHumanApproval || overCeiling) {
      return {
        outcome: 'requires_human_approval',
        reason: overCeiling
          ? `amount ${request.amountPaise} exceeds auto-approve ceiling ${policy.maxAutoApprovePaise}`
          : 'adapter flagged the request as requiring human approval',
      };
    }

    const decision = await this.checkSpendCap(
      request.agentIdentityId,
      amountPaise,
      paymentRequestId,
    );

    if (!decision.allowed) {
      // checkSpendCap already wrote its own audit row inside the locked transaction.
      return { outcome: 'rejected', code: 'spend_cap_exceeded', detail: decision.rejection };
    }

    return { outcome: 'approved', remainingPaise: decision.remainingPaise };
  }

  /** Re-exported so callers depend on the engine rather than reaching past it. */
  async checkSpendCap(
    agentIdentityId: string,
    requestedAmountPaise: bigint,
    paymentRequestId: string | null = null,
  ): Promise<SpendCapDecision> {
    return checkSpendCap({ agentIdentityId, requestedAmountPaise, paymentRequestId });
  }

  private async reject(
    code: 'category_blocked' | 'protocol_disabled' | 'agent_revoked',
    request: NormalizedPaymentRequest,
    paymentRequestId: string | null,
    detail: Record<string, unknown>,
  ): Promise<PolicyDecision> {
    await prisma.auditLog.create({
      data: {
        actorType: 'agent',
        actorId: request.agentIdentityId,
        action: `${code}_rejected`,
        paymentRequestId,
        detail: detail as Prisma.InputJsonObject,
      },
    });

    return { outcome: 'rejected', code, detail };
  }
}

export const policyEngine = new PolicyEngine();
