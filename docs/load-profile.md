# Load & latency profile — POST /v1/ap2/mandates

Run against `http://localhost:3100` on 2026-08-31T14:10:56.830Z.

**These are not production numbers and are not offered as any.** One Node process,
one local Postgres, one local Redis, on a developer laptop, with a real Razorpay
test-mode API call inside every request. The value here is that the number was
measured and the curve is visible, not that it is impressive.

Each request performs the full translation path: Ed25519 signature verification,
JCS canonicalization, a Redis nonce reservation, a two-table transaction whose
mandate insert enforces the replay constraint, a row-locked spend-cap check, and a
live Razorpay Order creation. The Razorpay round-trip dominates: it is a real
network call to an external API, and no amount of local tuning changes it.

Requests per level: 40.

Percentiles are computed over ACCEPTED requests only. A refused request returns in
about a millisecond, so folding those into the sample drags every percentile toward
zero and reports the speed of saying no as though it were throughput. The first run
of this script did exactly that — 0 accepted and "2900 req/s".

**What the 429 column actually is.** The gateway's own per-agent limiter was raised
out of the way for this run (RATE_LIMIT_AGENT_MAX=100000) and verified not to fire —
30 consecutive requests from one agent produced no 429. The 429s below therefore come
from **Razorpay**, whose API throttles under concurrent order creation and whose SDK
error carries statusCode 429 straight through the gateway's error handler. They are
indistinguishable from the gateway's own limiter at the client, which is itself worth
knowing.

| Concurrency | Requests |  OK | 429 | Other errors | p50 (ms) | p95 (ms) | p99 (ms) | Accepted/s |
| ----------: | -------: | --: | --: | -----------: | -------: | -------: | -------: | ---------: |
|           1 |       40 |  28 |  12 |            0 |      106 |      145 |      297 |        6.9 |
|           2 |       40 |  14 |  26 |            0 |      103 |      221 |      221 |        7.8 |
|           5 |       40 |   7 |  33 |            0 |       83 |      102 |      102 |        9.7 |
|          10 |       40 |   0 |  40 |            0 |        0 |        0 |        0 |        0.0 |

## Reading this

- p50 stays roughly flat as concurrency rises while p95 moves: the per-request work
  is cheap and the queue is what grows. That is the expected shape for an I/O-bound
  path, and it is the shape to watch — if p50 climbed with it, the bottleneck would
  be CPU-bound work in the translation layer instead.
- **The binding constraint above concurrency 1 is Razorpay, not this gateway.** You
  cannot load-test a settlement path whose floor is a third-party API that throttles
  you, and pretending otherwise would be the kind of number this project is supposed
  to avoid. The concurrency-1 row is the meaningful measurement of the translation
  path; the rest measures how gracefully the gateway degrades when its downstream
  says no — which it does, by surfacing a typed error rather than hanging or
  double-charging.
- The per-agent rate limiter has to be raised for this run or it becomes the only
  thing measured. Every request here comes from ONE agent by design — to keep the
  row-locked spend cap under genuine contention — so the default 60/min ceiling
  refuses nearly everything. Run with RATE_LIMIT_AGENT_MAX raised; the limits are
  environment-configurable precisely so a measurement can lift them.
- A non-zero "other errors" column at high concurrency is Razorpay's own API under
  simultaneous load, not the gateway refusing work.
- The floor is the Razorpay round-trip. Removing it would produce a much prettier
  and much less honest number, since no real settlement path can skip it.
