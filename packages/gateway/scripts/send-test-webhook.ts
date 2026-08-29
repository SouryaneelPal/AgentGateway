/**
 * Manual webhook validation harness (Phase 2 validation checklist).
 *
 * Seeds a merchant/agent/payment_request/razorpay_order, then delivers a Razorpay-shaped
 * `payment.captured` webhook to a RUNNING gateway and prints the resulting database
 * state. Three modes:
 *
 *   npm run webhook:test --workspace=gateway              # valid signature  -> settles
 *   npm run webhook:test --workspace=gateway -- --tamper  # bad signature    -> 400 + logged
 *   npm run webhook:test --workspace=gateway -- --replay  # deliver twice    -> processed once
 *
 * ORDER PROVENANCE: if RAZORPAY_KEY_ID/SECRET are real test-mode credentials, the
 * razorpay_orders row is created from a genuine Razorpay Order via
 * RazorpayClient.createOrder() — so this flow exercises the wrapper for real, not just
 * the smoke script. With placeholder credentials it falls back to a synthetic order id
 * and says so.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db/prisma-client.js';
import { env } from '../src/config/env.js';
import { signWebhookPayload } from '../src/razorpay/webhook-signature.js';
import { RazorpayClient } from '../src/razorpay/razorpay-client.js';

const GATEWAY_URL = process.env.GATEWAY_URL ?? `http://localhost:${env.PORT}`;
const TAMPER = process.argv.includes('--tamper');
const REPLAY = process.argv.includes('--replay');
const AMOUNT_PAISE = 149_900;

async function createOrderId(receipt: string): Promise<{ id: string; real: boolean }> {
  const looksReal =
    env.RAZORPAY_KEY_ID.startsWith('rzp_test_') && !env.RAZORPAY_KEY_ID.includes('xxxx');

  if (!looksReal) {
    return { id: `order_${randomUUID().replace(/-/g, '').slice(0, 14)}`, real: false };
  }

  const order = await new RazorpayClient().createOrder({
    amountPaise: AMOUNT_PAISE,
    receipt,
    notes: { source: 'agentgateway-phase-2-webhook-validation' },
  });
  return { id: String(order.id), real: true };
}

async function main(): Promise<void> {
  const suffix = randomUUID().slice(0, 8);

  const merchant = await prisma.merchant.create({
    data: {
      name: `webhook-probe-${suffix}`,
      razorpayKeyId: env.RAZORPAY_KEY_ID,
      razorpayKeySecretEncrypted: '(not stored in this probe)',
      enabledProtocols: ['ap2'],
    },
    select: { id: true },
  });

  const agent = await prisma.agentIdentity.create({
    data: {
      merchantId: merchant.id,
      protocol: 'ap2',
      externalAgentId: `probe-${suffix}`,
      spendingLimitPaise: 1_000_000n,
    },
    select: { id: true },
  });

  const paymentRequest = await prisma.paymentRequest.create({
    data: {
      merchantId: merchant.id,
      agentIdentityId: agent.id,
      protocol: 'ap2',
      rawPayload: { probe: true },
      normalizedAmountPaise: BigInt(AMOUNT_PAISE),
      idempotencyKey: `probe-${randomUUID()}`,
      status: 'awaiting_settlement',
    },
    select: { id: true },
  });

  const { id: razorpayOrderId, real } = await createOrderId(`probe_${suffix}`);
  console.log(
    real
      ? `Razorpay Order created for real via RazorpayClient.createOrder(): ${razorpayOrderId}`
      : `Using a synthetic order id (${razorpayOrderId}) — RAZORPAY_KEY_ID is a placeholder, so no live Order was created.`,
  );

  await prisma.razorpayOrder.create({
    data: { paymentRequestId: paymentRequest.id, razorpayOrderId, status: 'created' },
  });

  const paymentId = `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const body = JSON.stringify({
    entity: 'event',
    account_id: 'acc_PROBE',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: 'payment',
          amount: AMOUNT_PAISE,
          currency: 'INR',
          status: 'captured',
          order_id: razorpayOrderId,
          method: 'upi',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

  const validSignature = signWebhookPayload(Buffer.from(body, 'utf8'), env.RAZORPAY_WEBHOOK_SECRET);
  const signature = TAMPER
    ? `${validSignature.slice(0, -1)}${validSignature.endsWith('a') ? 'b' : 'a'}`
    : validSignature;
  const eventId = `evt_${randomUUID()}`;

  console.log(`\nPOST ${GATEWAY_URL}/webhooks/razorpay`);
  console.log(`  event            payment.captured`);
  console.log(`  order_id         ${razorpayOrderId}`);
  console.log(`  payment_id       ${paymentId}`);
  console.log(`  event id         ${eventId}`);
  console.log(
    `  signature        ${TAMPER ? 'TAMPERED (last hex digit flipped)' : 'valid HMAC-SHA256'}`,
  );

  const deliveries = REPLAY ? 2 : 1;
  for (let attempt = 1; attempt <= deliveries; attempt += 1) {
    const response = await fetch(`${GATEWAY_URL}/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      },
      body,
    });
    const text = await response.text();
    console.log(`\n  delivery ${attempt}: HTTP ${response.status}  ${text}`);
  }

  const event = await prisma.webhookEvent.findUnique({ where: { razorpayEventId: eventId } });
  const order = await prisma.razorpayOrder.findUnique({ where: { razorpayOrderId } });
  const settled = await prisma.paymentRequest.findUnique({ where: { id: paymentRequest.id } });
  const audit = await prisma.auditLog.findMany({
    where: { paymentRequestId: paymentRequest.id },
    select: { actorType: true, action: true },
  });

  console.log('\nResulting database state');
  console.log('------------------------');
  console.log(
    `  webhook_events    rows=${event === null ? 0 : 1} signature_valid=${String(event?.signatureValid)} processed_at=${event?.processedAt === null || event?.processedAt === undefined ? 'NULL' : 'set'}`,
  );
  console.log(
    `  razorpay_orders   status=${String(order?.status)} payment_id=${String(order?.razorpayPaymentId)}`,
  );
  console.log(`  payment_requests  status=${String(settled?.status)}`);
  console.log(
    `  audit_log         ${audit.length} row(s) ${audit.map((a) => `${a.actorType}:${a.action}`).join(', ')}`,
  );

  console.log('\nCleaning up probe rows…');
  await prisma.auditLog.deleteMany({ where: { paymentRequestId: paymentRequest.id } });
  await prisma.webhookEvent.deleteMany({ where: { razorpayEventId: eventId } });
  await prisma.razorpayOrder.deleteMany({ where: { paymentRequestId: paymentRequest.id } });
  await prisma.paymentRequest.deleteMany({ where: { id: paymentRequest.id } });
  await prisma.agentIdentity.deleteMany({ where: { id: agent.id } });
  await prisma.merchant.deleteMany({ where: { id: merchant.id } });
  console.log('Done.');
}

main()
  .catch((error: unknown) => {
    console.error('\nwebhook validation FAILED:');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
