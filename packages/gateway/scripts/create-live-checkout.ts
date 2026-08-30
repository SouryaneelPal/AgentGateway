/**
 * Creates a genuinely payable Razorpay checkout, for verifying real webhook delivery.
 *
 * WHY THE FALLBACK ROUTE RATHER THAN A BARE ORDER:
 * a bare Razorpay Order has no hosted payment page — something still has to drive
 * checkout. A Payment Link is a hosted page, and the gateway already builds one through
 * fallbackAdapter. Going through POST /v1/fallback/payment-links means the resulting
 * payment_requests row is REAL and carries notes.paymentRequestId, so when the human
 * pays, the incoming payment_link.paid webhook actually resolves to it and settles it —
 * instead of arriving as an orphan with nothing to match.
 *
 * That turns one manual payment into proof of three things at once: live Payment Link
 * creation, genuine Razorpay-signed webhook delivery, and the Phase 3 fallback
 * human-confirmation settlement path end to end.
 *
 *   npm run checkout:live --workspace=gateway
 *
 * Rows are left in place on purpose — the webhook needs them. Clean up afterwards with
 *   npm run checkout:live --workspace=gateway -- --cleanup
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db/prisma-client.js';

/** The containerised gateway — the one ngrok points at. */
const GATEWAY_URL = process.env['GATEWAY_URL'] ?? 'http://localhost:3001';
const AMOUNT_PAISE = 100; // ₹1.00
const MERCHANT_NAME = 'live-webhook-verification';

async function cleanup(): Promise<void> {
  const merchants = await prisma.merchant.findMany({
    where: { name: MERCHANT_NAME },
    select: { id: true },
  });

  for (const merchant of merchants) {
    const requests = await prisma.paymentRequest.findMany({
      where: { merchantId: merchant.id },
      select: { id: true },
    });
    const agents = await prisma.agentIdentity.findMany({
      where: { merchantId: merchant.id },
      select: { id: true },
    });

    await prisma.auditLog.deleteMany({
      where: { paymentRequestId: { in: requests.map((r) => r.id) } },
    });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: agents.map((a) => a.id) } } });
    await prisma.paymentRequest.deleteMany({ where: { merchantId: merchant.id } });
    await prisma.agentIdentity.deleteMany({ where: { merchantId: merchant.id } });
    await prisma.merchant.deleteMany({ where: { id: merchant.id } });
  }

  console.log(`Cleaned up ${merchants.length} verification merchant(s) and all child rows.`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--cleanup')) {
    await cleanup();
    return;
  }

  // Start from a clean slate so the verification query cannot pick up a stale row.
  await cleanup();

  const merchant = await prisma.merchant.create({
    data: {
      name: MERCHANT_NAME,
      razorpayKeyId: process.env['RAZORPAY_KEY_ID'] ?? '',
      razorpayKeySecretEncrypted: '(not stored for this probe)',
      enabledProtocols: ['fallback'],
    },
    select: { id: true },
  });

  const agentId = `human-buyer-${randomUUID().slice(0, 8)}`;

  const response = await fetch(`${GATEWAY_URL}/v1/fallback/payment-links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, merchantId: merchant.id, amountPaise: AMOUNT_PAISE }),
  });

  const body = (await response.json()) as Record<string, unknown>;

  if (response.status !== 202) {
    console.error(`\nGateway refused the request: HTTP ${response.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = 1;
    return;
  }

  const paymentRequestId = String(body['payment_request_id']);
  const paymentLinkUrl = String(body['payment_link_url']);

  const row = await prisma.paymentRequest.findUniqueOrThrow({
    where: { id: paymentRequestId },
    select: { status: true, normalizedAmountPaise: true },
  });

  console.log('\n============================================================');
  console.log('  OPEN THIS URL IN YOUR BROWSER AND COMPLETE THE PAYMENT');
  console.log('============================================================');
  console.log(`\n  ${paymentLinkUrl}\n`);
  console.log('============================================================');
  console.log(`  Amount              ₹${(AMOUNT_PAISE / 100).toFixed(2)} (${AMOUNT_PAISE} paise)`);
  console.log(`  merchant_id         ${merchant.id}`);
  console.log(`  agent_id            ${agentId}`);
  console.log(`  payment_request_id  ${paymentRequestId}`);
  console.log(`  current status      ${row.status}   <- must become 'settled' via webhook`);
  console.log('============================================================\n');
}

main()
  .catch((error: unknown) => {
    console.error('\nfailed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
