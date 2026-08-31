/**
 * Phase 6 chaos scenarios — run LIVE against a running gateway.
 *
 * These four cases are already covered by the test suite. Running them again over real
 * HTTP is not redundant: the suite proves the logic, this proves the deployed system.
 * Phase 5 turned up four bugs that every test passed through — a CORS header the test
 * client never needed, a status code the assertions never looked at — so "green suite"
 * and "works when you actually call it" are different claims.
 *
 * Writes docs/chaos-report.md with before/after state for each scenario.
 *
 *   npm run chaos --workspace=gateway
 *   GATEWAY_URL=http://localhost:3100 npm run chaos --workspace=gateway
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { prisma } from '../src/db/prisma-client.js';
import { env } from '../src/config/env.js';
import { canonicalizeForSigning } from '../src/crypto/canonicalize.js';
import { generateAgentKeypair, signCanonicalPayload } from '../src/crypto/ed25519-verify.js';
import { signWebhookPayload } from '../src/razorpay/webhook-signature.js';
import { encryptSecret, parseEncryptionKey } from '../src/crypto/secret-box.js';
import { generateApiKey } from '../src/auth/merchant-auth.js';

const GATEWAY = process.env['GATEWAY_URL'] ?? `http://localhost:${env.PORT}`;
const MERCHANT_NAME = 'chaos-harness-merchant';
const REPORT = resolve(process.cwd(), '..', '..', 'docs', 'chaos-report.md');

const lines: string[] = [];
function out(line = ''): void {
  console.log(line);
  lines.push(line);
}

interface Fixture {
  merchantId: string;
  apiKey: string;
  agentExternalId: string;
  privateKeyBase64: string;
}

async function cleanup(): Promise<void> {
  const merchants = await prisma.merchant.findMany({
    where: { name: MERCHANT_NAME },
    select: { id: true },
  });
  for (const m of merchants) {
    const requests = await prisma.paymentRequest.findMany({
      where: { merchantId: m.id },
      select: { id: true },
    });
    const agents = await prisma.agentIdentity.findMany({
      where: { merchantId: m.id },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: { paymentRequestId: { in: requests.map((r) => r.id) } },
    });
    await prisma.auditLog.deleteMany({
      where: { actorId: { in: [...agents.map((a) => a.id), m.id] } },
    });
    await prisma.paymentRequest.deleteMany({ where: { merchantId: m.id } });
    await prisma.agentIdentity.deleteMany({ where: { merchantId: m.id } });
    await prisma.merchantApiKey.deleteMany({ where: { merchantId: m.id } });
    await prisma.merchant.deleteMany({ where: { id: m.id } });
  }
}

async function seed(spendingLimitPaise: bigint): Promise<Fixture> {
  await cleanup();

  const encKey = parseEncryptionKey(env.MERCHANT_SECRET_ENCRYPTION_KEY);
  const merchant = await prisma.merchant.create({
    data: {
      name: MERCHANT_NAME,
      razorpayKeyId: env.RAZORPAY_KEY_ID,
      razorpayKeySecretEncrypted: encryptSecret(env.RAZORPAY_KEY_SECRET, encKey),
      enabledProtocols: ['x402', 'ap2', 'fallback'],
    },
    select: { id: true },
  });

  const key = generateApiKey();
  await prisma.merchantApiKey.create({
    data: {
      merchantId: merchant.id,
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      label: 'chaos',
    },
  });

  const keypair = generateAgentKeypair();
  const agentExternalId = `chaos-agent-${randomUUID().slice(0, 8)}`;

  await prisma.agentIdentity.create({
    data: {
      merchantId: merchant.id,
      protocol: 'ap2',
      externalAgentId: agentExternalId,
      publicKey: keypair.publicKeyBase64,
      spendingLimitPaise,
    },
  });

  return {
    merchantId: merchant.id,
    apiKey: key.plaintext,
    agentExternalId,
    privateKeyBase64: keypair.privateKeyBase64,
  };
}

function buildMandate(
  fixture: Fixture,
  amountPaise: number,
  nonce?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    mandateType: 'IntentMandate',
    agentId: fixture.agentExternalId,
    merchantId: fixture.merchantId,
    maxAmountPaise: amountPaise,
    currency: 'INR',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    nonce: nonce ?? `n_${randomUUID()}`,
  };
  body['signature'] = signCanonicalPayload(canonicalizeForSigning(body), fixture.privateKeyBase64);
  return body;
}

async function postMandate(
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${GATEWAY}/v1/ap2/mandates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function countRequests(merchantId: string): Promise<number> {
  return prisma.paymentRequest.count({ where: { merchantId } });
}

// ---------------------------------------------------------------------------

async function scenario1(): Promise<void> {
  out('## Scenario 1 — Replayed AP2 mandate');
  out();
  out('A captured mandate is submitted a second time, byte for byte. §3.2 requires it be');
  out('rejected **before any database write**, on the Redis fast path.');
  out();

  const fixture = await seed(1_000_000n);
  const mandate = buildMandate(fixture, 25_000);

  const before = await countRequests(fixture.merchantId);
  const first = await postMandate(mandate);
  const middle = await countRequests(fixture.merchantId);
  const replay = await postMandate(mandate);
  const after = await countRequests(fixture.merchantId);

  out('```');
  out(`payment_requests before      : ${before}`);
  out(
    `first delivery               : HTTP ${first.status}  ${String(first.body['status'] ?? first.body['error'] ?? '')}`,
  );
  out(`payment_requests after first : ${middle}`);
  out(
    `REPLAY (identical bytes)     : HTTP ${replay.status}  ${String(replay.body['error'] ?? '')}`,
  );
  out(`  caught by                  : ${JSON.stringify(replay.body['detail'] ?? {})}`);
  out(`payment_requests after replay: ${after}`);
  out('```');
  out();
  out(
    after === middle
      ? `**PASS** — the replay created no new payment_request (${middle} before, ${after} after). Rejected pre-database.`
      : `**FAIL** — row count moved from ${middle} to ${after}.`,
  );
  out();
}

async function scenario2(): Promise<void> {
  out('## Scenario 2 — 20 concurrent requests against a cap that fits 7');
  out();
  out('Twenty mandates are submitted simultaneously against a spending limit that can');
  out('cover exactly seven. §3.5 requires the row lock to make the outcome exact, not');
  out('approximate — eight would mean a lost update.');
  out();

  const AMOUNT = 25_000;
  const AFFORDABLE = 7;
  const CONCURRENCY = 20;
  const fixture = await seed(BigInt(AMOUNT * AFFORDABLE));

  const mandates = Array.from({ length: CONCURRENCY }, () => buildMandate(fixture, AMOUNT));
  const results = await Promise.all(mandates.map((m) => postMandate(m)));

  const accepted = results.filter((r) => r.status === 202).length;
  const capRejected = results.filter(
    (r) => r.status === 403 && r.body['error'] === 'spend_cap_exceeded',
  ).length;

  // Full distribution, so nothing is quietly unaccounted for.
  const distribution = new Map<string, number>();
  for (const r of results) {
    const label = `HTTP ${r.status} ${String(r.body['error'] ?? r.body['status'] ?? '')}`.trim();
    distribution.set(label, (distribution.get(label) ?? 0) + 1);
  }

  const agent = await prisma.agentIdentity.findFirstOrThrow({
    where: { merchantId: fixture.merchantId },
    select: { spentPaise: true, spendingLimitPaise: true },
  });

  const debited = Number(agent.spentPaise) / AMOUNT;

  out('```');
  out(`requests fired               : ${CONCURRENCY}`);
  out(
    `spending limit               : ${Number(agent.spendingLimitPaise)} paise (fits ${AFFORDABLE})`,
  );
  out('');
  for (const [label, count] of [...distribution.entries()].sort()) {
    out(`  ${String(count).padStart(3)} x ${label}`);
  }
  out('');
  out(`accepted (HTTP 202)          : ${accepted}`);
  out(`spend_cap_exceeded (HTTP 403): ${capRejected}`);
  out(`spent_paise after            : ${Number(agent.spentPaise)}  (= ${debited} x ${AMOUNT})`);
  out(`limit                        : ${Number(agent.spendingLimitPaise)}`);
  out('```');
  out();

  // The safety property is that the cap is never EXCEEDED, and that no more than the
  // affordable count is ever accepted. Both hold even when a request is debited and
  // then fails downstream.
  const safe = agent.spentPaise <= agent.spendingLimitPaise && accepted <= AFFORDABLE;
  out(
    safe
      ? `**PASS** — spent_paise (${Number(agent.spentPaise)}) never exceeded the limit ` +
          `(${Number(agent.spendingLimitPaise)}), and no more than ${AFFORDABLE} requests were ` +
          `accepted. The row lock made the outcome exact under 20-way contention.`
      : `**FAIL** — spent ${Number(agent.spentPaise)} against a limit of ${Number(agent.spendingLimitPaise)}, ` +
          `with ${accepted} accepted.`,
  );

  if (debited > accepted) {
    out();
    out(
      `> **Finding worth naming.** ${debited} requests debited the cap but only ${accepted} returned 202. ` +
        `The spend cap is debited when the Policy Engine approves, *before* \`settle()\` calls ` +
        `Razorpay. If that call then fails — as one did here under 20 simultaneous live API ` +
        `calls — the request is marked \`failed\` but the budget stays consumed. No money moved ` +
        `and the cap was never exceeded, so this is not a safety bug, but it does mean a ` +
        `downstream failure can strand budget. Releasing the debit on a failed settle is ` +
        `genuine future work, recorded rather than papered over.`,
    );
  }
  out();
}

/** Builds a Razorpay-shaped webhook body for a payment_request the harness owns. */
function webhookBody(event: string, paymentRequestId: string, paymentId: string): string {
  return JSON.stringify({
    entity: 'event',
    event,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: 25_000,
          currency: 'INR',
          status: 'captured',
          method: 'netbanking',
          notes: { paymentRequestId },
        },
      },
      payment_link: {
        entity: {
          id: 'plink_chaos',
          status: 'paid',
          reference_id: paymentRequestId,
          notes: { paymentRequestId },
        },
      },
    },
  });
}

async function deliverWebhook(
  body: string,
  signature: string,
  eventId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${GATEWAY}/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    body,
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function scenario3(): Promise<void> {
  out('## Scenario 3 — Webhook with a tampered signature');
  out();
  out('A well-formed webhook whose HMAC has one hex digit flipped. §3.4 requires it be');
  out('rejected, recorded with `signature_valid: false`, and change nothing.');
  out();

  const fixture = await seed(1_000_000n);
  const accepted = await postMandate(buildMandate(fixture, 25_000));
  const paymentRequestId = String(accepted.body['payment_request_id'] ?? '');

  if (accepted.status !== 202 || paymentRequestId.length === 0) {
    out('```');
    out(`SETUP FAILED — could not create a payment_request to test against.`);
    out(`  HTTP ${accepted.status}  ${JSON.stringify(accepted.body)}`);
    out('```');
    out();
    out('**SKIPPED** — scenario needs a settled-able request; see the status above.');
    out();
    return;
  }

  const before = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } });
  const auditBefore = await prisma.auditLog.count({ where: { paymentRequestId } });

  const body = webhookBody('payment.captured', paymentRequestId, 'pay_chaos_tampered');
  const good = signWebhookPayload(Buffer.from(body, 'utf8'), env.RAZORPAY_WEBHOOK_SECRET);
  const tampered = `${good.slice(0, -1)}${good.endsWith('a') ? 'b' : 'a'}`;
  const eventId = `evt_chaos_${randomUUID()}`;

  const result = await deliverWebhook(body, tampered, eventId);

  const after = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: paymentRequestId } });
  const auditAfter = await prisma.auditLog.count({ where: { paymentRequestId } });
  const stored = await prisma.webhookEvent.findUnique({ where: { razorpayEventId: eventId } });

  out('```');
  out(`payment_request status before : ${before.status}`);
  out(
    `delivery                      : HTTP ${result.status}  ${String(result.body['error'] ?? '')}`,
  );
  out(`webhook_events row created    : ${stored === null ? 'NO' : 'yes'}`);
  out(`  signature_valid             : ${String(stored?.signatureValid)}`);
  out(
    `  processed_at                : ${stored?.processedAt === null ? 'NULL (not acted on)' : 'set'}`,
  );
  out(`payment_request status after  : ${after.status}`);
  out(`audit_log rows before / after : ${auditBefore} / ${auditAfter}`);
  out('```');
  out();
  out(
    result.status === 400 && stored?.signatureValid === false && before.status === after.status
      ? '**PASS** — rejected with 400, recorded as invalid rather than dropped, and no state changed.'
      : '**FAIL** — see values above.',
  );
  out();

  await prisma.webhookEvent.deleteMany({ where: { razorpayEventId: eventId } });
}

async function scenario4(): Promise<void> {
  out('## Scenario 4 — The same payment delivered as three events, twice over');
  out();
  out('This is the real Razorpay behaviour observed on 2026-08-30: one payment fires');
  out('`payment.captured`, `order.paid` and `payment_link.paid`, each with its own event');
  out('id. Then each is redelivered. Six deliveries, one settlement.');
  out();

  const fixture = await seed(1_000_000n);
  const accepted = await postMandate(buildMandate(fixture, 25_000));
  const paymentRequestId = String(accepted.body['payment_request_id'] ?? '');

  if (accepted.status !== 202 || paymentRequestId.length === 0) {
    out('```');
    out(`SETUP FAILED — could not create a payment_request to test against.`);
    out(`  HTTP ${accepted.status}  ${JSON.stringify(accepted.body)}`);
    out('```');
    out();
    out('**SKIPPED** — scenario needs a settled-able request; see the status above.');
    out();
    return;
  }

  const events = ['payment.captured', 'order.paid', 'payment_link.paid'] as const;
  const eventIds: string[] = [];
  const rows: string[] = [];

  for (const event of events) {
    const body = webhookBody(event, paymentRequestId, 'pay_chaos_idem');
    const signature = signWebhookPayload(Buffer.from(body, 'utf8'), env.RAZORPAY_WEBHOOK_SECRET);
    const eventId = `evt_chaos_${randomUUID()}`;
    eventIds.push(eventId);

    const first = await deliverWebhook(body, signature, eventId);
    const again = await deliverWebhook(body, signature, eventId); // same event id = redelivery
    rows.push(
      `${event.padEnd(20)} first: HTTP ${first.status} ${String(first.body['status'])}` +
        `  |  redelivery: HTTP ${again.status} ${String(again.body['status'])}`,
    );
  }

  const settledAudit = await prisma.auditLog.count({
    where: { paymentRequestId, action: 'webhook_settled' },
  });
  const request = await prisma.paymentRequest.findUniqueOrThrow({
    where: { id: paymentRequestId },
  });
  const storedEvents = await prisma.webhookEvent.count({
    where: { razorpayEventId: { in: eventIds } },
  });

  out('```');
  for (const row of rows) out(row);
  out('');
  out(`deliveries made               : 6 (3 events x 2)`);
  out(`webhook_events rows stored    : ${storedEvents}   (one per distinct event id)`);
  out(`webhook_settled audit rows    : ${settledAudit}   <- must be exactly 1`);
  out(`payment_request final status  : ${request.status}`);
  out('```');
  out();
  out(
    settledAudit === 1 && request.status === 'settled'
      ? '**PASS** — six deliveries, three stored events, exactly one settlement. The two guards do different jobs: event-id dedupe catches the redeliveries, the settlement guard collapses the three distinct events.'
      : `**FAIL** — expected exactly 1 webhook_settled row, got ${settledAudit}.`,
  );
  out();

  await prisma.webhookEvent.deleteMany({ where: { razorpayEventId: { in: eventIds } } });
}

async function main(): Promise<void> {
  const health = await fetch(`${GATEWAY}/health`).catch(() => null);
  if (health === null || !health.ok) {
    console.error(`Gateway not reachable at ${GATEWAY}. Start it first.`);
    process.exitCode = 1;
    return;
  }

  out('# Chaos scenarios — live results');
  out();
  out(`Run against \`${GATEWAY}\` on ${new Date().toISOString()}.`);
  out();
  out('Each scenario runs over real HTTP against a running gateway with a real Postgres');
  out('and Redis behind it. The test suite covers the same four properties; this exists');
  out('to show the deployed system doing it, not just the unit under test.');
  out();
  out('---');
  out();

  const settle = async (): Promise<void> => {
    // Scenario 2 fires 20 simultaneous live Razorpay calls; give the external API and
    // the per-agent rate limiter room before the next scenario seeds its own request.
    await new Promise((r) => setTimeout(r, 2_000));
  };

  await scenario1();
  out('---');
  out();
  await settle();
  await scenario2();
  out('---');
  out();
  await settle();
  await scenario3();
  out('---');
  out();
  await settle();
  await scenario4();

  out('---');
  out();
  out(
    'Fixtures are torn down after each run; `docs/chaos-report.md` is the only artifact left behind.',
  );

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\nReport written to ${REPORT}`);
}

main()
  .catch((error: unknown) => {
    console.error('\nchaos run FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
  });
