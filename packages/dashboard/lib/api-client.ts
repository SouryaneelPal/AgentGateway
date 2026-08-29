/**
 * Typed client for the merchant-facing routes in WHITEPAPER.md §2.4.
 *
 * The request/response types are declared now so the Phase 5 screens are written
 * against a fixed contract; the gateway handlers currently answer 501, which
 * `request()` surfaces as a typed GatewayError rather than a silent failure.
 */

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:3000';

export type ProtocolName = 'x402' | 'ap2' | 'fallback';

export type PaymentRequestStatus =
  'pending' | 'awaiting_settlement' | 'settled' | 'failed' | 'rejected';

/** merchants.policy in §2.3. */
export interface MerchantPolicy {
  maxAutoApprovePaise: number;
  blockedCategories: string[];
  enabledProtocols: ProtocolName[];
}

/** A row of payment_requests, as the dashboard needs it. */
export interface TransactionSummary {
  id: string;
  protocol: ProtocolName;
  status: PaymentRequestStatus;
  normalizedAmountPaise: number;
  normalizedCurrency: 'INR';
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A row of audit_log (§2.3). */
export interface AuditLogEntry {
  id: string;
  actorType: 'agent' | 'merchant' | 'system';
  actorId: string | null;
  action: string;
  paymentRequestId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AgentIdentitySummary {
  id: string;
  protocol: ProtocolName;
  externalAgentId: string;
  trustLevel: 'untrusted' | 'provisional' | 'trusted';
  spendingLimitPaise: number;
  spentPaise: number;
  revokedAt: string | null;
}

export interface TransactionFilters {
  status?: PaymentRequestStatus;
  protocol?: ProtocolName;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    cache: 'no-store',
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : `${init?.method ?? 'GET'} ${path} failed with ${response.status}`;
    throw new GatewayError(response.status, body, message);
  }

  return body as T;
}

/** GET /v1/merchant/policy — fetch current guardrails. */
export function getPolicy(): Promise<MerchantPolicy> {
  return request<MerchantPolicy>('/v1/merchant/policy');
}

/** PUT /v1/merchant/policy — update spend caps, blocked categories, enabled protocols. */
export function updatePolicy(policy: MerchantPolicy): Promise<MerchantPolicy> {
  return request<MerchantPolicy>('/v1/merchant/policy', {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
}

/** GET /v1/merchant/transactions?status=&protocol= — unified cross-protocol log. */
export function listTransactions(filters: TransactionFilters = {}): Promise<TransactionSummary[]> {
  const query = new URLSearchParams();
  if (filters.status !== undefined) query.set('status', filters.status);
  if (filters.protocol !== undefined) query.set('protocol', filters.protocol);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<TransactionSummary[]>(`/v1/merchant/transactions${suffix}`);
}

/** GET /v1/merchant/audit-log?payment_request_id= — full decision trail for one request. */
export function getAuditLog(paymentRequestId: string): Promise<AuditLogEntry[]> {
  const query = new URLSearchParams({ payment_request_id: paymentRequestId });
  return request<AuditLogEntry[]>(`/v1/merchant/audit-log?${query.toString()}`);
}

/** POST /v1/merchant/agents/:id/revoke — immediately revoke an agent identity. */
export function revokeAgent(agentId: string): Promise<AgentIdentitySummary> {
  return request<AgentIdentitySummary>(
    `/v1/merchant/agents/${encodeURIComponent(agentId)}/revoke`,
    { method: 'POST' },
  );
}

/**
 * GET /v1/merchant/stream — SSE stream of live transaction/audit events.
 * Returns the EventSource so the caller owns its lifecycle.
 */
export function openEventStream(): EventSource {
  return new EventSource(`${GATEWAY_URL}/v1/merchant/stream`);
}
