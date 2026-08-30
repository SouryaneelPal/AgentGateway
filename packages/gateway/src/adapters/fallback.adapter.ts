/**
 * fallbackAdapter (§2.2) — IMPLEMENTED (Phase 3).
 *
 * For any agent that speaks neither x402 nor AP2. Generates a standard Razorpay Payment
 * Link and waits for a human tap — one-time consent rather than per-transaction blind
 * trust. This adapter is what keeps the gateway from hard-failing on an unrecognised
 * client: graceful degradation is part of the design, not an afterthought.
 *
 * It declares settlesViaHumanApproval = true, because for this adapter a
 * `requires_human_approval` policy outcome is not a rejection — it is the entire point
 * of the route.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma-client.js';
import { getRazorpayClient, isRecord, readNumber, readString } from './adapter-support.js';
import type {
  IncomingRequest,
  NormalizedPaymentRequest,
  ProtocolReceipt,
  RoutableProtocolAdapter,
  SettlementResult,
  ValidationFailureReason,
  ValidationResult,
} from './protocol-adapter.interface.js';

export class FallbackAdapter implements RoutableProtocolAdapter {
  readonly protocolName = 'fallback' as const;

  /** The Payment Link IS the human-approval step. */
  readonly settlesViaHumanApproval = true;

  /**
   * The fallback matches anything. The router consults it last, so this is the
   * catch-all that guarantees an unrecognised client degrades instead of failing.
   */
  matches(_request: IncomingRequest): boolean {
    return true;
  }

  /**
   * Structural validation only — there is no protocol signature to check here. The
   * trust comes from the human tapping the Payment Link, not from the request.
   */
  async validate(rawRequest: IncomingRequest): Promise<ValidationResult> {
    const body = rawRequest.body;

    if (!isRecord(body)) {
      return this.reject('malformed_request', { reason: 'body must be a JSON object' });
    }

    const amountPaise = readNumber(body, 'amountPaise');
    const agentId = readString(body, 'agentId');
    const merchantId = readString(body, 'merchantId');

    if (amountPaise === null || !Number.isInteger(amountPaise) || amountPaise <= 0) {
      return this.reject('malformed_request', { reason: 'amountPaise must be a positive integer' });
    }

    if (agentId === null || merchantId === null) {
      return this.reject('malformed_request', { reason: 'agentId and merchantId are required' });
    }

    // An unrecognised agent is registered on the fly at 'untrusted', because refusing
    // outright would defeat the point of a graceful-degradation path. It still passes
    // through every guardrail, and an untrusted agent's spending_limit_paise defaults
    // to 0 (§2.3), so nothing can actually be spent until a merchant raises it.
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true },
    });

    if (merchant === null) {
      return this.reject('malformed_request', { reason: 'unknown merchantId', merchantId });
    }

    const agent = await prisma.agentIdentity.upsert({
      where: {
        merchantId_protocol_externalAgentId: {
          merchantId,
          protocol: 'fallback',
          externalAgentId: agentId,
        },
      },
      create: { merchantId, protocol: 'fallback', externalAgentId: agentId },
      update: {},
      select: { id: true, merchantId: true },
    });

    return {
      ok: true,
      protocol: this.protocolName,
      request: rawRequest,
      claims: {
        merchantId: agent.merchantId,
        agentIdentityId: agent.id,
        amountPaise,
        // No protocol nonce exists here, so the gateway mints one; it still provides
        // one-time semantics through the same §3.2 guard as every other protocol.
        nonce: readString(body, 'nonce') ?? `fb_${randomUUID().replace(/-/g, '')}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        canonicalPayload: JSON.stringify(body),
        signature: 'none:human-approval',
        raw: { ...body },
      },
    };
  }

  /** Always requires human approval — that is this adapter's entire trust model. */
  async normalize(validated: ValidationResult): Promise<NormalizedPaymentRequest> {
    if (!validated.ok) {
      throw new Error('normalize() called with a failed ValidationResult');
    }

    const { claims } = validated;

    return {
      merchantId: claims.merchantId,
      agentIdentityId: claims.agentIdentityId,
      amountPaise: claims.amountPaise,
      currency: 'INR',
      idempotencyKey: '', // derived by the pipeline from §3.3's formula
      sourceProtocol: 'fallback',
      requiresHumanApproval: true,
      metadata: { ...claims.raw },
    };
  }

  /**
   * Creates a Razorpay Payment Link and hands it back for a human tap. Like every other
   * adapter this stops at awaiting-settlement: the human tapping the link produces a
   * webhook, and only that webhook settles anything (§1.3).
   */
  async settle(normalized: NormalizedPaymentRequest): Promise<SettlementResult> {
    const paymentRequestId = normalized.metadata['paymentRequestId'];

    if (typeof paymentRequestId !== 'string' || paymentRequestId.length === 0) {
      throw new Error('fallbackAdapter.settle requires a persisted payment_requests id');
    }

    const link = await getRazorpayClient().createPaymentLink({
      amountPaise: normalized.amountPaise,
      description: `AgentGateway request ${paymentRequestId}`,
      referenceId: paymentRequestId,
      notes: {
        paymentRequestId,
        agentIdentityId: normalized.agentIdentityId,
        sourceProtocol: 'fallback',
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.paymentRequest.update({
        where: { id: paymentRequestId },
        data: { status: 'awaiting_settlement', updatedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          actorId: 'fallback_adapter',
          action: 'payment_link_created',
          paymentRequestId,
          detail: {
            paymentLinkId: String(link.id),
            amountPaise: normalized.amountPaise,
          },
        },
      });
    });

    const shortUrl = isRecord(link) ? readString(link, 'short_url') : null;

    return {
      paymentRequestId,
      status: 'awaiting_settlement',
      razorpayOrderId: null,
      razorpayPaymentId: null,
      paymentLinkUrl: shortUrl,
      amountPaise: normalized.amountPaise,
      currency: 'INR',
      sourceProtocol: 'fallback',
    };
  }

  /** A plain receipt shape — there is no protocol envelope to satisfy here. */
  async formatReceipt(result: SettlementResult): Promise<ProtocolReceipt> {
    return {
      protocol: 'fallback',
      paymentRequestId: result.paymentRequestId,
      shape: {
        status: result.status,
        amountPaise: result.amountPaise,
        currency: result.currency,
        paymentLinkUrl: result.paymentLinkUrl,
        awaitingHumanApproval: true,
      },
      issuedAt: new Date(),
    };
  }

  private reject(
    reason: ValidationFailureReason,
    detail: Record<string, unknown>,
  ): ValidationResult {
    return { ok: false, protocol: this.protocolName, reason, detail };
  }
}

export const fallbackAdapter = new FallbackAdapter();
