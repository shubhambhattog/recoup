# Recoup — a bounded revenue-recovery agent

**Razorpay AI Buildathon · Track 03 — AI Revenue Recovery**

> Recoup recovers **more** money than naive retries, and it **cannot** misbehave
> with money — every action is bounded, gated, idempotent, and auditable.

Recoup detects revenue at risk (failed payments, failed subscriptions, abandoned
checkouts, overdue B2B invoices), diagnoses the root cause, chooses the right
intervention, and executes a **bounded** recovery workflow on Razorpay test-mode
APIs — then reports **measured money recovered across a batch**, with a full audit
trail, compliant escalation, and stopping rules.

![Recoup dashboard](docs/dashboard.png)

---

## The results (seed 42, 120 synthetic cases — reproducible)

| Metric | Value |
| --- | --- |
| At risk (batch) | **₹39,32,259** |
| Net recovered | **₹19,63,399** (59.2% of cases, 50% of value) |
| vs naive baseline (like-for-like, payments + subs) | **3.4×** — ₹3,50,992 vs ₹1,03,854 |
| Money unlocked beyond baseline (carts + invoices) | **+₹16,13,746** |
| **Double charges** | **0** (agent) vs 1 (baseline) |
| Lost confirmations reconciled → double-charges prevented | **8** |
| Contacts after opt-out · quiet-hours contacts · overspend | **0 · 0 · 0** |
| Audit events (fully replayable) | **807** |

Run it yourself — no keys, no network, deterministic:

```bash
npm install
npm run recover:batch          # prints the scorecard + writes artifacts/
npm run dev                     # dashboard at http://localhost:3000
```

Change the world and watch the guardrails hold:

```bash
SEED=7 N=200 npm run recover:batch
```

---

## Why this is the honest version

Any recovery demo can show one lucky success. The Track 03 bar explicitly rejects
that (*"one cherry-picked match proves nothing"*). So Recoup is built around a
**ground-truth simulator** the agent never sees: every case has a hidden persona
that decides whether the customer will actually pay, when, and what it takes. A
wrong diagnosis or a mistimed retry genuinely fails. The recovered-money number is
therefore *earned*, and it's measured against a **naive baseline** (retry 3×
immediately, no diagnosis) on the identical batch and world.

Two honesty choices worth calling out:

- **Like-for-like comparison.** The naive baseline can only retry payments, so
  comparing totals would flatter Recoup (it also recovers carts and invoices the
  baseline ignores). We report the **payments-and-subscriptions-only** comparison
  (3.4×) *and* the extra money unlocked separately (+₹16.1L), instead of a
  headline-grabbing "1790%".
- **An exception list, not just wins.** Every case Recoup can't resolve is
  reported with its reason (disputed invoice → escalated, dead card + unreachable
  customer → stopped, genuinely unrecoverable → stopped).

---

## The recovery loop

```
  DETECT ─▶ DIAGNOSE ─▶ DECIDE ─▶ [GATE] ─▶ ACT ─▶ OBSERVE ─┐
    ▲                                                        │
    └──────────────── loop until recovered ─────────────────┘
                       or a STOPPING RULE fires
                  (recovered · escalated · max attempts
                   · past deadline · opted out)
```

- **Detect** — ingest at-risk events (`payment_failed`, `subscription_failed`,
  `checkout_abandoned`, `invoice_overdue`).
- **Diagnose** — structured Razorpay error codes → root cause by deterministic
  rules; free-text (carts, invoices) → LLM (Gemini) or an offline heuristic.
- **Decide** — a deterministic policy ladder per root cause, with smart timing.
- **Gate** — every action passes the guardrails before it can touch money.
- **Act** — retry a charge or send a Razorpay Payment Link, **idempotently**.
- **Observe** — recovered, or reconcile an unknown outcome, or move to the next rung.

## AI judgment: the right tool, and where we chose *not* to use one

The LLM is deliberately kept **out of the money-authorization path**. It does exactly
two things, both language/ambiguity tasks:

1. **Classify** the root cause of behavioural, text-only cases (an abandoned cart, a
   disputed invoice) — never a case whose Razorpay error code already answers it.
2. **Compose** the customer message (Hinglish where the customer's locale is `hi-IN`).

Every decision that moves or spends money — whether to retry, when, how much
incentive, escalate vs stop — is **deterministic policy + guardrails**. That's the
"the right tool in the right place, and where you chose not to use one" the rubric
asks for. It also means the headline metrics are reproducible and free: the batch
runs fully offline; the LLM is an enhancement, not a dependency.

The LLM layer is **provider-agnostic** (defaults to Gemini, one env var to switch):

```bash
# .env.local
GEMINI_API_KEY=...           # get one at https://aistudio.google.com/apikey
# LLM=1                       # turn the LLM on inside the batch
# LLM_MODEL=openai/gpt-4o + AI_GATEWAY_API_KEY   # or any provider via the gateway
npm run llm:smoke            # verify your key
```

## Bounded & gated: why it can't misbehave with money

The guardrail layer is the last thing between a plan and a money action. Even if
diagnosis or policy proposed something unsafe, nothing reaches money without passing:

- **Idempotency** — every charge / Payment Link carries an idempotency key
  (`reference_id`), so money can move at most once per key.
- **Reconciliation before re-charge** — if a charge's confirmation is *lost*
  (reported `unknown`), Recoup checks the true status first and skips the re-charge
  if the money already moved. **This is the on-camera failure handled gracefully.**
- **Caps & cooldowns** — max money attempts, max contacts, per-customer daily cap,
  cooldown between retries.
- **Quiet hours & opt-out** — no contact 9pm–9am local; an opt-out halts all
  contact and charges, forever.
- **Spend caps** — per-case and batch-wide incentive budget.
- **Human-in-the-loop** — money actions on high-value cases require approval.

All of it lands in an **append-only ledger** — every decision and money action, with
its reasoning, replayable end to end (`artifacts/ledger.jsonl`).

## Razorpay test-mode integration

The loop runs behind an `Executor` interface, so the same decision engine drives
either the simulator (for measured metrics) or **real Razorpay test-mode APIs**:

```bash
# .env.local  → RAZORPAY_KEY_ID=rzp_test_…  RAZORPAY_KEY_SECRET=…
npm run razorpay:demo        # creates a real test link, proves idempotency, reconciles
```

`src/lib/razorpay/client.ts` creates real Payment Links (idempotent via
`reference_id`) and reconciles by fetching live status. In the dashboard, select any
case and click **"Create real Razorpay recovery link"** to mint a real test-mode link
and reconcile it live. Without keys, everything degrades gracefully to a friendly
prompt — the simulated batch is fully self-contained.

## Project structure

```
src/
  lib/
    core/        rng (seeded), money (paise), time (virtual clock), env
    domain/      types, policy config (all the bounds in one place)
    ledger/      append-only audit ledger
    engine/      diagnose · policy · guardrails · loop · executor · baseline · run
    sim/         world (hidden ground truth + chaos) · generate (synthetic batch)
    ai/          provider-agnostic LLM (Gemini default) + the narrow Llm interface
    razorpay/    test-mode client wrapper
    metrics/     report + baseline scorecard
  app/           dashboard (page) + /api/run + /api/razorpay/link
  scripts/       run-batch · llm-smoke · razorpay-demo
```

## Reproducibility

Every run is seeded — no `Math.random`, no wall-clock in the engine. Same seed →
identical money numbers, so a reviewer can clone and verify. The batch runs on a
**virtual clock**, so ten days of retry scheduling resolve instantly and identically.

## What broke, and how I got out

See [`FAILURE_STORY.md`](FAILURE_STORY.md) — a real infinite-deferral scheduling bug,
a "metrics that looked too good" credibility fix, and the money-critical
double-charge failure the system is designed to survive.

## Tech stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Vercel AI SDK (Gemini via
`@ai-sdk/google`, provider-agnostic) · Razorpay Node SDK (test mode) · zero-runtime
data engine (no DB required; append-only JSONL ledger).

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the deep dive.
