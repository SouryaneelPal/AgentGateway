/**
 * Gateway-only latency baseline (Phase 7).
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 *
 * This isolates the gateway's OWN throughput by replacing the Razorpay network call with
 * an in-process stub. It measures: HTTP handling, the control-character scan, protocol
 * detection, Ed25519 verification, JCS canonicalization, the Redis nonce reservation, the
 * two-table transaction, and the row-locked spend-cap check.
 *
 * It is NOT an end-to-end settlement latency, and no number produced here describes what
 * a real payment costs. The Phase 6 profile (docs/load-profile.md) is the one that
 * includes a live Razorpay round-trip, and that round-trip dominates it so completely
 * that the gateway's own cost was invisible underneath. That is the entire reason this
 * second measurement exists — not to produce a faster number, but to answer a different
 * question: how much of the observed latency is ours?
 *
 * Quoting this file's p50 as "settlement latency" would be exactly the dishonest number
 * this project has avoided elsewhere. The two reports are meant to be read together.
 *
 * WHAT IS STUBBED, PRECISELY
 *
 * The stub replaces the Razorpay SDK INSTANCE, not our RazorpayClient. Our own wrapper —
 * the code that builds the request bodies, pins INR, and shapes notes — still runs on
 * every request. Only the network boundary is removed. Stubbing our own wrapper would
 * have measured a system with less of itself in it.
 *
 *   npm run loadtest:gateway-only --workspace=gateway
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db/prisma-client.js';
import { disconnectRedis } from '../src/redis/redis-client.js';
import { env } from '../src/config/env.js';
import { canonicalizeForSigning } from '../src/crypto/canonicalize.js';
import { generateAgentKeypair, signCanonicalPayload } from '../src/crypto/ed25519-verify.js';
import { encryptSecret, parseEncryptionKey } from '../src/crypto/secret-box.js';
import { setRazorpayClientForTesting } from '../src/adapters/adapter-support.js';
import { RazorpayClient, type RazorpayClientOptions } from '../src/razorpay/razorpay-client.js';

const PORT = Number(process.env['LOADTEST_PORT'] ?? 3199);
const GATEWAY = `http://localhost:${PORT}`;
const MERCHANT_NAME = 'loadtest-gateway-only-merchant';
const REPORT = resolve(process.cwd(), '..', '..', 'docs', 'load-profile-gateway-only.md');

const LEVELS = [1, 2, 5, 10, 25];
const REQUESTS_PER_LEVEL = 200;

const lines: string[] = [];
function out(line = ''): void {
  console.log(line);
  lines.push(line);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/**
 * A stand-in for the Razorpay SDK instance.
 *
 * Returns immediately with a well-formed response. There is no artificial delay: the
 * point is to remove the network from the measurement entirely, so that what remains is
 * unambiguously the gateway's own work.
 */
function createStubSdk(): NonNullable<RazorpayClientOptions['client']> {
  let counter = 0;
  const stub = {
    orders: {
      create: async (body: { amount: number; receipt: string; notes?: unknown }) => {
        counter += 1;
        return {
          id: `order_stub${String(counter).padStart(10, '0')}`,
          entity: 'order',
          amount: body.amount,
          amount_paid: 0,
          amount_due: body.amount,
          currency: 'INR',
          receipt: body.receipt,
          status: 'created',
          attempts: 0,
          notes: body.notes ?? {},
          created_at: Math.floor(Date.now() / 1000),
        };
      },
    },
    paymentLinks: {
      create: async (body: { amount: number; reference_id?: string }) => {
        counter += 1;
        return {
          id: `plink_stub${String(counter).padStart(10, '0')}`,
          amount: body.amount,
          currency: 'INR',
          reference_id: body.reference_id,
          short_url: `https://rzp.io/i/stub${counter}`,
          status: 'created',
        };
      },
    },
  };
  return stub as unknown as NonNullable<RazorpayClientOptions['client']>;
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
    await prisma.razorpayOrder.deleteMany({
      where: { paymentRequestId: { in: requests.map((r) => r.id) } },
    });
    await prisma.mandate.deleteMany({
      where: { paymentRequestId: { in: requests.map((r) => r.id) } },
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

async function main(): Promise<void> {
  await cleanup();

  // The Razorpay boundary is replaced BEFORE the server starts taking traffic.
  setRazorpayClientForTesting(new RazorpayClient({ client: createStubSdk() }));

  const app = await buildServer();
  await app.listen({ port: PORT, host: '127.0.0.1' });

  const encKey = parseEncryptionKey(env.MERCHANT_SECRET_ENCRYPTION_KEY);
  const merchant = await prisma.merchant.create({
    data: {
      name: MERCHANT_NAME,
      razorpayKeyId: env.RAZORPAY_KEY_ID,
      razorpayKeySecretEncrypted: encryptSecret(env.RAZORPAY_KEY_SECRET, encKey),
      enabledProtocols: ['ap2'],
    },
    select: { id: true },
  });

  const keypair = generateAgentKeypair();
  const agentExternalId = `gwonly-agent-${randomUUID().slice(0, 8)}`;

  await prisma.agentIdentity.create({
    data: {
      merchantId: merchant.id,
      protocol: 'ap2',
      externalAgentId: agentExternalId,
      publicKey: keypair.publicKeyBase64,
      spendingLimitPaise: 100_000_000n,
    },
  });

  const mandate = (): string => {
    const body: Record<string, unknown> = {
      mandateType: 'IntentMandate',
      agentId: agentExternalId,
      merchantId: merchant.id,
      maxAmountPaise: 100,
      currency: 'INR',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      nonce: `n_${randomUUID()}`,
    };
    body['signature'] = signCanonicalPayload(
      canonicalizeForSigning(body),
      keypair.privateKeyBase64,
    );
    return JSON.stringify(body);
  };

  out('# Gateway-only load & latency baseline — POST /v1/ap2/mandates');
  out();
  out(`Run against \`${GATEWAY}\` on ${new Date().toISOString()}.`);
  out();
  out('## Read this before quoting any number below');
  out();
  out('**The Razorpay API is stubbed out in this run.** These figures describe the');
  out("gateway's own protocol-translation work in isolation. They are NOT end-to-end");
  out('settlement latency, and no payment completes this fast in reality.');
  out();
  out('For the honest end-to-end picture — one that includes a live Razorpay test-mode');
  out('order creation on every request — see `load-profile.md`. That measurement is');
  out("dominated by the Razorpay round-trip to the point where the gateway's own cost is");
  out('not visible in it, which is exactly why this second measurement exists.');
  out();
  out('The two answer different questions:');
  out();
  out('| | `load-profile.md` | this file |');
  out('|---|---|---|');
  out('| Razorpay | live test-mode API | in-process stub |');
  out('| Answers | "what does a payment cost?" | "what does the gateway cost?" |');
  out('| Floor | the network | our own code |');
  out();
  out('## What is stubbed');
  out();
  out("Only the Razorpay **SDK instance** is replaced. The gateway's own `RazorpayClient`");
  out('wrapper still runs — it still builds the order body, pins INR, and shapes the notes.');
  out('Everything else on the path is real: HTTP, the control-character scan, protocol');
  out('detection, Ed25519 verification, JCS canonicalization, the Redis nonce reservation,');
  out('the two-table transaction with its replay constraint, and the row-locked spend-cap');
  out('check against a genuinely contended row.');
  out();
  out('Still one Node process, one local Postgres, one local Redis, on a laptop.');
  out();
  out(`Requests per level: ${REQUESTS_PER_LEVEL}. Percentiles over accepted (202) requests only.`);
  out();
  out(
    '| Concurrency | Requests | OK | 429 | Other errors | p50 (ms) | p95 (ms) | p99 (ms) | Accepted/s |',
  );
  out('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');

  /** Concurrency-1 p50, kept for the comparison against the Phase 6 end-to-end run. */
  let baselineP50 = 0;

  for (const concurrency of LEVELS) {
    const latencies: number[] = [];
    let ok = 0;
    let rateLimited = 0;
    let errors = 0;
    const started = performance.now();

    let dispatched = 0;
    async function worker(): Promise<void> {
      while (dispatched < REQUESTS_PER_LEVEL) {
        dispatched += 1;
        const t0 = performance.now();
        try {
          const response = await fetch(`${GATEWAY}/v1/ap2/mandates`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: mandate(),
          });
          const elapsed = performance.now() - t0;
          await response.arrayBuffer();

          if (response.status === 202) {
            ok += 1;
            latencies.push(elapsed);
          } else if (response.status === 429) {
            rateLimited += 1;
          } else {
            errors += 1;
          }
        } catch {
          errors += 1;
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const elapsedSeconds = (performance.now() - started) / 1000;
    latencies.sort((a, b) => a - b);

    if (concurrency === 1) baselineP50 = percentile(latencies, 50);

    out(
      `| ${concurrency} | ${REQUESTS_PER_LEVEL} | ${ok} | ${rateLimited} | ${errors} | ` +
        `${percentile(latencies, 50).toFixed(1)} | ${percentile(latencies, 95).toFixed(1)} | ` +
        `${percentile(latencies, 99).toFixed(1)} | ${(ok / elapsedSeconds).toFixed(1)} |`,
    );
  }

  out();
  out('## Reading this');
  out();
  out('- Every request contends for the SAME agent row, by design. The spend cap takes a');
  out('  `SELECT … FOR UPDATE` on it (§3.5), so rising concurrency here is measuring the');
  out('  row lock under real contention rather than a best case with the contention');
  out('  engineered away. p95 climbing while p50 stays flat is that queue forming, and it');
  out('  is the correct behaviour: serialised access is the guardrail working.');
  // Computed from THIS run rather than hardcoded. An earlier draft pinned the ratio at
  // a literal 94%, and the next run's concurrency-1 p50 moved enough to make that number
  // disagree with the table printed directly above it.
  const END_TO_END_P50_MS = 106; // docs/load-profile.md, concurrency 1, live Razorpay
  const gatewayShare = (baselineP50 / END_TO_END_P50_MS) * 100;
  out(
    `- **Compare against \`load-profile.md\`.** That run measured p50 = ${END_TO_END_P50_MS} ms at`,
  );
  out('  concurrency 1 with a live Razorpay call in the path. The concurrency-1 p50 above is');
  out('  the same work with only the network removed, so on these two runs the gateway');
  out(`  accounts for about ${gatewayShare.toFixed(0)}% of end-to-end latency and the Razorpay`);
  out(`  round-trip for the other ${(100 - gatewayShare).toFixed(0)}%. Treat this as an order of`);
  out('  magnitude, not a constant: both runs vary by a few milliseconds between');
  out('  invocations, and the two were measured minutes apart on a laptop. The durable');
  out('  finding is that the gateway is a small minority of the time a payment takes.');
  out('- The per-agent rate limiter must be raised for this run (RATE_LIMIT_AGENT_MAX), for');
  out('  the same reason as the Phase 6 profile: all traffic is one agent by design, so the');
  out('  default 60/min ceiling would refuse nearly everything and the run would measure');
  out('  the speed of saying no.');
  out('- A non-zero "other errors" column here is a genuine gateway fault, not a third');
  out('  party having a bad day. With Razorpay removed there is nothing else to blame.');

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\nReport written to ${REPORT}`);

  await app.close();
}

main()
  .catch((error: unknown) => {
    console.error('\nload test FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
    // Redis too, or the open connection keeps the event loop alive and the script
    // hangs after writing its report — which is exactly what it did the first time.
    await disconnectRedis().catch(() => undefined);
  });
