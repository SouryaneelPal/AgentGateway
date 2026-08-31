# AgentGateway — Full-Stack Phased Implementation Roadmap

This is the execution companion to [WHITEPAPER.md](WHITEPAPER.md), which remains the
source of record for the system's architecture, protocol analysis, database schema, and
security design. Everything below is Section 4 of that document, extracted verbatim so
the build sequence can be tracked independently of the design narrative around it.
Section references (§2.2, §3.4, §3.5, §5.3) point back into WHITEPAPER.md.

---

### Phase 1 — Foundation & Infrastructure Setup
**Stack:** Fastify + TypeScript, Docker Compose (Postgres + Redis), Razorpay Node SDK (test-mode keys).
**Deliverables:**
- Repo scaffold with strict TS config, ESLint/Prettier, `docker-compose.yml` bringing up Postgres + Redis + the app in one command.
- Environment config module (`.env.example` committed, secrets never committed).
- `/health` endpoint checking DB and Redis connectivity.
- Razorpay test-mode keys wired in; a manual script that creates one test Order and confirms the SDK round-trips correctly.
**Validation checklist:** `docker-compose up` succeeds from a clean clone; `/health` returns 200; a test Order appears in the Razorpay test-mode dashboard.

### Phase 2 — Database Layer, Policy Engine & Razorpay Core
**Stack:** Prisma (or Knex) migrations matching §2.3 DDL exactly; a `RazorpayClient` wrapper module.
**Deliverables:**
- Migrations for all eight tables, with indexes and constraints as specified.
- `PolicyEngine.checkSpendCap()` implementing the row-locked transactional check from §3.5, with unit tests covering the concurrent-request race explicitly (spin up two simultaneous calls in a test and assert only one succeeds).
- `RazorpayClient.createOrder()`, `.createPaymentLink()`, `.capturePayment()` wrapping the real Orders/Payment Links APIs against test-mode credentials.
- Webhook listener with raw-body capture + HMAC verification (§3.4), storing every event in `webhook_events` regardless of validity (invalid ones logged and rejected, not silently dropped).
**Validation checklist:** a concurrency test proves the spend-cap check cannot be raced; a manually-triggered Razorpay test webhook is received, verified, and persisted correctly; a deliberately tampered signature is rejected and logged.

### Phase 3 — Protocol Adapters & Cryptographic Engine
**Stack:** the `ProtocolAdapter` interface from §2.2; `tweetnacl` (or `@noble/ed25519`) for signature verification; a JSON canonicalization utility.
**Deliverables:**
- `x402Adapter` — issues the `402` challenge, validates retried requests against the original reference, enforces one-time redemption.
- `ap2Adapter` — canonicalizes and verifies `IntentMandate` signatures, enforces nonce uniqueness (Redis + DB), maps to `NormalizedPaymentRequest`.
- `fallbackAdapter` — Payment Link generation + human-confirmation webhook path.
- Protocol router that inspects incoming request shape/headers and dispatches to the correct adapter, defaulting to `fallbackAdapter` for anything unrecognized.
**Validation checklist:** a tampered AP2 signature is rejected pre-database; a replayed nonce is rejected by Redis on the fast path and, in a forced-Redis-outage test, by the Postgres unique constraint as a fallback; an x402 flow completes end-to-end against test-mode settlement.

### Phase 4 — Reference AI Agent Client
**Stack:** Node.js/TypeScript CLI script whose reasoning layer is built against NVIDIA Nemotron 3 Ultra (550B-A55B MoE, free tier via OpenRouter's OpenAI-compatible endpoint), chosen for zero-cost iteration during prototyping. The reasoning layer sits behind a provider-agnostic interface (`CartPicker`, in `packages/agent-client/src/picker.ts`, implemented by both `LlmToolAgent` and the offline `DeterministicPicker`) — the Anthropic API remains a documented, deferred alternative, swappable in a single file, not a redesign.
**Deliverables:**
- A CLI agent that can be invoked in two modes: `--protocol=x402` and `--protocol=ap2`, both attempting to purchase the same test cart against the local gateway.
- The agent generates its own Ed25519 keypair for the AP2 run and registers its public key via a setup script (simulating merchant-side agent onboarding).
- Full request/response trace logged to a JSON file — this becomes the raw material for the protocol-tester panel in Phase 5 and for the demo video.
**Validation checklist:** both protocol runs, against the identical cart and identical merchant, terminate in the same `razorpay_orders` row shape underneath — the point of the entire project, made visible.

**Why the model choice is an architecture decision, not a downgrade:** the reasoning layer is deliberately LLM-agnostic. The interesting engineering surface in this project is the protocol-adapter and settlement logic the agent *drives* — mandate canonicalization and Ed25519 verification (§3.1), the two-layer replay guard (§3.2), the row-locked spend cap (§3.5), and the trust boundary that lets only a signature-verified webhook declare money moved (§1.3). None of that changes with the model behind the agent's purchasing decisions; the agent is a *client* of that surface, not part of it. Pinning the prototype to a free-tier endpoint keeps iteration unmetered while that surface is built out, and the provider seam means moving to the Anthropic API — or any other OpenAI-compatible endpoint — is a one-file change rather than a redesign. A reasoning layer that can only run against one vendor would be a worse design regardless of which vendor it was.

### Phase 4.5 — Merchant Authentication & Tenant Isolation
**Stack:** Fastify `preHandler` hooks, `@fastify/rate-limit`, AES-256-GCM via `node:crypto`.
**Deliverables:**
- `merchant_api_keys` table storing SHA-256 hashes (never the key), with per-key revocation, a non-secret prefix for identification, and `last_used_at`.
- A scope-wide authentication hook on every `/v1/merchant/*` route, `POST /v1/merchant/agents/register` included — not a special case.
- Cross-tenant IDOR closed: the merchant is derived from the authenticated key server-side, and no merchant route accepts `merchantId` from the request body.
- Merchant bootstrapping moved out of HTTP entirely, into an operator script.
- `merchants.razorpay_key_secret_encrypted` genuinely encrypted at rest (AES-256-GCM, versioned envelope) rather than merely named as though it were.
- Rate limiting keyed per merchant API key on `/v1/merchant/*` and per agent identity on the payment-facing routes, configurable by environment variable, with `/webhooks/*` exempt.
**Validation checklist:** an unauthenticated request to any merchant route — `agents/register` included — is rejected 401; a valid key succeeds and a wrong or revoked one fails; a valid key for merchant A cannot act on merchant B even when B's id is supplied; a burst returns 429; the Phase 4 reference agent's full setup → onboard → purchase flow still completes over both protocols.

### Phase 5 — Merchant Dashboard & Interactive Protocol Tester
**Stack:** Next.js 14+ (App Router), TypeScript, Tailwind CSS, SSE for live updates.
**Deliverables:**
- Policy console: spend caps, blocked categories, enabled protocols per merchant — writes to `/v1/merchant/policy`.
- Live transaction/audit feed via SSE, showing protocol origin, status, and a link into the full audit trail for each request.
- Protocol tester panel: paste or trigger a raw x402/AP2 request from the browser and watch the adapter's validate → normalize → settle → receipt steps rendered side by side in real time — this is the single most demo-able screen in the whole project.
- Agent management view with a one-click revoke button (`POST /v1/merchant/agents/:id/revoke`), and proof that a revoked agent's next request is rejected immediately.
**Validation checklist:** revoking an agent mid-session blocks its next request; the audit trail for a rejected mandate is fully readable by a non-technical viewer without needing to read logs.

### Phase 6 — End-to-End Integration, Chaos Testing & Submission Prep
**Deliverables:**
- **Chaos scenarios**, each scripted and recorded: (1) replay a captured AP2 mandate — must be rejected; (2) fire 20 concurrent spend-cap-adjacent requests from the same agent — exactly the correct number succeed, verified against the cap; (3) deliver a webhook with a tampered signature — rejected and logged, no state change; (4) deliver the *same* legitimate webhook twice — processed once.
- Basic load/latency profiling on the protocol translation path (a simple script hitting `/v1/ap2/mandates` at increasing concurrency, reporting p50/p95 latency) — not because the buildathon needs production-scale numbers, but because *measuring* rather than *assuming* performance is itself a signal worth showing.
- README with the architecture diagram, setup instructions, and an explicit "known limitations" section (see §5.3) — the buildathon brief rewards intellectual honesty over overclaiming.
- 5-minute demo video script: (1) the problem in 30 seconds, (2) the trust-boundary rule stated on camera, (3) both protocol flows completing live, (4) the spend-cap breach failure handled gracefully on camera, (5) the audit trail for that exact failure shown in the dashboard.
**Validation checklist:** every chaos scenario has a corresponding, visible entry in the audit trail; the video shows one real failure end-to-end, not just a success path.
