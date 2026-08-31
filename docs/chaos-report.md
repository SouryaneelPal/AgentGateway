# Chaos scenarios — live results

Run against `http://localhost:3100` on 2026-08-31T14:04:49.027Z.

Each scenario runs over real HTTP against a running gateway with a real Postgres
and Redis behind it. The test suite covers the same four properties; this exists
to show the deployed system doing it, not just the unit under test.

---

## Scenario 1 — Replayed AP2 mandate

A captured mandate is submitted a second time, byte for byte. §3.2 requires it be
rejected **before any database write**, on the Redis fast path.

```
payment_requests before      : 0
first delivery               : HTTP 202  awaiting_settlement
payment_requests after first : 1
REPLAY (identical bytes)     : HTTP 409  nonce_replayed
  caught by                  : {"nonce":"n_4cb8db92-bc00-4110-9912-1c703d5e5333","caughtBy":"redis"}
payment_requests after replay: 1
```

**PASS** — the replay created no new payment_request (1 before, 1 after). Rejected pre-database.

---

## Scenario 2 — 20 concurrent requests against a cap that fits 7

Twenty mandates are submitted simultaneously against a spending limit that can
cover exactly seven. §3.5 requires the row lock to make the outcome exact, not
approximate — eight would mean a lost update.

```
requests fired               : 20
spending limit               : 175000 paise (fits 7)

    7 x HTTP 202 awaiting_settlement
   13 x HTTP 403 spend_cap_exceeded

accepted (HTTP 202)          : 7
spend_cap_exceeded (HTTP 403): 13
spent_paise after            : 175000  (= 7 x 25000)
limit                        : 175000
```

**PASS** — spent_paise (175000) never exceeded the limit (175000), and no more than 7 requests were accepted. The row lock made the outcome exact under 20-way contention.

---

## Scenario 3 — Webhook with a tampered signature

A well-formed webhook whose HMAC has one hex digit flipped. §3.4 requires it be
rejected, recorded with `signature_valid: false`, and change nothing.

```
payment_request status before : awaiting_settlement
delivery                      : HTTP 400  invalid_signature
webhook_events row created    : yes
  signature_valid             : false
  processed_at                : NULL (not acted on)
payment_request status after  : awaiting_settlement
audit_log rows before / after : 1 / 1
```

**PASS** — rejected with 400, recorded as invalid rather than dropped, and no state changed.

---

## Scenario 4 — The same payment delivered as three events, twice over

This is the real Razorpay behaviour observed on 2026-08-30: one payment fires
`payment.captured`, `order.paid` and `payment_link.paid`, each with its own event
id. Then each is redelivered. Six deliveries, one settlement.

```
payment.captured     first: HTTP 200 settled  |  redelivery: HTTP 200 duplicate_ignored
order.paid           first: HTTP 200 already_settled  |  redelivery: HTTP 200 duplicate_ignored
payment_link.paid    first: HTTP 200 already_settled  |  redelivery: HTTP 200 duplicate_ignored

deliveries made               : 6 (3 events x 2)
webhook_events rows stored    : 3   (one per distinct event id)
webhook_settled audit rows    : 1   <- must be exactly 1
payment_request final status  : settled
```

**PASS** — six deliveries, three stored events, exactly one settlement. The two guards do different jobs: event-id dedupe catches the redeliveries, the settlement guard collapses the three distinct events.

---

Fixtures are torn down after each run; `docs/chaos-report.md` is the only artifact left behind.
