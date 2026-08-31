# Gateway-only load & latency baseline — POST /v1/ap2/mandates

Run against `http://localhost:3199` on 2026-08-31T18:32:36.690Z.

## Read this before quoting any number below

**The Razorpay API is stubbed out in this run.** These figures describe the
gateway's own protocol-translation work in isolation. They are NOT end-to-end
settlement latency, and no payment completes this fast in reality.

For the honest end-to-end picture — one that includes a live Razorpay test-mode
order creation on every request — see `load-profile.md`. That measurement is
dominated by the Razorpay round-trip to the point where the gateway's own cost is
not visible in it, which is exactly why this second measurement exists.

The two answer different questions:

|          | `load-profile.md`           | this file                     |
| -------- | --------------------------- | ----------------------------- |
| Razorpay | live test-mode API          | in-process stub               |
| Answers  | "what does a payment cost?" | "what does the gateway cost?" |
| Floor    | the network                 | our own code                  |

## What is stubbed

Only the Razorpay **SDK instance** is replaced. The gateway's own `RazorpayClient`
wrapper still runs — it still builds the order body, pins INR, and shapes the notes.
Everything else on the path is real: HTTP, the control-character scan, protocol
detection, Ed25519 verification, JCS canonicalization, the Redis nonce reservation,
the two-table transaction with its replay constraint, and the row-locked spend-cap
check against a genuinely contended row.

Still one Node process, one local Postgres, one local Redis, on a laptop.

Requests per level: 200. Percentiles over accepted (202) requests only.

| Concurrency | Requests |  OK | 429 | Other errors | p50 (ms) | p95 (ms) | p99 (ms) | Accepted/s |
| ----------: | -------: | --: | --: | -----------: | -------: | -------: | -------: | ---------: |
|           1 |      200 | 200 |   0 |            0 |     10.8 |     18.4 |     22.9 |       83.7 |
|           2 |      200 | 200 |   0 |            0 |     13.0 |     16.5 |     25.9 |      147.3 |
|           5 |      200 | 200 |   0 |            0 |     23.5 |     28.9 |     42.2 |      208.1 |
|          10 |      200 | 200 |   0 |            0 |     43.4 |     60.3 |     71.2 |      220.6 |
|          25 |      200 | 200 |   0 |            0 |    110.7 |    144.5 |    163.2 |      222.8 |

## Reading this

- Every request contends for the SAME agent row, by design. The spend cap takes a
  `SELECT … FOR UPDATE` on it (§3.5), so rising concurrency here is measuring the
  row lock under real contention rather than a best case with the contention
  engineered away. p95 climbing while p50 stays flat is that queue forming, and it
  is the correct behaviour: serialised access is the guardrail working.
- **Compare against `load-profile.md`.** That run measured p50 = 106 ms at
  concurrency 1 with a live Razorpay call in the path. The concurrency-1 p50 above is
  the same work with only the network removed, so on these two runs the gateway
  accounts for about 10% of end-to-end latency and the Razorpay
  round-trip for the other 90%. Treat this as an order of
  magnitude, not a constant: both runs vary by a few milliseconds between
  invocations, and the two were measured minutes apart on a laptop. The durable
  finding is that the gateway is a small minority of the time a payment takes.
- The per-agent rate limiter must be raised for this run (RATE_LIMIT_AGENT_MAX), for
  the same reason as the Phase 6 profile: all traffic is one agent by design, so the
  default 60/min ceiling would refuse nearly everything and the run would measure
  the speed of saying no.
- A non-zero "other errors" column here is a genuine gateway fault, not a third
  party having a bad day. With Razorpay removed there is nothing else to blame.
