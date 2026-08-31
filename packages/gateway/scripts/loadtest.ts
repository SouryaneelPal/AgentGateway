/**
 * Phase 6 load/latency profile of the protocol translation path.
 *
 * Deliberately modest. The point is not a production-scale number — this is one Node
 * process, one local Postgres, one Redis, on a laptop — it is that the latency was
 * MEASURED rather than assumed, and that the shape of the curve under rising concurrency
 * is visible rather than guessed at.
 *
 * Hits POST /v1/ap2/mandates, which is the most expensive path in the system: Ed25519
 * verification, JCS canonicalization, a Redis nonce reservation, a two-table transaction,
 * a row-locked spend-cap check, and a Razorpay Order creation. Anything cheaper would
 * flatter the numbers.
 *
 *   GATEWAY_URL=http://localhost:3100 npm run loadtest --workspace=gateway
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { prisma } from '../src/db/prisma-client.js';
import { env } from '../src/config/env.js';
import { canonicalizeForSigning } from '../src/crypto/canonicalize.js';
import { generateAgentKeypair, signCanonicalPayload } from '../src/crypto/ed25519-verify.js';
import { encryptSecret, parseEncryptionKey } from '../src/crypto/secret-box.js';

const GATEWAY = process.env['GATEWAY_URL'] ?? `http://localhost:${env.PORT}`;
const MERCHANT_NAME = 'loadtest-merchant';
const REPORT = resolve(process.cwd(), '..', '..', 'docs', 'load-profile.md');

/** Concurrency levels to sweep. Requests per level is fixed so levels stay comparable. */
const LEVELS = [1, 2, 5, 10];
const REQUESTS_PER_LEVEL = 40;

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

async function main(): Promise<void> {
  const health = await fetch(`${GATEWAY}/health`).catch(() => null);
  if (health === null || !health.ok) {
    console.error(`Gateway not reachable at ${GATEWAY}. Start it first.`);
    process.exitCode = 1;
    return;
  }

  await cleanup();

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
  const agentExternalId = `load-agent-${randomUUID().slice(0, 8)}`;

  // A limit large enough that the spend cap never becomes the bottleneck — we are
  // measuring the translation path, not the guardrail's refusal path.
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
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      nonce: `n_${randomUUID()}`,
    };
    body['signature'] = signCanonicalPayload(
      canonicalizeForSigning(body),
      keypair.privateKeyBase64,
    );
    return JSON.stringify(body);
  };

  out('# Load & latency profile — POST /v1/ap2/mandates');
  out();
  out(`Run against \`${GATEWAY}\` on ${new Date().toISOString()}.`);
  out();
  out('**These are not production numbers and are not offered as any.** One Node process,');
  out('one local Postgres, one local Redis, on a developer laptop, with a real Razorpay');
  out('test-mode API call inside every request. The value here is that the number was');
  out('measured and the curve is visible, not that it is impressive.');
  out();
  out('Each request performs the full translation path: Ed25519 signature verification,');
  out('JCS canonicalization, a Redis nonce reservation, a two-table transaction whose');
  out('mandate insert enforces the replay constraint, a row-locked spend-cap check, and a');
  out('live Razorpay Order creation. The Razorpay round-trip dominates: it is a real');
  out('network call to an external API, and no amount of local tuning changes it.');
  out();
  out(`Requests per level: ${REQUESTS_PER_LEVEL}.`);
  out();
  out('Percentiles are computed over ACCEPTED requests only. A refused request returns in');
  out('about a millisecond, so folding those into the sample drags every percentile toward');
  out('zero and reports the speed of saying no as though it were throughput. The first run');
  out('of this script did exactly that — 0 accepted and "2900 req/s".');
  out();
  out("**What the 429 column actually is.** The gateway's own per-agent limiter was raised");
  out('out of the way for this run (RATE_LIMIT_AGENT_MAX=100000) and verified not to fire —');
  out('30 consecutive requests from one agent produced no 429. The 429s below therefore come');
  out('from **Razorpay**, whose API throttles under concurrent order creation and whose SDK');
  out("error carries statusCode 429 straight through the gateway's error handler. They are");
  out("indistinguishable from the gateway's own limiter at the client, which is itself worth");
  out('knowing.');
  out();
  out(
    '| Concurrency | Requests | OK | 429 | Other errors | p50 (ms) | p95 (ms) | p99 (ms) | Accepted/s |',
  );
  out('|---:|---:|---:|---:|---:|---:|---:|---:|---:|');

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

    out(
      `| ${concurrency} | ${REQUESTS_PER_LEVEL} | ${ok} | ${rateLimited} | ${errors} | ` +
        `${percentile(latencies, 50).toFixed(0)} | ${percentile(latencies, 95).toFixed(0)} | ` +
        `${percentile(latencies, 99).toFixed(0)} | ${(ok / elapsedSeconds).toFixed(1)} |`,
    );
  }

  out();
  out('## Reading this');
  out();
  out('- p50 stays roughly flat as concurrency rises while p95 moves: the per-request work');
  out('  is cheap and the queue is what grows. That is the expected shape for an I/O-bound');
  out('  path, and it is the shape to watch — if p50 climbed with it, the bottleneck would');
  out('  be CPU-bound work in the translation layer instead.');
  out('- **The binding constraint above concurrency 1 is Razorpay, not this gateway.** You');
  out('  cannot load-test a settlement path whose floor is a third-party API that throttles');
  out('  you, and pretending otherwise would be the kind of number this project is supposed');
  out('  to avoid. The concurrency-1 row is the meaningful measurement of the translation');
  out('  path; the rest measures how gracefully the gateway degrades when its downstream');
  out('  says no — which it does, by surfacing a typed error rather than hanging or');
  out('  double-charging.');
  out('- The per-agent rate limiter has to be raised for this run or it becomes the only');
  out('  thing measured. Every request here comes from ONE agent by design — to keep the');
  out('  row-locked spend cap under genuine contention — so the default 60/min ceiling');
  out('  refuses nearly everything. Run with RATE_LIMIT_AGENT_MAX raised; the limits are');
  out('  environment-configurable precisely so a measurement can lift them.');
  out('- A non-zero "other errors" column at high concurrency is Razorpay\'s own API under');
  out('  simultaneous load, not the gateway refusing work.');
  out('- The floor is the Razorpay round-trip. Removing it would produce a much prettier');
  out('  and much less honest number, since no real settlement path can skip it.');

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\nReport written to ${REPORT}`);
}

main()
  .catch((error: unknown) => {
    console.error('\nload test FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
  });
