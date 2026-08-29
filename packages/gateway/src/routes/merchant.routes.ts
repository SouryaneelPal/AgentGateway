/**
 * Merchant-facing routes consumed by the Next.js dashboard (§2.4).
 * Handlers land in Phase 5 (the dashboard phase); the surface is fixed here so
 * lib/api-client.ts in packages/dashboard has something real to type against.
 */

import type { FastifyPluginAsync } from 'fastify';
import { NotImplementedError } from '../errors.js';

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
