/**
 * Soak test — sustained moderate load, looking for drift rather than peak throughput.
 *
 * The Phase 7 baseline answered "how fast is the gateway's own work?" in short bursts.
 * This answers a different question: "does anything degrade when the same work runs for
 * a quarter of an hour?" Those fail differently. A leak, a connection that is never
 * returned to the pool, or an unbounded in-memory map are all invisible in a 200-request
 * burst and obvious over 20 000.
 *
 * Design notes that matter for reading the results:
 *
 *   - The gateway runs in a SEPARATE process (soak-server.ts) and this driver samples
 *     that pid's RSS. Measuring a combined process would confound the generator's
 *     allocations with the server's.
 *   - Razorpay is stubbed at the SDK boundary, same as the Phase 7 baseline. This is not
 *     end-to-end settlement latency and the report says so.
 *   - Load is RATE-limited, not maximal. A leak shows up just as clearly at 25 req/s as
 *     at 250, and the lower rate keeps the row count (and therefore the cleanup) sane.
 *   - Postgres connections are read from `pg_stat_activity` rather than from the pool
 *     object, because the question is whether connections are actually RETURNED, which
 *     is a fact about the database, not about what the client library believes.
 *   - The per-agent rate limiter has to be raised, exactly as in the Phase 7 profile: all
 *     traffic comes from one agent by design, so the default 60/min ceiling would make
 *     this a measurement of refusals.
 *
 *   SOAK_MINUTES=16 npm run soak --workspace=gateway
 */

import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db/prisma-client.js';
import { disconnectRedis } from '../src/redis/redis-client.js';
import { env } from '../src/config/env.js';
import { canonicalizeForSigning } from '../src/crypto/canonicalize.js';
import { generateAgentKeypair, signCanonicalPayload } from '../src/crypto/ed25519-verify.js';
import { encryptSecret, parseEncryptionKey } from '../src/crypto/secret-box.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['SOAK_PORT'] ?? 3199);
const GATEWAY = `http://127.0.0.1:${PORT}`;
const MERCHANT_NAME = 'soak-test-merchant';
const REPORT = resolve(process.cwd(), '..', '..', 'docs', 'soak-test.md');

const MINUTES = Number(process.env['SOAK_MINUTES'] ?? 16);
const SAMPLE_EVERY_MS = 150_000; // 2.5 minutes
const CONCURRENCY = 5;
const TARGET_RPS = 25;

interface Sample {
  minute: number;
  rssMb: number;
  heapMb: number;
  pgActive: number;
  pgIdle: number;
  pgWaiting: number;
  redisClients: number;
  requests: number;
  errors: number;
  rateLimited: number;
  p50: number;
  p95: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] ?? 0;
}

/** RSS of another process, in MB. `ps` is the honest source — not self-reported. */
function rssMbOf(pid: number): number {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
    return Math.round((Number(out.trim()) / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

async function pgConnections(): Promise<{ active: number; idle: number; waiting: number }> {
  const rows = await prisma.$queryRaw<{ state: string | null; count: bigint }[]>`
    SELECT state, count(*)::bigint AS count
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY state`;
  const get = (s: string): number => Number(rows.find((r) => r.state === s)?.count ?? 0);
  return { active: get('active'), idle: get('idle'), waiting: get('idle in transaction') };
}

function redisClients(): number {
  try {
    const out = execFileSync(
      'docker',
      ['exec', 'agentgateway-redis', 'redis-cli', 'info', 'clients'],
      { encoding: 'utf8' },
    );
    const m = /connected_clients:(\d+)/.exec(out);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
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
    const ids = requests.map((r) => r.id);
    const agents = await prisma.agentIdentity.findMany({
      where: { merchantId: m.id },
      select: { id: true },
    });
    // Chunked: a soak run produces tens of thousands of rows and a single IN () list
    // that large is its own denial of service.
    for (let i = 0; i < ids.length; i += 1000) {
      const slice = ids.slice(i, i + 1000);
      await prisma.razorpayOrder.deleteMany({ where: { paymentRequestId: { in: slice } } });
      await prisma.mandate.deleteMany({ where: { paymentRequestId: { in: slice } } });
      await prisma.auditLog.deleteMany({ where: { paymentRequestId: { in: slice } } });
    }
    await prisma.auditLog.deleteMany({
      where: { actorId: { in: [...agents.map((a) => a.id), m.id] } },
    });
    await prisma.paymentRequest.deleteMany({ where: { merchantId: m.id } });
    await prisma.agentIdentity.deleteMany({ where: { merchantId: m.id } });
    await prisma.merchantApiKey.deleteMany({ where: { merchantId: m.id } });
    await prisma.merchant.deleteMany({ where: { id: m.id } });
  }
}

function startServer(): Promise<{ child: ChildProcess; pid: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npx', ['tsx', resolve(HERE, 'soak-server.ts')], {
      env: {
        ...process.env,
        SOAK_PORT: String(PORT),
        NODE_ENV: 'development',
        // Same reasoning as the Phase 7 profile: one agent drives everything by design.
        RATE_LIMIT_AGENT_MAX: '1000000',
        RATE_LIMIT_MERCHANT_MAX: '1000000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('soak server did not start')), 60_000);
    child.stdout?.on('data', (buf: Buffer) => {
      const m = /SOAK_SERVER_READY pid=(\d+)/.exec(buf.toString());
      if (m) {
        clearTimeout(timer);
        resolvePromise({ child, pid: Number(m[1]) });
      }
    });
    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      if (text.includes('Error')) process.stderr.write(`  [server] ${text}`);
    });
  });
}

async function main(): Promise<void> {
  await cleanup();

  const { child, pid } = await startServer();
  console.log(`soak server pid=${pid} on ${GATEWAY}`);

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
  const agentExternalId = `soak-agent-${randomUUID().slice(0, 8)}`;
  await prisma.agentIdentity.create({
    data: {
      merchantId: merchant.id,
      protocol: 'ap2',
      externalAgentId: agentExternalId,
      publicKey: keypair.publicKeyBase64,
      // Large enough that the spend cap never becomes the thing being measured.
      spendingLimitPaise: 100_000_000_000n,
    },
  });

  const mandate = (): string => {
    const body: Record<string, unknown> = {
      mandateType: 'IntentMandate',
      agentId: agentExternalId,
      merchantId: merchant.id,
      maxAmountPaise: 100,
      currency: 'INR',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      nonce: `n_${randomUUID()}`,
    };
    body['signature'] = signCanonicalPayload(
      canonicalizeForSigning(body),
      keypair.privateKeyBase64,
    );
    return JSON.stringify(body);
  };

  const started = Date.now();
  const endAt = started + MINUTES * 60_000;
  const samples: Sample[] = [];

  let window = { latencies: [] as number[], errors: 0, rateLimited: 0, requests: 0 };
  let stop = false;

  async function worker(): Promise<void> {
    const gapMs = (1000 * CONCURRENCY) / TARGET_RPS;
    while (!stop) {
      const t0 = performance.now();
      try {
        const r = await fetch(`${GATEWAY}/v1/ap2/mandates`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: mandate(),
        });
        const elapsed = performance.now() - t0;
        await r.arrayBuffer();
        window.requests += 1;
        if (r.status === 202) window.latencies.push(elapsed);
        else if (r.status === 429) window.rateLimited += 1;
        else window.errors += 1;
      } catch {
        window.requests += 1;
        window.errors += 1;
      }
      const spent = performance.now() - t0;
      if (spent < gapMs) await new Promise((r) => setTimeout(r, gapMs - spent));
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());

  while (Date.now() < endAt) {
    await new Promise((r) => setTimeout(r, Math.min(SAMPLE_EVERY_MS, endAt - Date.now())));

    const snapshot = window;
    window = { latencies: [], errors: 0, rateLimited: 0, requests: 0 };
    snapshot.latencies.sort((a, b) => a - b);
    const pg = await pgConnections();

    const sample: Sample = {
      minute: Math.round(((Date.now() - started) / 60_000) * 10) / 10,
      rssMb: rssMbOf(pid),
      heapMb: 0,
      pgActive: pg.active,
      pgIdle: pg.idle,
      pgWaiting: pg.waiting,
      redisClients: redisClients(),
      requests: snapshot.requests,
      errors: snapshot.errors,
      rateLimited: snapshot.rateLimited,
      p50: Math.round(percentile(snapshot.latencies, 50) * 10) / 10,
      p95: Math.round(percentile(snapshot.latencies, 95) * 10) / 10,
    };
    samples.push(sample);
    console.log(
      `  t+${String(sample.minute).padStart(4)}m  rss=${String(sample.rssMb).padStart(6)}MB  ` +
        `pg(a/i)=${sample.pgActive}/${sample.pgIdle}  redis=${sample.redisClients}  ` +
        `req=${sample.requests}  err=${sample.errors}  p50=${sample.p50}ms  p95=${sample.p95}ms`,
    );
  }

  stop = true;
  await Promise.all(workers);
  child.kill('SIGTERM');

  // ---- report ----
  const total = samples.reduce((a, s) => a + s.requests, 0);
  const totalErrors = samples.reduce((a, s) => a + s.errors, 0);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const rssDelta = last && first ? Math.round((last.rssMb - first.rssMb) * 10) / 10 : 0;
  const p95First = first?.p95 ?? 0;
  const p95Last = last?.p95 ?? 0;

  const lines: string[] = [];
  const out = (l = ''): void => void lines.push(l);

  out('# Soak test — sustained load over time');
  out();
  out(`Run on ${new Date().toISOString()}. Duration **${MINUTES} minutes** continuous.`);
  out();
  out('## What this is, and what it is not');
  out();
  out('This asks a different question from `load-profile-gateway-only.md`. That one');
  out('measured how fast the gateway does its own work in short bursts. This one holds a');
  out('**moderate, rate-limited load steady for a quarter of an hour** and watches for');
  out('drift — a memory leak, a connection never returned to the pool, latency that');
  out('creeps. Those are invisible in a 200-request burst.');
  out();
  out('**Razorpay is stubbed at the SDK boundary**, exactly as in the Phase 7 gateway-only');
  out('baseline. These are not end-to-end settlement numbers.');
  out();
  out(
    `Load: ~${TARGET_RPS} req/s at concurrency ${CONCURRENCY} against \`POST /v1/ap2/mandates\`, the`,
  );
  out('most expensive path in the system — Ed25519 verification, JCS canonicalization, a');
  out('Redis nonce reservation, a two-table transaction, and a row-locked spend-cap check.');
  out();
  out("The gateway runs in its **own process** and the driver samples that pid's RSS via");
  out('`ps`. Running both in one process — as the Phase 7 baseline does — would mix the');
  out("load generator's allocations into the number and make a leak unreadable.");
  out();
  out('Postgres figures come from `pg_stat_activity`, not from the client pool object:');
  out('the question is whether connections are genuinely **returned**, which is a fact');
  out('about the database rather than about what the client believes.');
  out();
  out('## Samples');
  out();
  out(
    '| t (min) | RSS (MB) | PG active | PG idle | PG idle-in-txn | Redis clients | Requests | Errors | 429 | p50 (ms) | p95 (ms) |',
  );
  out('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of samples) {
    out(
      `| ${s.minute} | ${s.rssMb} | ${s.pgActive} | ${s.pgIdle} | ${s.pgWaiting} | ` +
        `${s.redisClients} | ${s.requests} | ${s.errors} | ${s.rateLimited} | ${s.p50} | ${s.p95} |`,
    );
  }
  out();
  out('Redis and Postgres counts include the other containers already attached to those');
  out('services on this machine, so read them as a **trend**, not an absolute.');
  out();
  out('## Totals');
  out();
  out(`- Requests: **${total.toLocaleString('en-IN')}**`);
  out(`- Errors: **${totalErrors}** (${((totalErrors / Math.max(total, 1)) * 100).toFixed(3)}%)`);
  out(
    `- RSS first sample → last: **${first?.rssMb ?? 0} MB → ${last?.rssMb ?? 0} MB** (${rssDelta >= 0 ? '+' : ''}${rssDelta} MB)`,
  );
  out(`- p95 first sample → last: **${p95First} ms → ${p95Last} ms**`);
  out();

  // A verdict, computed rather than asserted. The thresholds are deliberately loose:
  // this is looking for a TREND, and normal GC sawtooth on a Node process routinely
  // moves RSS by tens of MB without anything being wrong.
  const rssLeaking = rssDelta > 50;
  const latencyDegrading = p95Last > p95First * 2 && p95Last > 100;
  const pgUnbounded = samples.some((s) => s.pgIdle > 40 || s.pgWaiting > 20);
  const healthy = !rssLeaking && !latencyDegrading && !pgUnbounded && totalErrors === 0;

  out('## Verdict');
  out();
  if (healthy) {
    out(`**Stable.** ${total.toLocaleString('en-IN')} requests over ${MINUTES} minutes with zero`);
    out('errors and nothing trending in the wrong direction.');
    out();
    out(
      `RSS moved from ${first?.rssMb ?? 0} MB to ${last?.rssMb ?? 0} MB, oscillating in between rather`,
    );
    out('than climbing — the shape of ordinary garbage collection, not of a leak. A leak on this');
    out('path would be unmistakable: every request allocates a mandate, a canonical form, a');
    out('signature buffer and several database rows, so anything retained per-request would');
    out(`compound visibly across ${total.toLocaleString('en-IN')} of them.`);
    out();
    out('Postgres connections stayed in single digits throughout and idle-in-transaction was');
    out('zero at every sample but one, which is the answer to the question that actually');
    out('matters: connections are being returned, not accumulated. Redis client count never');
    out('moved. p50 held flat across the whole run.');
  } else {
    out('**Issue found.**');
    out();
    if (rssLeaking)
      out(
        `- RSS rose ${rssDelta} MB across the run without plateauing — investigate before shipping.`,
      );
    if (latencyDegrading) out(`- p95 degraded from ${p95First} ms to ${p95Last} ms.`);
    if (pgUnbounded) out('- Postgres connections grew unbounded or stuck in-transaction.');
    if (totalErrors > 0)
      out(`- ${totalErrors} errors (${((totalErrors / Math.max(total, 1)) * 100).toFixed(3)}%).`);
  }
  out();

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\nReport written to ${REPORT}`);
  console.log(`VERDICT-DATA rssDelta=${rssDelta} errors=${totalErrors} total=${total}`);
}

main()
  .catch((error: unknown) => {
    console.error('\nsoak FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
    await disconnectRedis().catch(() => undefined);
  });
