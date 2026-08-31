# Demo video script — 5 minutes

Target: 5:00. Timings are cumulative. Everything below has been run live; nothing here
is aspirational.

**Before you hit record**, see [Pre-flight](#pre-flight) at the bottom — particularly the
Nemotron flakiness hedge, which has bitten twice during verification.

---

## 0:00 – 0:30 · The problem

> Four different groups are defining agentic commerce at the same time. Google has AP2.
> Coinbase has x402. OpenAI has ACP. NPCI has UAP. No merchant is going to build four
> integrations, and nobody knows which one wins.
>
> Right now a Razorpay merchant has exactly one way to accept an agent's money: treat it
> like a human's and hope the agent can finish a normal checkout. That breaks the moment
> the agent has to prove _who it's acting for_, _how much it's allowed to spend_, and
> _why this purchase happened_ — which is the entire problem every one of those protocols
> exists to solve.
>
> AgentGateway sits in front of Razorpay's existing rails and normalizes intent. Protocols
> will keep changing. Settlement shouldn't have to.

_On screen:_ the §2.1 architecture diagram from the README.

---

## 0:30 – 1:00 · The rule the whole system is built on

Say this one on camera, unhurried. It is the thing worth remembering.

> The protocol layer proposes, but Razorpay's webhook confirms.
>
> An x402 payment proof, an AP2 mandate signature, an optimistic client response — those
> are all _claims_. They're enough to authorize an attempt. None of them is allowed to
> declare that money moved. Only a signature-verified Razorpay webhook can do that.
>
> That single rule is why the guardrails in this system are enforceable instead of
> aspirational.

_On screen:_ the console's Transactions page, showing rows sitting at **Awaiting** — a
good moment to point out that `settle()` cannot write `settled`; only the webhook can.

---

## 1:00 – 2:30 · Both protocols, one settlement

_On screen:_ Protocol tester.

> Same cart, same merchant, two completely different protocols.
>
> On the left, x402: the gateway answers with HTTP 402 and a payment envelope, the agent
> comes back with a proof bound to that one-time reference, and it settles.
>
> On the right, AP2: the agent signs an IntentMandate with its Ed25519 key, the gateway
> recomputes the canonical form and verifies the signature, and it settles.
>
> Different validation, different proofs, different shapes on the wire.

Click **Run live x402**. Let the four stages light up.

> And underneath, both land in the same `razorpay_orders` row shape. Same amount, same
> currency, same status, same merchant. The only differences are the order id Razorpay
> assigned and which protocol identity was used.
>
> That equivalence is the entire point of the project.

_Optional, if the terminal is on screen:_ show the field-by-field diff from the Phase 4
verification.

---

## 2:30 – 3:40 · A real failure, handled gracefully

**Recommended scenario: the spend-cap breach.** It demos more clearly than the tampered
webhook — the failure has a human-legible cause and a visible number attached, where a bad
HMAC is just a hex string that doesn't match.

_On screen:_ Agents page, then Transactions.

> This agent has a spending limit. Watch what happens when it asks for more than it has
> left.

Run the breach (`chaos.ts` scenario 2, or a single over-limit mandate).

> Declined. And notice what the gateway did _not_ do: no Razorpay order was created. The
> refusal happened entirely inside our own boundary, before any money-adjacent call.
>
> It also isn't a generic 500. It's a typed, machine-readable error the agent can act on:
> what it asked for, what was left, and the id of the request.

_On screen:_ the 403 body with `spend_cap_exceeded`, `requested`, `remaining`.

---

## 3:40 – 4:30 · The audit trail for that exact failure

_On screen:_ Transactions → click the rejected row → **Why?**

> Here's the decision trail for that specific rejection. Not a log file — this is the
> merchant's console.

Read the explanation off the screen verbatim:

> _"Declined: the agent asked to spend ₹250.00 but only ₹10.00 was left on its spending
> limit. No payment was created and no money moved."_

> A non-technical person can read that. And for whoever wants the actual payload —

Click **View raw**.

> — it's one click away. Plain language first, JSON underneath. Both audiences served, in
> the same view.

---

## 4:30 – 5:00 · Close

> Everything shown is running against Razorpay test mode with real orders and real
> webhook signatures.
>
> What's deliberately _not_ here: UAP, because there's no stable public spec to build
> against yet — and the adapter pattern means it's one new class, not a rewrite. x402
> reinterprets HTTP 402 onto INR rails rather than pretending to do on-chain settlement.
> Both are written down in the README rather than glossed over.
>
> Protocols will keep changing. Settlement shouldn't have to.

---

## Pre-flight

Run these in order before recording.

```bash
docker compose up -d --build                                  # note: --build, not --force-recreate
npm run db:migrate --workspace=gateway
npm run merchant:create --workspace=gateway -- --name "Demo Merchant"   # copy the agk_ key
npm run dev --workspace=gateway
npm run dev:dashboard
npm run setup --workspace=agent-client -- --api-key <agk_...>
npm run agent --workspace=agent-client -- --protocol=x402
npm run agent --workspace=agent-client -- --protocol=ap2
```

Then open the console, paste the key, and confirm Transactions shows rows before you
start recording.

### The Nemotron hedge — read this

The agent's reasoning layer runs on NVIDIA Nemotron 3 Ultra via OpenRouter's free tier.
**It returned an upstream 502 twice during verification**, delivered as an HTTP 200 with
no `choices` array. The fallback handles it — the run drops to the deterministic picker
and completes — but on camera you'd be narrating a fallback instead of a purchase.

Recommendation:

- **Demo x402 live.** It touches no LLM and no signing key; it is the reliable live moment.
- **Pre-record the AP2 run**, or run it with `--deterministic`. The reasoning layer is not
  what the video is about — the protocol translation is — and a 502 mid-take costs you the
  segment.
- If you _do_ want Nemotron on camera, do a throwaway run 60 seconds beforehand. If that
  one 502s, use `--deterministic` for the take and say so; the fallback is a designed
  feature and admitting it costs nothing.

### Other footguns

- **Port 3000.** Another app on this machine claims it. Check `lsof -ti:3000` before
  starting, or run the gateway on another port with `PORT=…` and point the dashboard at it
  via `NEXT_PUBLIC_GATEWAY_URL`.
- **Theme.** Pick light or dark before recording and stay there — toggling mid-take is
  distracting.
- **The live x402 button** creates a real test-mode Razorpay order every click. Harmless,
  but don't lean on it during rehearsal and then act surprised at the row count.
