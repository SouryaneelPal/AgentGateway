/**
 * Merchant-facing routes consumed by the Next.js dashboard (§2.4).
 * Handlers land in Phase 5 (the dashboard phase); the surface is fixed here so
 * lib/api-client.ts in packages/dashboard has something real to type against.
 */

import type { FastifyPluginAsync } from 'fastify';
import { NotImplementedError } from '../errors.js';
import { prisma } from '../db/prisma-client.js';
import { env } from '../config/env.js';

/** Caps on free-text identifiers accepted by the demo onboarding route. */
const MAX_IDENTIFIER_LENGTH = 128;
/** ₹10,00,000. Generous for test mode, finite by design. */
const MAX_SPENDING_LIMIT_PAISE = 100_000_000;

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
    // HARD KILL-SWITCH. This route is unauthenticated (Phase 4.5 will fix that); until
    // then it must be physically incapable of serving outside development, rather than
    // relying on nobody deploying it by accident.
    if (env.NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'not_found' });
    }

    const body = request.body;

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.code(400).send({ error: 'malformed_request' });
    }

    const fields = body as Record<string, unknown>;
    const protocol = fields['protocol'];
    const externalAgentId = fields['externalAgentId'];
    const publicKey = fields['publicKey'];
    const merchantId = fields['merchantId'];
    const merchantName = fields['merchantName'];
    const spendingLimitPaise = fields['spendingLimitPaise'];

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

    let resolvedMerchantId: string;

    if (typeof merchantId === 'string' && merchantId.length > 0) {
      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true },
      });
      if (merchant === null) {
        return reply.code(404).send({ error: 'unknown_merchant', merchantId });
      }
      resolvedMerchantId = merchant.id;
    } else {
      if (
        merchantName !== undefined &&
        (typeof merchantName !== 'string' || merchantName.length > MAX_IDENTIFIER_LENGTH)
      ) {
        return reply.code(400).send({
          error: 'malformed_request',
          detail: `merchantName max ${MAX_IDENTIFIER_LENGTH} chars`,
        });
      }
      const name =
        typeof merchantName === 'string' && merchantName.length > 0
          ? merchantName
          : 'agent-client-demo-merchant';
      const existing = await prisma.merchant.findFirst({ where: { name }, select: { id: true } });
      resolvedMerchantId =
        existing?.id ??
        (
          await prisma.merchant.create({
            data: {
              name,
              razorpayKeyId: '(demo merchant — gateway uses its own env credentials)',
              razorpayKeySecretEncrypted: '(not stored)',
              enabledProtocols: ['x402', 'ap2', 'fallback'],
            },
            select: { id: true },
          })
        ).id;
    }

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

  /** TODO(Phase 5): fetch current guardrails from merchants.policy. */
  app.get('/v1/merchant/policy', async () => {
    throw new NotImplementedError('GET /v1/merchant/policy', 'Phase 5');
  });

  /** TODO(Phase 5): update spend caps, blocked categories, enabled protocols. */
  app.put('/v1/merchant/policy', async (request) => {
    void request.body;
    throw new NotImplementedError('PUT /v1/merchant/policy', 'Phase 5');
  });

  /** TODO(Phase 5): unified cross-protocol transaction log. */
  app.get<{ Querystring: TransactionsQuery }>('/v1/merchant/transactions', async (request) => {
    void request.query;
    throw new NotImplementedError('GET /v1/merchant/transactions', 'Phase 5');
  });

  /** TODO(Phase 5): full decision trail for one transaction, from audit_log. */
  app.get<{ Querystring: AuditLogQuery }>('/v1/merchant/audit-log', async (request) => {
    void request.query;
    throw new NotImplementedError('GET /v1/merchant/audit-log', 'Phase 5');
  });

  /** TODO(Phase 5): set agent_identities.revoked_at; checked on every later request. */
  app.post<{ Params: AgentParams }>('/v1/merchant/agents/:id/revoke', async (request) => {
    void request.params.id;
    throw new NotImplementedError('POST /v1/merchant/agents/:id/revoke', 'Phase 5');
  });

  /** TODO(Phase 5): SSE stream of live transaction/audit events for the dashboard. */
  app.get('/v1/merchant/stream', async () => {
    throw new NotImplementedError('GET /v1/merchant/stream', 'Phase 5');
  });
};
