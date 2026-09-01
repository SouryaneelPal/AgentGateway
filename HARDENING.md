# Hardening pass (Phases 7 and 7.5)

A bounded review in two parts. **Phase 7** covered the gateway: input validation across
every route, error-response consistency, security headers and CORS, and a performance
baseline that isolates the gateway from its downstream. **Phase 7.5** added an
accessibility baseline over the merchant console — see
[Accessibility baseline](#accessibility-baseline-phase-75).

**Method.** Nothing here was concluded by reading the source and reasoning about what it
probably does. Gateway findings came from firing hostile input at a **running** gateway
and reading the actual response bodies and server logs. Console findings came from
measuring a running browser — contrast ratios computed from the tokens, focus order and
accessible names read off the live accessibility tree. That distinction produced every
real defect below; several were invisible to inspection.

Each gateway fix carries a regression test, and each test was **mutation-verified**: the
guard was deliberately broken, the test confirmed failing, and the guard restored.

---

## What was found and fixed

Six defects. Five were reachable by any unauthenticated caller.

### 1. A null byte produced an HTTP 500 with a full internal stack — CRITICAL

`POST /v1/ap2/mandates` with an `agentId` containing a literal `U+0000` returned **500**, because Postgres
cannot store `U+0000` in a text column and raises error `22021`. The Prisma error escaped
the handler, and the response body handed the caller:

- the absolute source path `/Users/…/src/adapters/ap2.adapter.ts:132:46`
- four lines of our own source code around the failing query
- the raw Postgres error code and message

Two independent bugs in one response: input reaching the database unvalidated, and the
error handler echoing internal detail.

**Fixed** by a body-wide control-character scan (`preValidation` hook in
[server.ts](packages/gateway/src/server.ts)) plus per-field bounds in the adapters.

### 2. Every 5xx echoed the underlying error message — CRITICAL

The global handler ended with `message: error.message`, which for any database failure
meant source paths, source code, and raw driver errors going to unauthenticated callers.

**Fixed:** 5xx responses now return a fixed message plus a `requestId`. The full error is
logged server-side; the request id correlates a caller's report to that log line.

Suppression is **unconditional**, not gated on `NODE_ENV=production`. A leak that only
appears in production is a leak nobody sees while building — this one survived five phases
precisely because development responses looked informative rather than dangerous.

### 3. A non-UUID `merchantId` produced an HTTP 500 — HIGH

`merchantId` and `agentIdentityId` are `uuid` columns. A value that is not syntactically a
UUID does not return zero rows — it fails inside Postgres with `invalid input syntax for
type uuid`, which surfaced as a 500. **A one-character `merchantId` was enough**, on both
`/v1/x402/checkout/:cartId` and `/v1/fallback/payment-links`.

**Fixed** with an `isUuid()` guard before the query on every route taking a caller-supplied
UUID.

### 4. No length bounds on the protocol routes — MEDIUM

The merchant routes had caps; the x402/AP2/fallback routes had none. A 200 KB `agentId`
was canonicalized, hashed, and used as a database lookup key before anything objected.

**Fixed** with per-field bounds at `readString`, the single helper all three adapters
already route untrusted reads through. See
[validation.ts](packages/gateway/src/validation.ts).

### 5. An unauthenticated caller could permanently suppress a settlement webhook — CRITICAL

Found while probing, and the most serious finding in this pass. It inverts §1.3, the rule
the whole system rests on.

The redelivery guard (§3.4) ran **before** signature verification, and a delivery that
failed verification was still stored under the `razorpay_event_id` the caller supplied.
Since that column is `UNIQUE` and the guard consults it:

1. Attacker POSTs to `/webhooks/razorpay` with a garbage signature and a chosen
   `X-Razorpay-Event-Id`. Rejected `400` — but the id is now on record.
2. Razorpay later delivers the **genuine** event with that id.
3. The guard sees the existing row and answers **`200 duplicate_ignored`**.

The settlement is silently dropped, and because it is a `200`, Razorpay treats the event as
delivered and stops retrying. A genuinely paid order strands at `awaiting_settlement`
permanently.

§1.3 says only a signature-verified webhook may confirm settlement. Anything that can mute
that webhook can prevent settlement from ever being recorded — which is what this was.

Confirmed live before fixing:

```
1. attacker, bad signature              400  {"error":"invalid_signature", ...}
2. genuine delivery, valid signature    200  {"status":"duplicate_ignored", ...}   ← suppressed
```

And after:

```
2. genuine delivery, valid signature    200  {"status":"acknowledged", ...}        ← processed
```

**Fixed** by verifying the signature _before_ consulting the redelivery guard, and storing
unverified deliveries under a namespaced id (`invalid:<claimed-id>:<body-hash>`). Invalid
deliveries are still recorded — §2.4/§3.4 require that they are logged and rejected, never
silently dropped — but a delivery now only earns the genuine event id by proving it came
from Razorpay. The body hash makes a repeated identical forgery idempotent instead of
unbounded.

> This one was outside the four items this pass was scoped to. It was found by the
> probing those items called for, and shipping a hardening document while leaving a known
> settlement-suppression hole open was not a defensible option.

### 6. The SSE endpoint reflected any origin — MEDIUM

`GET /v1/merchant/stream` writes to `reply.raw`, so `@fastify/cors` never sees the response
and it sets CORS headers by hand. It echoed **any** origin in development — the same
reflect-anything behaviour being removed from the plugin in this pass. Found while
documenting the CORS policy, by checking the claim instead of asserting it.

**Fixed:** both call sites now share one predicate in
[config/cors.ts](packages/gateway/src/config/cors.ts), so the documented policy and the
enforced policy cannot drift.

---

## Input validation

### Coverage

Every route across all three workspaces, against: negative and zero amounts, non-integer
amounts, `Number.MAX_SAFE_INTEGER`, oversized strings (200 KB), 2 MB bodies, malformed
JSON, empty/array/null bodies, unicode and emoji, RTL override characters, null bytes and
control characters (in read fields, unread fields, object keys, and nested arrays),
injection-shaped strings, and wrong content types.

| Workspace    | Surface              | Result                                                                                   |
| ------------ | -------------------- | ---------------------------------------------------------------------------------------- |
| gateway      | 11 routes            | all hostile input → typed 4xx; no 5xx; no leaks                                          |
| dashboard    | `GET /api/traces`    | takes no caller input at all — nothing to validate                                       |
| agent-client | CLI + LLM tool calls | no server surface; spend ceiling already enforced locally, not trusted from model output |

Bounds live in one place, [validation.ts](packages/gateway/src/validation.ts):
identifiers 128, nonces 256, signatures 1024, URLs 2048, descriptions 512, amounts
≤ 100,000,000 paise.

### Control characters are rejected, not stripped

Stripping would silently change bytes that are about to be canonicalized and
signature-checked. A mandate that verifies against something other than what the agent
sent is a worse outcome than a refused one.

The scan runs **body-wide**, not just on fields the adapters read, because the fallback
adapter persists the entire body (`JSON.stringify(body)` and `raw: { ...body }`). A null
byte in a field nothing reads still reaches Postgres. Object keys are checked too.

### SQL injection: proven, not assumed

The requirement was to prove Prisma's parameterization rather than trust it.

**A 400 response proves nothing** — it only proves the request was rejected, which could
happen for any reason. The meaningful assertion is a **round-trip**: store an
injection-shaped string, read it back, and confirm it returns byte-identical while the
table it names still exists. A string that survives as _data_ was never interpreted as
_SQL_.

Five payloads (`'; DROP TABLE payment_requests; --`, `' OR '1'='1`, an `UPDATE` raising a
spending limit, a `SELECT` exfiltrating an encrypted key, and a stacked `DELETE`) are each
round-tripped, and the `UPDATE` payload is verified not to have changed the limit it
targets.

The last test drives a payload through **`$queryRaw`** — the one raw query in the codebase,
in §3.5's row-locked spend cap. It is a tagged template, so interpolations are bound as
parameters, but that is exactly the claim worth testing rather than trusting: a
concatenating implementation would raise a syntax error where this returns a row.

All in [test/input-validation.test.ts](packages/gateway/test/input-validation.test.ts).

### Where validation is deliberately permissive

| Decision                                               | Why                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identifiers accept arbitrary unicode (emoji, CJK, RTL) | Agent ids originate in other people's systems. A character allowlist would break legitimate callers and is not a security control — the database is protected by parameterization, not by charset filtering. Tested explicitly: `café-日本語-🎉` is refused as an _unknown agent_, not as malformed. |
| Tabs and newlines rejected along with other controls   | No field here is prose. Allowing line breaks would let an audit entry forge its own line structure when rendered.                                                                                                                                                                                    |
| Unknown agents auto-registered by the fallback adapter | Deliberate graceful degradation (§2.2). They land at `untrusted` with a `spending_limit_paise` of 0, so nothing can be spent until a merchant raises it.                                                                                                                                             |
| Webhook bodies not length-capped beyond `bodyLimit`    | Razorpay controls the payload and it is HMAC-verified before use.                                                                                                                                                                                                                                    |
| `expiresAt` accepts any parseable date                 | Expiry is enforced separately against the current time; parse strictness would add nothing.                                                                                                                                                                                                          |
| Amount ceiling of ₹10,00,000                           | A policy choice for a test-mode build, not a protocol limit. Configurable in one constant.                                                                                                                                                                                                           |

---

## Error handling

Every error path returns a typed, predictable shape:

| Condition             | Status  | Body                                                           |
| --------------------- | ------- | -------------------------------------------------------------- |
| Validation failure    | 400     | `{ error: "malformed_request", detail \| message, requestId }` |
| Unknown/revoked agent | 400/403 | `{ error: "unknown_agent" \| "agent_revoked", … }`             |
| Policy rejection      | 403     | `{ error: "spend_cap_exceeded", requested, remaining, … }`     |
| Rate limited          | 429     | `{ error: "rate_limit_exceeded", retry_after_seconds }`        |
| Not implemented       | 501     | `{ error: "not_implemented", subject, phase }`                 |
| Anything else         | 5xx     | `{ error: "internal_error", message: <fixed>, requestId }`     |

Verified with `NODE_ENV=production` against a live gateway: **38 hostile requests (37
reaching the server), zero 5xx, zero responses matching any leak pattern** — absolute
paths, `node_modules`, `file.ts:line`, `Invalid \`prisma.\``, `PrismaClient`, stack
frames. Final distribution: `400 ×29, 401 ×4, 404 ×2, 414 ×1, 431 ×1`. The 414 and 431
come from Node's own URL and header limits, which refuse an oversized route parameter or
query string before any handler runs; the 38th never left the client, because a null byte
in an `Authorization`header is rejected by`fetch` itself.

Because the fixes removed every route that could produce a 500, the leak test would have
become vacuous — a mutation run confirmed that re-introducing `message: error.message`
broke nothing. The suite therefore registers a route that throws a Prisma-shaped error on
demand, so the 5xx branch is genuinely exercised.

---

## Security headers and CORS

`@fastify/helmet` is registered globally with a JSON-appropriate CSP
(`default-src 'none'`, `frame-ancestors 'none'`), `nosniff`, `no-referrer`, and
`same-site` CORP. CORS is an explicit allowlist from `DASHBOARD_ORIGIN` in every
environment, replacing `origin: true` (reflect-anything) in development.

Verified live: allowed origin echoed, `evil.com` refused, origin-less requests (curl, the
agent, Razorpay webhooks) pass.

One correction worth recording: the default was initially set to `http://localhost:3000`,
which is the **gateway's** port. The dashboard runs on **3002**. That default would have
refused every request the console makes while looking superficially correct — caught by
checking the dashboard's actual dev script rather than assuming the port.

Full policy, including why origin-less requests are allowed, is in
[README.md](README.md#cors-and-security-headers-phase-7).

---

## Gateway-only performance baseline

`npm run loadtest:gateway-only --workspace=gateway` →
[docs/load-profile-gateway-only.md](docs/load-profile-gateway-only.md)

**These numbers are not end-to-end settlement latency and must not be quoted as such.**
The Razorpay API is replaced by an in-process stub. The
[Phase 6 profile](docs/load-profile.md) is the honest end-to-end measurement; it is
dominated by the Razorpay round-trip to the point where the gateway's own cost is
invisible underneath it. That is the entire reason this second measurement exists.

Only the Razorpay **SDK instance** is stubbed — the gateway's own `RazorpayClient` wrapper
still runs, still builds the order body and pins INR. Stubbing our own wrapper would have
measured a system with less of itself in it.

| Concurrency | Requests |  OK | Errors | p50 (ms) | p95 (ms) | p99 (ms) | Accepted/s |
| ----------: | -------: | --: | -----: | -------: | -------: | -------: | ---------: |
|           1 |      200 | 200 |      0 |     10.8 |     18.4 |     22.9 |       83.7 |
|           2 |      200 | 200 |      0 |     13.0 |     16.5 |     25.9 |      147.3 |
|           5 |      200 | 200 |      0 |     23.5 |     28.9 |     42.2 |      208.1 |
|          10 |      200 | 200 |      0 |     43.4 |     60.3 |     71.2 |      220.6 |
|          25 |      200 | 200 |      0 |    110.7 |    144.5 |    163.2 |      222.8 |

1000 requests, zero failures. Against the Phase 6 end-to-end p50 of 106 ms, **the gateway
is roughly 10% of what a payment costs and the Razorpay round-trip is the other 90%** —
treat that as an order of magnitude, not a constant.

Throughput plateaus near 220/s while p50 climbs linearly. That is the expected and correct
shape: every request contends for the **same** agent row, which §3.5's spend cap takes a
`SELECT … FOR UPDATE` on. The queue forming is the guardrail working, measured under real
contention rather than with the contention engineered away.

---

## Accessibility baseline (Phase 7.5)

**A baseline pass over the merchant console, not a claim of WCAG compliance.** It covered
colour contrast, keyboard reachability, and accessible names on the four console screens.
It was not an audit against the full WCAG 2.2 AA success criteria, it involved no testing
with an actual screen reader or with real assistive-technology users, and nothing here
should be read as certifying the application as accessible.

Contrast was **measured, not eyeballed** — every foreground/background pair in the design
system was run through the WCAG relative-luminance formula against the ground it actually
renders on, rather than judged by eye. Two of them failed, and neither was visible as a
problem by inspection.

### Text contrast — `--color-ink-faint`

Failed AA's 4.5:1 for normal text in **both** themes, against the lowest-contrast ground
each one lands on:

| Theme | Before    | Ratio      | After     | Ratio      |
| ----- | --------- | ---------- | --------- | ---------- |
| Light | `#8a8a92` | **3.06:1** | `#6b6b72` | **4.72:1** |
| Dark  | `#6e6e78` | **3.44:1** | `#85858e` | **4.75:1** |

This token is not decoration — it carries table column headers, timestamps, empty-state
hints and the sign-out control. The cost of the fix is a compressed grey ramp: muted and
faint now sit closer together than the original design intended. That is the honest
trade for legibility on a three-tier neutral scale.

### Non-text contrast — control borders

WCAG 1.4.11 requires 3:1 for visual information that identifies a user-interface
component. Control borders were at **1.56:1**, and here the border genuinely is the only
identifier: a text field's background (`--color-surface`) sits on a card
(`--color-raised`) at 1.04:1, so with the border removed there is nothing to see.

Rather than darkening every hairline in the product, interactive controls moved to a new
`--color-control-edge` token — **3.38:1** light, **3.28:1** dark — while dividers and
connector lines stay quiet on `--color-edge-strong`.

### What already passed

Worth recording, because it means the audit found real problems rather than manufacturing
them: the amber accent (4.76–8.37:1 across every ground it sits on, the floor being the
active nav item on its own tint) and every status badge — settled, awaiting, pending,
rejected, failed — already cleared 4.5:1 in both themes and were left unchanged. Status is
also never encoded by colour alone; each badge carries its own glyph and word, so the
distinction survives greyscale and colour-blindness.

The ratios and the reasoning are recorded inline in
[app/globals.css](packages/dashboard/app/globals.css) beside the tokens themselves, so a
future edit to a colour has the constraint in front of it.

### Keyboard navigation — transaction row expansion

The decision trail for a payment request could only be opened by clicking the table row.
The handler lived on `<tr onClick>`, which is not focusable, is not in the tab order, is
not activatable by Enter or Space, and is announced by nothing.

The "Why?" affordance is now a real `<button>` carrying `aria-expanded` and
`aria-controls` pointing at the panel it opens, plus a row-specific accessible name
(`"Why? decision trail for <agent>"`) — because "Why?" repeated down a column gives a
screen-reader user nothing to tell the rows apart. Row click is retained as a mouse
convenience.

Verified functionally rather than structurally: focusing the button and pressing Enter
flipped `aria-expanded` to `true` and rendered the audit trail.

Also added in the same pass: a skip link past the sidebar, `aria-label` on the nav
landmark, `aria-current` on the active link, `scope="col"` and `sr-only` captions on both
tables, `aria-label` on the repeated revoke buttons, and polite live regions for the SSE
feed and the protocol-tester run log.

---

## Explicitly out of scope

Unchanged by this pass, by instruction:

- **Production-scale load testing.** Everything here is one Node process, one local
  Postgres, one local Redis, on a laptop.
- **Multi-region and horizontal scaling.**
- **The §5.4 deferrals** — mTLS between gateway and merchant systems, and multi-region
  webhook redundancy. Documented as deferred; they stay that way.

Not attempted, and worth naming rather than leaving implied:

- No authenticated fuzzing campaign or property-based testing — the probing was
  systematic but hand-built.
- **No full WCAG audit.** The accessibility work above is a baseline over contrast,
  keyboard reachability and accessible names on four screens. Untested: screen readers,
  zoom and reflow to 400%, focus order through the expanded audit trail, and the
  remaining WCAG 2.2 AA criteria. The console is more usable than it was; it is not
  certified.
- Dependency CVE audit is current — `npm audit --workspaces` was re-run in Phase 7.5 and
  reported 0 vulnerabilities. Only in-range patch bumps were taken; the outstanding
  majors are listed in that phase's commit message with the reason each was declined.
- The webhook quarantine bounds repeated _identical_ forgeries, but an attacker varying
  the body can still add rows. Bounding that needs retention/rate-limiting policy on
  `webhook_events`, which is a design decision rather than a fix.

---

## Reproducing

```bash
npm test                                                  # 157 gateway + 12 others
npm run typecheck && npm run lint && npx prettier --check .
npm run loadtest:gateway-only --workspace=gateway         # gateway-only baseline
```

The two Phase 7 suites:

- [test/input-validation.test.ts](packages/gateway/test/input-validation.test.ts) —
  hostile input, error shapes, injection proof
- [test/webhook-event-id-claim.test.ts](packages/gateway/test/webhook-event-id-claim.test.ts) —
  the settlement-suppression regression
