/**
 * Typed client for the merchant API (§2.4, authenticated per §3.6).
 *
 * Every call carries the merchant API key as a bearer token. The key is supplied by the
 * operator at the door and held in sessionStorage — see lib/session.ts for why that,
 * rather than localStorage, is the right store for a credential.
 */

import { clearApiKey, getApiKey, notifyAuthFailure, GATEWAY_URL } from './session';

export type ProtocolName = 'x402' | 'ap2' | 'fallback';
export type PaymentStatus = 'pending' | 'awaiting_settlement' | 'settled' | 'failed' | 'rejected';

export interface MerchantPolicy {
  merchant_id: string;
  merchant_name?: string;
  max_auto_approve_paise: number;
  blocked_categories: string[];
  enabled_protocols: ProtocolName[];
}

export interface Transaction {
  payment_request_id: string;
  protocol: ProtocolName;
  status: PaymentStatus;
  rejection_reason: string | null;
  amount_paise: number;
  currency: string;
  agent_identity_id: string;
  external_agent_id: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEntry {
  id: string;
  actor_type: 'agent' | 'merchant' | 'system';
  actor_id: string | null;
  action: string;
  payment_request_id: string | null;
  /** Plain-language sentence, rendered by the gateway so every client agrees. */
  explanation: string;
  detail: unknown;
  created_at: string;
}

export interface AgentIdentity {
  agent_identity_id: string;
  protocol: ProtocolName;
  external_agent_id: string;
  trust_level: 'untrusted' | 'provisional' | 'trusted';
  has_public_key: boolean;
  spending_limit_paise: number;
  spent_paise: number;
  remaining_paise: number;
  revoked_at: string | null;
  created_at: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** True when the key is missing, wrong or revoked — the door needs reopening. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }
}

/**
 * Builds the Authorization header. Exported so it can be tested directly: attaching the
 * key to every call is the one thing in this client that must never silently regress.
 */
export function authHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey !== null && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Thrown when the gateway could not be reached at all.
 *
 * Distinct from ApiError, which means the gateway answered and said no. The two need
 * different words on screen: "the gateway is not running" is a different problem from
 * "the gateway refused this", and telling an operator the wrong one sends them to debug
 * the wrong thing.
 */
export class NetworkError extends Error {
  /** Named `reason`, not `cause`: Error already defines `cause` and shadowing it needs
      an override modifier for no benefit. */
  readonly reason: unknown;

  constructor(reason: unknown) {
    super('Could not reach the gateway.');
    this.name = 'NetworkError';
    this.reason = reason;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_URL}${path}`, {
      ...init,
      headers: { ...authHeaders(getApiKey()), ...init.headers },
      cache: 'no-store',
    });
  } catch (cause) {
    // fetch() rejects only for transport failures — gateway down, DNS, CORS, offline.
    throw new NetworkError(cause);
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      typeof body === 'object' && body !== null && 'detail' in body
        ? String((body as { detail: unknown }).detail)
        : typeof body === 'object' && body !== null && 'error' in body
          ? String((body as { error: unknown }).error)
          : `${init.method ?? 'GET'} ${path} failed`;

    // A dead key is a session-level event, not this screen's problem. Drop it and tell
    // the Shell, which puts the key gate back without a reload.
    if (response.status === 401) {
      clearApiKey();
      notifyAuthFailure();
    }

    throw new ApiError(response.status, body, detail);
  }

  return body as T;
}

/**
 * Turns any thrown value into a sentence worth showing an operator.
 *
 * Centralised so every screen words the same failure identically — the console should
 * not describe the same dead gateway three different ways depending on which tab is open.
 */
export function describeFailure(cause: unknown, fallback: string): string {
  if (cause instanceof NetworkError) {
    return `Could not reach the gateway at ${GATEWAY_URL}. Check that it is running, then try again.`;
  }
  if (cause instanceof ApiError) {
    if (cause.isAuthFailure) return 'Your API key is no longer valid.';
    if (cause.status >= 500) {
      return 'The gateway failed to handle this request. Check its logs for the request id.';
    }
    return cause.message;
  }
  return cause instanceof Error ? cause.message : fallback;
}

export function getPolicy(): Promise<MerchantPolicy> {
  return request<MerchantPolicy>('/v1/merchant/policy');
}

export function updatePolicy(input: {
  max_auto_approve_paise: number;
  blocked_categories: string[];
  enabled_protocols: ProtocolName[];
}): Promise<MerchantPolicy> {
  return request<MerchantPolicy>('/v1/merchant/policy', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function listTransactions(filters: { status?: string; protocol?: string } = {}): Promise<{
  transactions: Transaction[];
}> {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.protocol) query.set('protocol', filters.protocol);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<{ transactions: Transaction[] }>(`/v1/merchant/transactions${suffix}`);
}

export function getAuditLog(paymentRequestId?: string): Promise<{ entries: AuditEntry[] }> {
  const suffix =
    paymentRequestId === undefined
      ? ''
      : `?payment_request_id=${encodeURIComponent(paymentRequestId)}`;
  return request<{ entries: AuditEntry[] }>(`/v1/merchant/audit-log${suffix}`);
}

export function listAgents(): Promise<{ agents: AgentIdentity[] }> {
  return request<{ agents: AgentIdentity[] }>('/v1/merchant/agents');
}

export function revokeAgent(agentId: string): Promise<{
  agent_identity_id: string;
  external_agent_id: string;
  revoked_at: string;
  already_revoked: boolean;
}> {
  return request(`/v1/merchant/agents/${encodeURIComponent(agentId)}/revoke`, { method: 'POST' });
}

/**
 * Opens the SSE feed.
 *
 * EventSource cannot send an Authorization header, so the key travels as a query
 * parameter here. That is a real trade-off and worth naming: it means the key can land
 * in server access logs. Acceptable for a local demo console; a production build would
 * use a short-lived stream ticket minted by an authenticated POST instead.
 */
export function openStream(): EventSource {
  const key = getApiKey() ?? '';
  return new EventSource(`${GATEWAY_URL}/v1/merchant/stream?api_key=${encodeURIComponent(key)}`);
}
