/**
 * The ProtocolAdapter contract (WHITEPAPER.md §2.2).
 *
 * `ProtocolAdapter` and `NormalizedPaymentRequest` are transcribed verbatim from the
 * whitepaper. The supporting types it references but does not define — IncomingRequest,
 * ValidationResult, SettlementResult, ProtocolReceipt — are specified here so Phase 1
 * can compile against a real contract. Their field sets are drawn from §2.4 (routes and
 * headers), §3.1–3.2 (signatures, nonces, expiry) and §2.3 (persisted columns), and are
 * expected to be refined when the adapters are actually built in Phase 3.
 */

export type ProtocolName = 'x402' | 'ap2' | 'fallback';

/**
 * A protocol-agnostic view of the inbound HTTP request.
 *
 * `rawBody` is carried alongside the parsed body on purpose: §3.4 requires signature
 * verification over unparsed bytes, and re-serialising a parsed object will not
 * byte-match what the sender signed.
 */
export interface IncomingRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: Buffer;
  readonly body: unknown;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | string[] | undefined>>;
  readonly receivedAt: Date;
}

/** Why a protocol-native validation failed. Written to audit_log.detail.reason (§3.1). */
export type ValidationFailureReason =
  | 'malformed_request'
  | 'signature_invalid'
  | 'mandate_expired'
  | 'nonce_replayed'
  | 'envelope_mismatch'
  | 'reference_already_redeemed'
  | 'unknown_agent'
  | 'agent_revoked';

/** Protocol-native facts extracted during validate(), before normalisation. */
export interface ProtocolClaims {
  readonly merchantId: string;
  readonly agentIdentityId: string;
  readonly amountPaise: number;
  readonly nonce: string;
  readonly expiresAt: Date;
  /** Exact bytes that were signed — persisted to mandates.canonical_payload (§2.3). */
  readonly canonicalPayload: string;
  readonly signature: string;
  /** The original protocol-native payload, verbatim, for audit (§2.3 raw_payload). */
  readonly raw: Readonly<Record<string, unknown>>;
}

export type ValidationResult =
  | {
      readonly ok: true;
      readonly protocol: ProtocolName;
      readonly request: IncomingRequest;
      readonly claims: ProtocolClaims;
    }
  | {
      readonly ok: false;
      readonly protocol: ProtocolName;
      readonly reason: ValidationFailureReason;
      readonly detail: Readonly<Record<string, unknown>>;
    };

/** §2.2, verbatim. */
export interface NormalizedPaymentRequest {
  merchantId: string;
  agentIdentityId: string;
  amountPaise: number;
  currency: 'INR';
  idempotencyKey: string; // derived deterministically — see §3.3
  sourceProtocol: 'x402' | 'ap2' | 'fallback';
  requiresHumanApproval: boolean;
  metadata: Record<string, unknown>; // original protocol payload, for audit
}

/**
 * The outcome of triggering settlement.
 *
 * Note the statuses: an adapter can reach `awaiting_settlement`, never `settled`.
 * Only a signature-verified Razorpay webhook promotes a request to settled (§1.3) —
 * "the protocol layer proposes, but Razorpay's webhook confirms."
 */
export interface SettlementResult {
  readonly paymentRequestId: string;
  readonly status: 'awaiting_settlement' | 'settled' | 'failed';
  readonly razorpayOrderId: string | null;
  readonly razorpayPaymentId: string | null;
  /** Set by fallbackAdapter, which settles through a human-tapped Payment Link. */
  readonly paymentLinkUrl: string | null;
  readonly amountPaise: number;
  readonly currency: 'INR';
  readonly sourceProtocol: ProtocolName;
}

/** Persisted verbatim to receipts.protocol_shape (§2.3). */
export interface ProtocolReceipt {
  readonly protocol: ProtocolName;
  readonly paymentRequestId: string;
  readonly shape: Readonly<Record<string, unknown>>;
  readonly issuedAt: Date;
}

/** §2.2, verbatim. */
export interface ProtocolAdapter {
  readonly protocolName: 'x402' | 'ap2' | 'fallback';

  // Step 1: protocol-native validation (signatures, envelope structure, expiry)
  validate(rawRequest: IncomingRequest): Promise<ValidationResult>;

  // Step 2: convert a validated protocol-native request into the internal shape
  normalize(validated: ValidationResult): Promise<NormalizedPaymentRequest>;

  // Step 3: given policy approval, trigger real settlement via Razorpay
  settle(normalized: NormalizedPaymentRequest): Promise<SettlementResult>;

  // Step 4: convert the settlement outcome back into the protocol's receipt shape
  formatReceipt(result: SettlementResult): Promise<ProtocolReceipt>;
}

// ---------------------------------------------------------------------------
// Phase 3 additions.
//
// §2.2's ProtocolAdapter above is left exactly as the whitepaper declares it. The
// routing and policy machinery Phase 3 needs is layered on in a sub-interface rather
// than by editing that contract.
// ---------------------------------------------------------------------------

/**
 * Self-description used by the protocol router (§2.2: "the router doesn't need to know
 * anything protocol-specific — it just needs to know which adapter to hand a request
 * to"). Each adapter owns its own detection rule, so the router contains no protocol
 * knowledge at all: it only asks each registered adapter whether the request is theirs.
 */
export interface RoutableProtocolAdapter extends ProtocolAdapter {
  /** Does this adapter handle the incoming request? Inspected from headers/shape only. */
  matches(request: IncomingRequest): boolean;

  /**
   * True when this adapter's settle() path IS a human-approval flow — the fallback
   * adapter's Payment Link is exactly that. The pipeline uses this to decide whether a
   * `requires_human_approval` policy outcome is a stop condition or the intended route,
   * without needing to know which protocol it is looking at.
   */
  readonly settlesViaHumanApproval: boolean;
}

/**
 * Typed, machine-readable rejections (§3.5 step 3: "not a generic 500").
 *
 * §3.5 defines the spend-cap shape verbatim; the other guardrails follow the same
 * pattern — a stable `error` code, the specific facts that explain the decision, and
 * the payment_request_id so a caller can look up the audit trail. Snake-case keys are
 * deliberate: these objects are the wire shape and are serialised as-is.
 */
export interface RejectionEnvelopeBase {
  readonly error: string;
  readonly payment_request_id: string | null;
}

export interface SpendCapRejectionEnvelope extends RejectionEnvelopeBase {
  readonly error: 'spend_cap_exceeded';
  readonly requested: number;
  readonly remaining: number;
}

export interface AgentRevokedRejectionEnvelope extends RejectionEnvelopeBase {
  readonly error: 'agent_revoked';
  readonly agent_identity_id: string;
}

export interface ProtocolDisabledRejectionEnvelope extends RejectionEnvelopeBase {
  readonly error: 'protocol_disabled';
  readonly protocol: string;
  readonly enabled_protocols: readonly string[];
}

export interface CategoryBlockedRejectionEnvelope extends RejectionEnvelopeBase {
  readonly error: 'category_blocked';
  readonly category: string;
  readonly blocked_categories: readonly string[];
}

export interface HumanApprovalRequiredEnvelope extends RejectionEnvelopeBase {
  readonly error: 'human_approval_required';
  readonly reason: string;
}

export interface ValidationRejectionEnvelope extends RejectionEnvelopeBase {
  readonly error: ValidationFailureReason;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type RejectionEnvelope =
  | SpendCapRejectionEnvelope
  | AgentRevokedRejectionEnvelope
  | ProtocolDisabledRejectionEnvelope
  | CategoryBlockedRejectionEnvelope
  | HumanApprovalRequiredEnvelope
  | ValidationRejectionEnvelope;
