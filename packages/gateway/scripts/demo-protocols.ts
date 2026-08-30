/**
 * Phase 3 live demonstration harness.
 *
 * Drives a RUNNING gateway over real HTTP — no app.inject, no mocks except the Razorpay
 * SDK, which cannot be reached without live test-mode credentials. Seeds a merchant and
 * two agents, then walks the three validation scenarios the Phase 3 checklist names:
 *
 *   1. AP2 happy path      -> 202, awaiting_settlement
 *   2. AP2 tampered sig    -> 403, and NO payment_requests row created
 *   3. AP2 replayed nonce  -> 409 on the Redis fast path
 *   4. x402 full flow      -> 402 -> proof -> awaiting_settlement -> webhook -> settled
 *   5. spend-cap breach    -> 403 with a persisted 'rejected' row
 *
 *   npm run demo:protocols --workspace=gateway
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db/prisma-client.js';
import { env } from '../src/config/env.js';
import { canonicalizeForSigning } from '../src/crypto/canonicalize.js';
import { generateAgentKeypair, signCanonicalPayload } from '../src/crypto/ed25519-verify.js';
import { signWebhookPayload } from '../src/razorpay/webhook-signature.js';

const GATEWAY = process.env['GATEWAY_URL'] ?? `http://localhost:${env.PORT}`;

/** Recorded as soon as they are created, so the finally block can always clean up. */
let seededMerchantId: string | null = null;
const seededAgentIds: string[] = [];

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${GATEWAY}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const ap2Keys = generateAgentKeypair();

  const merchant = await prisma.merchant.create({
    data: {
      name: `demo-${suffix}`,
      razorpayKeyId: env.RAZORPAY_KEY_ID,
      razorpayKeySecretEncrypted: '(demo)',
      enabledProtocols: ['x402', 'ap2', 'fallback'],
    },
    select: { id: true },
  });
  seededMerchantId = merchant.id;

  const ap2AgentExternalId = `ap2-demo-${suffix}`;
  const ap2Agent = await prisma.agentIdentity.create({
    data: {
      merchantId: merchant.id,
      protocol: 'ap2',
      externalAgentId: ap2AgentExternalId,
      publicKey: ap2Keys.publicKeyBase64,
      spendingLimitPaise: 500_000n,
    },
    select: { id: true },
  });
  seededAgentIds.push(ap2Agent.id);

  const x402AgentExternalId = `x402-demo-${suffix}`;
  const x402Agent = await prisma.agentIdentity.create({
    data: {
      merchantId: merchant.id,
      protocol: 'x402',
      externalAgentId: x402AgentExternalId,
      spendingLimitPaise: 500_000n,
    },
    select: { id: true },
  });
  seededAgentIds.push(x402Agent.id);

  const buildMandate = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      mandateType: 'IntentMandate',
      agentId: ap2AgentExternalId,
      merchantId: merchant.id,
      maxAmountPaise: 50_000,
      currency: 'INR',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      nonce: `n_${randomUUID()}`,
      ...overrides,
    };
    body['signature'] = signCanonicalPayload(
      canonicalizeForSigning(body),
      ap2Keys.privateKeyBase64,
    );
    return body;
  };

  console.log('\n=== 1. AP2 happy path (valid Ed25519 signature) ===');
  const happy = await post('/v1/ap2/mandates', buildMandate());
  line('HTTP', String(happy.status));
  line('status', String(happy.body['status']));
  line('payment_request_id', String(happy.body['payment_request_id']));

  console.log('\n=== 2. AP2 TAMPERED signature (§3.1 hard reject) ===');
  const beforeCount = await prisma.paymentRequest.count({
    where: { agentIdentityId: ap2Agent.id },
  });
  const tampered = buildMandate();
  tampered['maxAmountPaise'] = 1; // signed 50000, sending 1
  const tamperResult = await post('/v1/ap2/mandates', tampered);
  const afterCount = await prisma.paymentRequest.count({
    where: { agentIdentityId: ap2Agent.id },
  });
  line('HTTP', String(tamperResult.status));
  line('error', String(tamperResult.body['error']));
  line('payment_requests before', String(beforeCount));
  line('payment_requests after', String(afterCount));
  line('rows created by tamper', String(afterCount - beforeCount));
  line(
    'audit mandate_rejected',
    String(
      await prisma.auditLog.count({
        where: { actorId: ap2Agent.id, action: 'mandate_rejected' },
      }),
    ),
  );

  console.log('\n=== 3. AP2 replayed nonce (§3.2 Redis fast path) ===');
  const replayable = buildMandate();
  const firstSend = await post('/v1/ap2/mandates', replayable);
  const replaySend = await post('/v1/ap2/mandates', replayable);
  line('first delivery HTTP', String(firstSend.status));
  line('replay HTTP', String(replaySend.status));
  line('replay error', String(replaySend.body['error']));
  line('caught by', JSON.stringify(replaySend.body['detail']));

  console.log('\n=== 4. x402 full flow: 402 -> proof -> webhook -> settled ===');
  const challengeResponse = await fetch(
    `${GATEWAY}/v1/x402/checkout/cart_demo_001?agentId=${x402AgentExternalId}&merchantId=${merchant.id}&amountPaise=50000`,
  );
  const envelopeHeader = challengeResponse.headers.get('payment-required') ?? '{}';
  const envelope = JSON.parse(envelopeHeader) as { reference: string; amount: number };
  line('challenge HTTP', String(challengeResponse.status));
  line('PAYMENT-REQUIRED', envelopeHeader);

  const redeem = await post(
    '/v1/x402/checkout/cart_demo_001',
    {},
    {
      'payment-signature': JSON.stringify({
        reference: envelope.reference,
        amount: envelope.amount,
        razorpayPaymentId: 'pay_demoproof',
      }),
    },
  );
  const x402RequestId = String(redeem.body['payment_request_id']);
  line('redeem HTTP', String(redeem.status));
  line('payment_request_id', x402RequestId);

  if (redeem.status === 401 || x402RequestId === 'undefined') {
    line('!! BLOCKED', 'Razorpay returned 401 — RAZORPAY_KEY_ID is a placeholder.');
    line('', 'Everything up to the settlement call succeeded; the live');
    line('', 'Razorpay Order could not be created. Fill in real test-mode');
    line('', 'keys in .env to complete this leg against live settlement.');
  }

  const afterRedeem =
    x402RequestId === 'undefined'
      ? null
      : await prisma.paymentRequest.findUnique({ where: { id: x402RequestId } });
  line('status after settle()', String(afterRedeem?.status ?? 'n/a — no row (settle failed)'));

  const order =
    afterRedeem === null
      ? null
      : await prisma.razorpayOrder.findFirst({ where: { paymentRequestId: x402RequestId } });

  if (order === null) {
    line('razorpay order', 'NONE — Razorpay call failed (placeholder credentials)');
  } else {
    const webhookBody = JSON.stringify({
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_demoflow',
            amount: 50_000,
            currency: 'INR',
            status: 'captured',
            order_id: order.razorpayOrderId,
          },
        },
      },
    });
    const eventId = `evt_${randomUUID()}`;
    const webhook = await fetch(`${GATEWAY}/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signWebhookPayload(
          Buffer.from(webhookBody, 'utf8'),
          env.RAZORPAY_WEBHOOK_SECRET,
        ),
        'x-razorpay-event-id': eventId,
      },
      body: webhookBody,
    });
    line('webhook HTTP', String(webhook.status));
    const settled = await prisma.paymentRequest.findUniqueOrThrow({
      where: { id: x402RequestId },
    });
    line('status after webhook', settled.status);
    await prisma.webhookEvent.deleteMany({ where: { razorpayEventId: eventId } });
  }

  console.log('\n=== 5. Spend-cap breach persists a rejected row (§3.5) ===');
  const breach = await post('/v1/ap2/mandates', buildMandate({ maxAmountPaise: 5_000_000 }));
  line('HTTP', String(breach.status));
  line('envelope', JSON.stringify(breach.body));
  const breachId = String(breach.body['payment_request_id']);
  const breachRow =
    breachId === 'undefined'
      ? null
      : await prisma.paymentRequest.findUnique({ where: { id: breachId } });
  line('persisted status', String(breachRow?.status));
  line('rejection_reason', String(breachRow?.rejectionReason));

  console.log('\nDone.');
}

/**
 * Cleanup runs from a finally block, not the happy path. An earlier version cleaned up
 * inline and left orphan rows behind the first time the script threw partway through —
 * a demo harness that litters the database on failure is worse than no harness.
 */
async function cleanupDemo(merchantId: string, agentIds: string[]): Promise<void> {
  const requests = await prisma.paymentRequest.findMany({
    where: { merchantId },
    select: { id: true },
  });
  await prisma.auditLog.deleteMany({
    where: { paymentRequestId: { in: requests.map((r) => r.id) } },
  });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: agentIds } } });
  await prisma.paymentRequest.deleteMany({ where: { merchantId } });
  await prisma.agentIdentity.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
}

main()
  .catch((error: unknown) => {
    console.error('\ndemo FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (seededMerchantId !== null) {
      console.log('Cleaning up demo rows…');
      await cleanupDemo(seededMerchantId, seededAgentIds).catch((error: unknown) => {
        console.error('cleanup failed:', error instanceof Error ? error.message : error);
      });
    }
    await prisma.$disconnect();
  });
