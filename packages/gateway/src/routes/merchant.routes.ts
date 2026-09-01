/**
 * Merchant-facing routes consumed by the Next.js dashboard (§2.4).
 * Handlers land in Phase 5 (the dashboard phase); the surface is fixed here so
 * lib/api-client.ts in packages/dashboard has something real to type against.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '../generated/prisma/index.js';
import { prisma } from '../db/prisma-client.js';
import { isAllowedOrigin } from '../config/cors.js';
// Bounds come from the shared module so these routes and the protocol adapters cannot
// drift apart on what counts as an acceptable identifier.
import {
  MAX_IDENTIFIER_LENGTH,
  MAX_SPENDING_LIMIT_PAISE,
  isSafeString,
  isUuid,
} from '../validation.js';
import { authenticatedMerchantId, requireMerchantAuth } from '../auth/merchant-auth.js';
import { parseMerchantPolicy } from '../policy/policy-engine.js';

const PROTOCOLS = ['x402', 'ap2', 'fallback'] as const;
type ProtocolName = (typeof PROTOCOLS)[number];

function isStringArray(value: unknown, maxLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= maxLength,
    )
  );
}

function toProtocolList(value: unknown): ProtocolName[] | null {
  if (!Array.isArray(value)) return null;
  const out: ProtocolName[] = [];
  for (const entry of value) {
    const match = PROTOCOLS.find((p) => p === entry);
    if (match === undefined) return null;
    if (!out.includes(match)) out.push(match);
  }
  return out;
}

function paise(value: unknown): string {
  return typeof value === 'number' ? `₹${(value / 100).toFixed(2)}` : 'an amount';
}

/**
 * Plain-language rendering of an audit action.
 *
 * The Phase 5 bar is that "the audit trail for a rejected mandate is fully readable by a
 * non-technical viewer without needing to read logs". A JSON blob does not clear that
 * bar, so every action gets a sentence a merchant can act on. The raw detail is still
 * returned alongside for the technical reader.
 */
export function explainAuditAction(action: string, detail: unknown): string {
  const d = (typeof detail === 'object' && detail !== null ? detail : {}) as Record<
    string,
    unknown
  >;

  switch (action) {
    case 'spend_cap_rejected':
      return `Declined: the agent asked to spend ${paise(d['requested'])} but only ${paise(d['remaining'])} was left on its spending limit. No payment was created and no money moved.`;
    case 'mandate_rejected':
      return d['reason'] === 'signature_invalid'
        ? "Declined: the agent's signature did not match the request it sent, so the gateway could not prove the request was genuine. It was refused before anything was recorded."
        : `Declined before processing: ${String(d['reason'] ?? 'the request failed verification')}.`;
    case 'agent_revoked_rejected':
      return 'Declined: this agent has been revoked, so it is no longer allowed to spend on your behalf.';
    case 'protocol_disabled_rejected':
      return `Declined: this agent used the ${String(d['protocol'] ?? 'requested')} protocol, which is currently switched off in your policy.`;
    case 'category_blocked_rejected':
      return `Declined: purchases in the "${String(d['category'] ?? 'requested')}" category are on your blocked list.`;
    case 'razorpay_order_created':
      return `Approved: a Razorpay order for ${paise(d['amountPaise'])} was created. It is not paid yet — settlement is confirmed only when Razorpay says so.`;
    case 'payment_link_created':
      return `A payment link for ${paise(d['amountPaise'])} was created and is waiting for a person to approve and pay it.`;
    case 'webhook_settled':
      return 'Confirmed by Razorpay: the payment completed and this request is now settled. This is the only step that can mark money as moved.';
    case 'agent_registered':
      return `A new agent (${String(d['externalAgentId'] ?? 'unnamed')}) was registered for the ${String(d['protocol'] ?? 'unknown')} protocol.`;
    case 'agent_revoked':
      return `Agent ${String(d['externalAgentId'] ?? '')} was revoked. Its next request will be refused.`;
    case 'policy_updated':
      return 'Your guardrails were updated.';
    default:
      return `Recorded: ${action.replace(/_/g, ' ')}.`;
  }
}

/** An Ed25519 public key is exactly 32 bytes, base64-encoded. */
function isEd25519PublicKey(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

interface AgentParams {
  readonly id: string;
}

interface TransactionsQuery {
  readonly status?: string;
  readonly protocol?: string;
}

interface AuditLogQuery {
  readonly payment_request_id?: string;
}

export const merchantRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Phase 4.5 — every route in this plugin requires a valid merchant API key.
   *
   * Registered as a scope-wide hook rather than per-route on purpose: a merchant route
   * added later is authenticated by default instead of by remembering to opt in.
   * POST /v1/merchant/agents/register is covered by this too — it is not a special case.
   */
  app.addHook('preHandler', requireMerchantAuth);

  /**
   * Agent onboarding (§3.1 step 1: "At onboarding, each agent registers an Ed25519
   * public key against its agent_identities row. The private key never touches the
   * gateway.").
   *
   * NOT in §2.4's route table — added in Phase 4 because the reference agent needs a
   * real onboarding path and §3.1 describes one. Deliberately the only merchant-facing
   * route implemented ahead of Phase 5.
   *
   * DEMO-ONLY CAVEAT: this endpoint is unauthenticated and will create a merchant by
   * name when no merchantId is supplied. That is acceptable for a test-mode build and
   * must not survive into anything production-facing — real onboarding belongs behind
   * merchant authentication (§5.4's production-hardening note).
   */
  app.post('/v1/merchant/agents/register', async (request, reply) => {
    const body = request.body;

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ error: 'malformed_request' });
    }

    const fields = body as Record<string, unknown>;
    const protocol = fields['protocol'];
    const externalAgentId = fields['externalAgentId'];
    const publicKey = fields['publicKey'];
    const spendingLimitPaise = fields['spendingLimitPaise'];

    // IDOR CLOSED: the merchant is derived from the authenticated API key and is never
    // read from the body. A caller holding merchant A's key cannot act on merchant B
    // even by supplying B's id — the field is not consulted at all.
    const resolvedMerchantId = authenticatedMerchantId(request);

    if ('merchantId' in fields || 'merchantName' in fields) {
      // Fail loudly rather than silently ignoring it, so a stale client is corrected
      // instead of quietly believing it chose the merchant.
      return reply.code(400).send({
        error: 'malformed_request',
        detail:
          'merchantId/merchantName are no longer accepted; the merchant is determined by the API key',
      });
    }

    if (protocol !== 'x402' && protocol !== 'ap2' && protocol !== 'fallback') {
      return reply.code(400).send({ error: 'malformed_request', detail: 'invalid protocol' });
    }
    if (
      typeof externalAgentId !== 'string' ||
      externalAgentId.length === 0 ||
      externalAgentId.length > MAX_IDENTIFIER_LENGTH
    ) {
      return reply.code(400).send({
        error: 'malformed_request',
        detail: `externalAgentId required, max ${MAX_IDENTIFIER_LENGTH} chars`,
      });
    }
    // §3.1: an AP2 agent without a registered public key can never be verified.
    if (protocol === 'ap2' && !isEd25519PublicKey(publicKey)) {
      // Accepting an arbitrary string would store a key that can never verify anything,
      // turning a registration-time error into a confusing signature failure much later.
      return reply.code(400).send({
        error: 'malformed_request',
        detail: 'publicKey must be a base64-encoded 32-byte Ed25519 public key',
      });
    }
    if (publicKey !== undefined && !isEd25519PublicKey(publicKey)) {
      return reply.code(400).send({ error: 'malformed_request', detail: 'publicKey is malformed' });
    }

    // Merchant creation is deliberately NOT reachable from an authenticated merchant
    // route — you cannot bootstrap a merchant with a key you do not yet have. It now
    // lives in the operator script scripts/create-merchant.ts.

    // Number.isInteger(-5) is true, so the previous check happily accepted a NEGATIVE
    // spending limit. Range is validated now, not just integrality.
    if (spendingLimitPaise !== undefined) {
      if (
        typeof spendingLimitPaise !== 'number' ||
        !Number.isInteger(spendingLimitPaise) ||
        spendingLimitPaise < 0 ||
        spendingLimitPaise > MAX_SPENDING_LIMIT_PAISE
      ) {
        return reply.code(400).send({
          error: 'malformed_request',
          detail: `spendingLimitPaise must be an integer between 0 and ${MAX_SPENDING_LIMIT_PAISE}`,
        });
      }
    }

    const limit = typeof spendingLimitPaise === 'number' ? BigInt(spendingLimitPaise) : 1_000_000n;

    const agent = await prisma.agentIdentity.upsert({
      where: {
        merchantId_protocol_externalAgentId: {
          merchantId: resolvedMerchantId,
          protocol,
          externalAgentId,
        },
      },
      create: {
        merchantId: resolvedMerchantId,
        protocol,
        externalAgentId,
        publicKey: typeof publicKey === 'string' ? publicKey : null,
        trustLevel: 'provisional',
        spendingLimitPaise: limit,
      },
      update: {
        publicKey: typeof publicKey === 'string' ? publicKey : null,
        spendingLimitPaise: limit,
        // revokedAt is deliberately NOT cleared here. An earlier version reset it on
        // re-registration, reasoning that re-onboarding implies reinstatement — but on
        // an unauthenticated route that means ANYONE can un-revoke a revoked agent by
        // re-registering it, defeating the revocation guardrail outright (§2.4's revoke
        // endpoint, and the Phase 5 requirement that revoking an agent blocks its very
        // next request). Reinstatement must be an explicit, merchant-authenticated
        // action, never a side effect of registration.
      },
      select: { id: true, protocol: true, externalAgentId: true, trustLevel: true },
    });

    await prisma.auditLog.create({
      data: {
        actorType: 'merchant',
        actorId: resolvedMerchantId,
        action: 'agent_registered',
        detail: { agentIdentityId: agent.id, protocol, externalAgentId },
      },
    });

    return reply.code(201).send({
      agent_identity_id: agent.id,
      merchant_id: resolvedMerchantId,
      protocol: agent.protocol,
      external_agent_id: agent.externalAgentId,
      trust_level: agent.trustLevel,
      spending_limit_paise: Number(limit),
    });
  });

  /**
   * GET /v1/merchant/policy — current guardrails (§2.4).
   * The merchant is the authenticated one; there is no merchantId parameter (§3.6).
   */
  app.get('/v1/merchant/policy', async (request, reply) => {
    const merchantId = authenticatedMerchantId(request);
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { id: true, name: true, policy: true, enabledProtocols: true },
    });

    const policy = parseMerchantPolicy(merchant.policy, merchant.enabledProtocols);

    return reply.code(200).send({
      merchant_id: merchant.id,
      merchant_name: merchant.name,
      max_auto_approve_paise: policy.maxAutoApprovePaise,
      blocked_categories: policy.blockedCategories,
      enabled_protocols: policy.enabledProtocols,
    });
  });

  /** PUT /v1/merchant/policy — update spend caps, blocked categories, enabled protocols. */
  app.put('/v1/merchant/policy', async (request, reply) => {
    const merchantId = authenticatedMerchantId(request);
    const body = request.body;

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ error: 'malformed_request' });
    }

    const fields = body as Record<string, unknown>;
    const ceiling = fields['max_auto_approve_paise'];
    const blocked = fields['blocked_categories'];
    const enabled = fields['enabled_protocols'];

    if (
      ceiling !== undefined &&
      (typeof ceiling !== 'number' ||
        !Number.isInteger(ceiling) ||
        ceiling < 0 ||
        ceiling > MAX_SPENDING_LIMIT_PAISE)
    ) {
      return reply.code(400).send({
        error: 'malformed_request',
        detail: `max_auto_approve_paise must be an integer between 0 and ${MAX_SPENDING_LIMIT_PAISE}`,
      });
    }

    if (blocked !== undefined && !isStringArray(blocked, MAX_IDENTIFIER_LENGTH)) {
      return reply.code(400).send({
        error: 'malformed_request',
        detail: 'blocked_categories must be an array of short strings',
      });
    }

    const protocols = enabled === undefined ? undefined : toProtocolList(enabled);
    if (enabled !== undefined && protocols === null) {
      return reply.code(400).send({
        error: 'malformed_request',
        detail: "enabled_protocols must be a subset of ['x402','ap2','fallback']",
      });
    }

    const current = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      select: { policy: true, enabledProtocols: true },
    });
    const merged = parseMerchantPolicy(current.policy, current.enabledProtocols);

    const nextPolicy = {
      maxAutoApprovePaise: typeof ceiling === 'number' ? ceiling : merged.maxAutoApprovePaise,
      blockedCategories: Array.isArray(blocked)
        ? (blocked as string[])
        : [...merged.blockedCategories],
      enabledProtocols: protocols ?? [...merged.enabledProtocols],
    };

    const updated = await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        policy: nextPolicy as Prisma.InputJsonObject,
        // enabled_protocols has a dedicated column and is authoritative (§2.3); keep
        // the JSON mirror in step so the two can never disagree.
        enabledProtocols: nextPolicy.enabledProtocols,
      },
      select: { id: true, policy: true, enabledProtocols: true },
    });

    await prisma.auditLog.create({
      data: {
        actorType: 'merchant',
        actorId: merchantId,
        action: 'policy_updated',
        detail: nextPolicy as Prisma.InputJsonObject,
      },
    });

    const saved = parseMerchantPolicy(updated.policy, updated.enabledProtocols);
    return reply.code(200).send({
      merchant_id: updated.id,
      max_auto_approve_paise: saved.maxAutoApprovePaise,
      blocked_categories: saved.blockedCategories,
      enabled_protocols: saved.enabledProtocols,
    });
  });

  /** GET /v1/merchant/transactions?status=&protocol= — unified cross-protocol log. */
  app.get<{ Querystring: TransactionsQuery }>(
    '/v1/merchant/transactions',
    async (request, reply) => {
      const merchantId = authenticatedMerchantId(request);
      const { status, protocol } = request.query;

      // These are filters, not identifiers, so they are bounded rather than enumerated —
      // an unknown value legitimately matches nothing. What they must NOT contain is a
      // control character: Postgres cannot store or compare U+0000, so a null byte here
      // raised error 22021 and surfaced as a 500. Query strings never reach the
      // body-wide hook in server.ts, which only inspects request.body.
      for (const [name, value] of [
        ['status', status],
        ['protocol', protocol],
      ] as const) {
        if (value !== undefined && !isSafeString(value, MAX_IDENTIFIER_LENGTH)) {
          return reply.code(400).send({
            error: 'malformed_request',
            detail: `${name} must be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} characters, free of control characters`,
          });
        }
      }

      const rows = await prisma.paymentRequest.findMany({
        where: {
          merchantId,
          ...(typeof status === 'string' && status.length > 0 ? { status } : {}),
          ...(typeof protocol === 'string' && protocol.length > 0 ? { protocol } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          protocol: true,
          status: true,
          rejectionReason: true,
          normalizedAmountPaise: true,
          normalizedCurrency: true,
          createdAt: true,
          updatedAt: true,
          agentIdentity: { select: { id: true, externalAgentId: true } },
          razorpayOrders: {
            select: { razorpayOrderId: true, razorpayPaymentId: true, status: true },
          },
        },
      });

      return reply.code(200).send({
        transactions: rows.map((row) => ({
          payment_request_id: row.id,
          protocol: row.protocol,
          status: row.status,
          rejection_reason: row.rejectionReason,
          amount_paise: Number(row.normalizedAmountPaise),
          currency: row.normalizedCurrency,
          agent_identity_id: row.agentIdentity.id,
          external_agent_id: row.agentIdentity.externalAgentId,
          razorpay_order_id: row.razorpayOrders[0]?.razorpayOrderId ?? null,
          razorpay_payment_id: row.razorpayOrders[0]?.razorpayPaymentId ?? null,
          created_at: row.createdAt.toISOString(),
          updated_at: row.updatedAt.toISOString(),
        })),
      });
    },
  );

  /**
   * GET /v1/merchant/audit-log?payment_request_id= — the full decision trail.
   *
   * Every row carries a plain-language `explanation` alongside the raw detail. The
   * Phase 5 bar is that a non-technical viewer can read this without opening logs, and
   * a JSON blob does not clear that bar on its own.
   */
  app.get<{ Querystring: AuditLogQuery }>('/v1/merchant/audit-log', async (request, reply) => {
    const merchantId = authenticatedMerchantId(request);
    const paymentRequestId = request.query.payment_request_id;

    // payment_request_id indexes a uuid column. Anything that is not a syntactically
    // valid UUID fails inside Postgres rather than matching no rows, which surfaced as a
    // 500 for what is plainly a bad request — the same defect Phase 7 fixed on the
    // protocol routes. Query parameters also bypass the body-wide control-character hook
    // in server.ts, which only inspects request.body, so a null byte lands here too.
    if (paymentRequestId !== undefined && !isUuid(paymentRequestId)) {
      return reply
        .code(400)
        .send({ error: 'malformed_request', detail: 'payment_request_id must be a UUID' });
    }

    if (typeof paymentRequestId === 'string' && paymentRequestId.length > 0) {
      // Scoped to the authenticated merchant: another tenant's request id yields
      // nothing rather than someone else's audit trail.
      const owned = await prisma.paymentRequest.findFirst({
        where: { id: paymentRequestId, merchantId },
        select: { id: true },
      });
      if (owned === null) {
        return reply.code(404).send({ error: 'payment_request_not_found' });
      }
    }

    const rows = await prisma.auditLog.findMany({
      where:
        typeof paymentRequestId === 'string' && paymentRequestId.length > 0
          ? { paymentRequestId }
          : { paymentRequest: { merchantId } },
      orderBy: { id: 'asc' },
      take: 500,
      select: {
        id: true,
        actorType: true,
        actorId: true,
        action: true,
        paymentRequestId: true,
        detail: true,
        createdAt: true,
      },
    });

    return reply.code(200).send({
      entries: rows.map((row) => ({
        id: row.id.toString(),
        actor_type: row.actorType,
        actor_id: row.actorId,
        action: row.action,
        payment_request_id: row.paymentRequestId,
        explanation: explainAuditAction(row.action, row.detail),
        detail: row.detail,
        created_at: row.createdAt.toISOString(),
      })),
    });
  });

  /** GET /v1/merchant/agents — agent identities for the authenticated merchant. */
  app.get('/v1/merchant/agents', async (request, reply) => {
    const merchantId = authenticatedMerchantId(request);

    const agents = await prisma.agentIdentity.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        protocol: true,
        externalAgentId: true,
        trustLevel: true,
        publicKey: true,
        spendingLimitPaise: true,
        spentPaise: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    return reply.code(200).send({
      agents: agents.map((agent) => ({
        agent_identity_id: agent.id,
        protocol: agent.protocol,
        external_agent_id: agent.externalAgentId,
        trust_level: agent.trustLevel,
        has_public_key: agent.publicKey !== null && agent.publicKey.length > 0,
        spending_limit_paise: Number(agent.spendingLimitPaise),
        spent_paise: Number(agent.spentPaise),
        remaining_paise: Number(agent.spendingLimitPaise - agent.spentPaise),
        revoked_at: agent.revokedAt?.toISOString() ?? null,
        created_at: agent.createdAt.toISOString(),
      })),
    });
  });

  /**
   * POST /v1/merchant/agents/:id/revoke — sets revoked_at, checked on every subsequent
   * request (§2.4). Scoped to the authenticated merchant, so one tenant cannot revoke
   * another's agent.
   */
  app.post<{ Params: AgentParams }>('/v1/merchant/agents/:id/revoke', async (request, reply) => {
    const merchantId = authenticatedMerchantId(request);

    // Route parameters bypass the body-wide control-character hook, and this one indexes
    // a uuid column — see the note on audit-log above.
    if (!isUuid(request.params.id)) {
      return reply
        .code(400)
        .send({ error: 'malformed_request', detail: 'agent id must be a UUID' });
    }

    const agent = await prisma.agentIdentity.findFirst({
      where: { id: request.params.id, merchantId },
      select: { id: true, revokedAt: true, externalAgentId: true },
    });

    if (agent === null) {
      return reply
        .code(404)
        .send({ error: 'agent_not_found', agent_identity_id: request.params.id });
    }

    if (agent.revokedAt !== null) {
      return reply.code(200).send({
        agent_identity_id: agent.id,
        revoked_at: agent.revokedAt.toISOString(),
        already_revoked: true,
      });
    }

    const revokedAt = new Date();
    await prisma.agentIdentity.update({ where: { id: agent.id }, data: { revokedAt } });

    await prisma.auditLog.create({
      data: {
        actorType: 'merchant',
        actorId: merchantId,
        action: 'agent_revoked',
        detail: {
          agentIdentityId: agent.id,
          externalAgentId: agent.externalAgentId,
        } as Prisma.InputJsonObject,
      },
    });

    return reply.code(200).send({
      agent_identity_id: agent.id,
      external_agent_id: agent.externalAgentId,
      revoked_at: revokedAt.toISOString(),
      already_revoked: false,
    });
  });

  /**
   * GET /v1/merchant/stream — SSE feed of live transaction/audit events.
   *
   * Polls for rows newer than the last one sent rather than holding a database
   * listener: at this scale it is simpler, and a dropped poll cycle self-heals on the
   * next tick where a missed NOTIFY would be lost. Heartbeats keep proxies from
   * closing an idle connection.
   */
  app.get('/v1/merchant/stream', async (request, reply) => {
    const merchantId = authenticatedMerchantId(request);

    // CORS has to be set HERE, by hand. This handler writes straight to reply.raw, so
    // @fastify/cors never sees the response and its headers are never applied — the
    // stream works fine from curl and is silently blocked in the browser, which is a
    // confusing way to fail.
    //
    // It MUST apply the same allowlist as the cors plugin in server.ts. It previously
    // echoed any origin back in development, which was the same reflect-anything
    // behaviour Phase 7 removed from the plugin — leaving it here would have meant the
    // documented policy and the actual policy disagreeing on one endpoint.
    const origin = request.headers.origin;
    const corsHeaders =
      typeof origin === 'string' && isAllowedOrigin(origin)
        ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }
        : {};

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...corsHeaders,
    });

    let lastAuditId = 0n;
    let closed = false;

    const send = (event: string, data: unknown): void => {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Start from the current tip so a new subscriber sees what happens next rather
    // than replaying the whole history.
    const latest = await prisma.auditLog.findFirst({
      where: { paymentRequest: { merchantId } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    lastAuditId = latest?.id ?? 0n;

    send('connected', { merchant_id: merchantId, since_audit_id: lastAuditId.toString() });

    const tick = async (): Promise<void> => {
      if (closed) return;
      try {
        const rows = await prisma.auditLog.findMany({
          where: { id: { gt: lastAuditId }, paymentRequest: { merchantId } },
          orderBy: { id: 'asc' },
          take: 50,
          select: {
            id: true,
            action: true,
            actorType: true,
            paymentRequestId: true,
            detail: true,
            createdAt: true,
            paymentRequest: {
              select: { protocol: true, status: true, normalizedAmountPaise: true },
            },
          },
        });

        for (const row of rows) {
          lastAuditId = row.id;
          send('audit', {
            id: row.id.toString(),
            action: row.action,
            actor_type: row.actorType,
            payment_request_id: row.paymentRequestId,
            protocol: row.paymentRequest?.protocol ?? null,
            status: row.paymentRequest?.status ?? null,
            amount_paise:
              row.paymentRequest === null ? null : Number(row.paymentRequest.normalizedAmountPaise),
            explanation: explainAuditAction(row.action, row.detail),
            created_at: row.createdAt.toISOString(),
          });
        }
      } catch (error) {
        request.log.warn({ err: error }, 'sse poll failed');
      }
    };

    const poll = setInterval(() => void tick(), 1_000);
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': keepalive\n\n');
    }, 15_000);

    const shutdown = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      reply.raw.end();
    };

    request.raw.on('close', shutdown);
    request.raw.on('error', shutdown);

    // Hand the socket to the stream; Fastify must not also try to reply.
    return reply;
  });
};
