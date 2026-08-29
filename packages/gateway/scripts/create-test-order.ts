/**
 * Phase 1 deliverable: "a manual script that creates one test Order and confirms the
 * SDK round-trips correctly."
 *
 * Deliberately manual — it spends nothing, but it does hit Razorpay's live test-mode
 * API, so it is not wired into `npm test`. Run it once after filling in .env:
 *
 *   npm run razorpay:smoke --workspace=gateway
 *
 * Then confirm the order appears under Test Mode → Transactions → Orders in the
 * Razorpay dashboard. That is the third item on the Phase 1 validation checklist.
 */

import { randomUUID } from 'node:crypto';
import { RazorpayClient } from '../src/razorpay/razorpay-client.js';
import { env } from '../src/config/env.js';

async function main(): Promise<void> {
  if (!env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
    console.error(
      `Refusing to run: RAZORPAY_KEY_ID is "${env.RAZORPAY_KEY_ID.slice(0, 12)}…", which is not a test-mode key.\n` +
        'This script is a test-mode smoke check only.',
    );
    process.exit(1);
  }

  const client = new RazorpayClient();
  const receipt = `smoke_${randomUUID().slice(0, 24)}`;

  console.log(`Creating a test Order for ₹1.00 (100 paise), receipt=${receipt} …`);

  const order = await client.createOrder({
    amountPaise: 100,
    receipt,
    notes: { source: 'agentgateway-phase-1-smoke' },
  });

  console.log('\nRazorpay round-trip OK:');
  console.log(JSON.stringify(order, null, 2));
  console.log(
    '\nConfirm it in the dashboard: Test Mode → Transactions → Orders → ' + String(order.id),
  );
}

main().catch((error: unknown) => {
  console.error('\nRazorpay smoke test FAILED:');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
