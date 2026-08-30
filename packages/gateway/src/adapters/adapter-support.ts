/**
 * Shared helpers for the protocol adapters (Phase 3).
 *
 * Nothing protocol-specific lives here — only the pieces every adapter needs: safe
 * reads off untrusted JSON, the audit_log write §3.1 requires, and the single place
 * that turns an approved NormalizedPaymentRequest into a real Razorpay Order.
 */

import type { Prisma } from '../generated/prisma/index.js';
import { prisma } from '../db/prisma-client.js';
import { razorpayClient, type RazorpayClient } from '../razorpay/razorpay-client.js';
import type { NormalizedPaymentRequest, SettlementResult } from './protocol-adapter.interface.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readNumber(source: unknown, key: string): number | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * §3.1 step 4: a failed verification "is logged to audit_log with
 * action = 'mandate_rejected' and detail.reason = 'signature_invalid'".
 *
 * payment_request_id is null by design — the whole point is that no payment_requests
 * row exists yet, and none will be created for a request that failed verification.
 */
export async function auditMandateRejected(
  agentIdentityId: string | null,
  reason: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorType: 'agent',
      actorId: agentIdentityId,
      action: 'mandate_rejected',
      paymentRequestId: null,
      detail: { reason, ...detail } as Prisma.InputJsonObject,
    },
  });
}

/**
 * Settlement injection point.
 *
 * The adapters call through this rather than importing the singleton directly, so tests
 * can substitute a stand-in Razorpay client without a live network call. Production
 * code never touches the setter.
 */
let activeRazorpayClient: RazorpayClient = razorpayClient;

export function setRazorpayClientForTesting(client: RazorpayClient): () => void {
  const previous = activeRazorpayClient;
  activeRazorpayClient = client;
  return () => {
    activeRazorpayClient = previous;
  };
}

export function getRazorpayClient(): RazorpayClient {
  return activeRazorpayClient;
}

/**
 * Creates the real Razorpay Order for an approved request and records it in
 * razorpay_orders, then moves the payment_request to 'awaiting_settlement'.
 *
 * The status stops at 'awaiting_settlement' on purpose. Per §1.3 only a
 * signature-verified webhook may write 'settled' — an adapter that marked its own work
 * paid would be exactly the protocol-layer optimism the trust boundary exists to
 * contain.
 */
export async function createRazorpayOrderFor(
  normalized: NormalizedPaymentRequest,
  paymentRequestId?: string,
): Promise<SettlementResult> {
  const requestId = paymentRequestId ?? normalized.metadata['paymentRequestId'];

  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error('createRazorpayOrderFor requires a persisted payment_requests id');
  }

  const order = await getRazorpayClient().createOrder({
    // Razorpay caps receipt at 40 characters.
    receipt: requestId.slice(0, 40),
    amountPaise: normalized.amountPaise,
    notes: {
      paymentRequestId: requestId,
      agentIdentityId: normalized.agentIdentityId,
      sourceProtocol: normalized.sourceProtocol,
    },
  });

  const razorpayOrderId = String(order.id);

  await prisma.$transaction(async (tx) => {
    await tx.razorpayOrder.create({
      data: { paymentRequestId: requestId, razorpayOrderId, status: 'created' },
    });
    await tx.paymentRequest.update({
      where: { id: requestId },
      data: { status: 'awaiting_settlement', updatedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorType: 'system',
        actorId: 'protocol_adapter',
        action: 'razorpay_order_created',
        paymentRequestId: requestId,
        detail: {
          razorpayOrderId,
          amountPaise: normalized.amountPaise,
          sourceProtocol: normalized.sourceProtocol,
        } as Prisma.InputJsonObject,
      },
    });
  });

  return {
    paymentRequestId: requestId,
    status: 'awaiting_settlement',
    razorpayOrderId,
    razorpayPaymentId: null,
    paymentLinkUrl: null,
    amountPaise: normalized.amountPaise,
    currency: 'INR',
    sourceProtocol: normalized.sourceProtocol,
  };
}
