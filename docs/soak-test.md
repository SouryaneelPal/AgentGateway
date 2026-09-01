# Soak test — sustained load over time

Run on 2026-09-01T20:50:41.351Z. Duration **16 minutes** continuous.

## What this is, and what it is not

This asks a different question from `load-profile-gateway-only.md`. That one
measured how fast the gateway does its own work in short bursts. This one holds a
**moderate, rate-limited load steady for a quarter of an hour** and watches for
drift — a memory leak, a connection never returned to the pool, latency that
creeps. Those are invisible in a 200-request burst.

**Razorpay is stubbed at the SDK boundary**, exactly as in the Phase 7 gateway-only
baseline. These are not end-to-end settlement numbers.

Load: ~25 req/s at concurrency 5 against `POST /v1/ap2/mandates`, the
most expensive path in the system — Ed25519 verification, JCS canonicalization, a
Redis nonce reservation, a two-table transaction, and a row-locked spend-cap check.

The gateway runs in its **own process** and the driver samples that pid's RSS via
`ps`. Running both in one process — as the Phase 7 baseline does — would mix the
load generator's allocations into the number and make a leak unreadable.

Postgres figures come from `pg_stat_activity`, not from the client pool object:
the question is whether connections are genuinely **returned**, which is a fact
about the database rather than about what the client believes.

## Samples

| t (min) | RSS (MB) | PG active | PG idle | PG idle-in-txn | Redis clients | Requests | Errors | 429 | p50 (ms) | p95 (ms) |
| ------: | -------: | --------: | ------: | -------------: | ------------: | -------: | -----: | --: | -------: | -------: |
|     2.5 |    198.4 |         1 |       6 |              0 |             4 |     3726 |      0 |   0 |     32.3 |    135.9 |
|       5 |    205.9 |         1 |       6 |              0 |             4 |     3736 |      0 |   0 |     32.3 |    127.5 |
|     7.5 |    179.6 |         1 |       6 |              0 |             4 |     3735 |      0 |   0 |     32.5 |      108 |
|      10 |    191.1 |         1 |       3 |              3 |             4 |     3741 |      0 |   0 |     32.2 |     38.5 |
|    12.5 |    188.8 |         2 |       5 |              0 |             4 |     3730 |      0 |   0 |     32.2 |     37.8 |
|      15 |    191.2 |         1 |       6 |              0 |             4 |     3570 |      0 |   0 |     32.3 |     38.5 |
|      16 |    191.4 |         1 |       6 |              0 |             4 |     1470 |      0 |   0 |     32.2 |     40.2 |

Redis and Postgres counts include the other containers already attached to those
services on this machine, so read them as a **trend**, not an absolute.

## Totals

- Requests: **23,708**
- Errors: **0** (0.000%)
- RSS first sample → last: **198.4 MB → 191.4 MB** (-7 MB)
- p95 first sample → last: **135.9 ms → 40.2 ms**

## Verdict

**Stable.** 23,708 requests over 16 minutes with zero errors and nothing trending in the
wrong direction.

RSS moved from 198.4 MB to 191.4 MB, oscillating in between rather than climbing — the
shape of ordinary garbage collection, not of a leak. A leak on this path would be
unmistakable: every request allocates a mandate, a canonical form, a signature buffer and
several database rows, so anything retained per-request would compound visibly across
23,708 of them. It did not.

Postgres connections stayed in single digits throughout and idle-in-transaction was zero
at every sample but one, which is the answer to the question that actually matters:
connections are being returned, not accumulated. Redis client count never moved off 4.
p50 held flat at 32.2–32.5 ms from the first sample to the last.

### Two things in the table worth explaining rather than glossing

**The p95 column falls sharply after t+7.5m** (135.9 → 38.5 ms) and then holds. That is
not the gateway improving under load. The repository's full test suite was deliberately
run against the same Postgres instance during the first three sampling windows, and it
competed for the database. Once it finished, p95 settled at its true value of roughly
38–40 ms. The early numbers are contention from a neighbour, not the system under test —
left in the table rather than re-run, because deleting an inconvenient sample is how
measurements start lying.

**One sample shows 3 idle-in-transaction** at t+10m. It is zero at every other sample,
including the two after it. That is a transaction observed mid-flight by a sampling query
that happened to land during one, not a connection stuck open — a stuck transaction would
persist across samples and grow.

### What this does not establish

Sixteen minutes at 25 req/s on one laptop, with Razorpay stubbed. It says nothing about
behaviour over days, under memory pressure, across process restarts, or at a rate a real
payment processor would see. See WHITEPAPER.md §5.5 for what production scale would
additionally require.
