# Architecture

Recoup is a closed-loop revenue-recovery agent with a hard separation between
*judgment* (deterministic, auditable) and *language* (the LLM). This document
explains how the pieces fit and why they're shaped this way.

## Design principles

1. **The agent never sees ground truth.** Whether a customer will actually pay —
   and what it takes — lives only in the simulator (`src/lib/sim/world.ts`) and is
   never importable by the decision code. The agent must infer everything from the
   failure signal. This is what makes the recovered-money number honest.
2. **The LLM is never in the money-authorization path.** It classifies ambiguous
   text and writes messages. Nothing it returns decides, times, or authorizes a
   charge. See `src/lib/ai/types.ts` — there is deliberately no `decideAction`.
3. **Bounded by construction, not by luck.** The guardrail gate
   (`src/lib/engine/guardrails.ts`) is the only path to a money action, so the
   safety invariants (0 double-charges, 0 post-opt-out contacts, 0 overspend) hold
   structurally.
4. **Deterministic and reproducible.** No `Math.random`, no wall-clock in the
   engine. A seeded PRNG (`src/lib/core/rng.ts`) and a virtual clock
   (`src/lib/core/time.ts`) mean identical runs → identical money.

## Module map

| Module | Responsibility |
| --- | --- |
| `core/rng` | Seeded mulberry32 PRNG — reproducibility as a correctness property |
| `core/money` | Integer-paise money + INR formatting (never floats) |
| `core/time` | Virtual clock: quiet-hours, day index, next-allowed-contact |
| `domain/types` | The whole domain model (cases, signals, interventions) |
| `domain/config` | Every bound in one place — the "bounded & gated" contract |
| `ledger/ledger` | Append-only audit log; `toJSONL()` is the replayable trail |
| `engine/diagnose` | Root cause: deterministic rules → LLM/heuristic fallback |
| `engine/policy` | The decision ladder per root cause + smart scheduling |
| `engine/guardrails` | The gate: caps, cooldowns, quiet hours, opt-out, budget, approval |
| `engine/loop` | Event-driven orchestrator over virtual time |
| `engine/executor` | The Sim executor (idempotent retries, chaos handling) |
| `engine/razorpay-executor` | The real executor (Razorpay test-mode Payment Links) |
| `engine/baseline` | The naive "retry 3× now" comparison |
| `engine/run` | `runScenario` — the shared entry point (CLI + sweep + tests + web) |
| `sim/world` | Hidden ground truth + chaos + idempotency store |
| `sim/generate` | Seeded synthetic batch consistent with each hidden persona, plus the hidden true root cause used only for scoring |
| `metrics/report` | The scorecard + baseline summary + AI cost/ROI + payments segment |
| `metrics/diagnosis` | Grades root-cause calls against hidden truth, split by path |
| `ai/*` | Provider-agnostic LLM (Gemini default) behind the narrow `Llm` interface |
| `razorpay/client` | Typed wrapper: create link (idempotent), reconcile |
| `engine/razorpay-executor` | The real executor — same interface, real test-mode links |
| `tests/*` | Guardrail fuzz suite + engine tests (`node:test` via tsx) |

## Evidence pipeline

The claims are only worth the machinery that checks them, so four independent
things verify different parts:

| Command | What it establishes |
| --- | --- |
| `npm run recover:batch` | One batch end to end + the full audit ledger |
| `npm run sweep` | 50 seeds (6,000 cases) + a chaos sensitivity grid; **exits non-zero if any run double-charges** |
| `npm test` | Invariants hold under *randomized policies* (attempt caps, cooldowns, budgets, thresholds) — safety isn't a property of our chosen numbers |
| `npm run eval:diagnosis` | Diagnosis accuracy vs hidden truth, per classifier path |

CI runs all four on every push (`.github/workflows/ci.yml`), so a regression that
quietly breaks a safety property fails the build rather than shipping.

## The loop (`engine/loop.ts`)

An event-driven simulation over virtual time with a small priority queue. Two
event kinds:

- **process** — run one step of the pipeline for a case.
- **inbound** — a customer pays a link at its (simulated) settlement time.

Processing a case:

1. **Diagnose** once (rules → LLM/heuristic), recorded to the ledger.
2. **Plan** the next intervention. If its scheduled time is in the future, the case
   is re-queued as a `process` event at that time and parked as `waiting`.
3. **Gate** the intervention. A block is either a **deferral** (quiet hours, daily
   cap → reschedule) or a **hard stop** (opt-out, deadline, caps → fallback to
   escalate/stop).
4. **Execute** via the `Executor`, then react to the outcome.

The safety-critical branch is `charge_unknown`:

```
retry → charge outcome UNKNOWN (lost confirmation)
      → reconcile(idempotencyKey)          // ask the source of truth
      → if "success": recover, DO NOT re-charge   (double-charge prevented)
        else:          safe to try the next rung
```

### Scheduling anchors (a subtle but load-bearing detail)

`plan()` schedules relative to **stable anchors** — the last attempt time, the last
contact time, or `createdAt` — never `now`. If it scheduled from `now`, re-planning
a case at its scheduled time would compute a fresh future time and defer forever.
Anchoring makes the scheduled action resolve to `<= now` when its time arrives, so
it executes exactly once. (This was a real bug — see `FAILURE_STORY.md`.)

## Diagnosis (`engine/diagnose.ts`)

- **Rules first.** Structured Razorpay fields (`code`, `reason`, `source`, `step`)
  map deterministically to a root cause with high confidence. `card_expired`,
  `risk_declined`, `insufficient_funds`, `bank_downtime`, `mandate_inactive`, etc.
  are answered here — no LLM, because the answer is in the error object.
- **LLM/heuristic only for the behavioural cases.** Abandoned carts and overdue
  invoices carry no error code, only free text. Those route to the LLM (Gemini) —
  or, with no key, an offline keyword heuristic so the batch still runs and stays
  reproducible.

## Policy ladders (`engine/policy.ts`)

Each root cause has an ordered ladder of interventions, indexed by what's already
been tried. Highlights that create the gap over the baseline:

- `insufficient_funds` → retry at +1d, +3d **mid-morning** (funds likely present),
  then a method-switch link, then stop.
- `card_expired` / `mandate_inactive` → **no retry** (same instrument always fails)
  → method-switch link → nudge → stop.
- `risk_declined` → **escalate immediately, never auto-retry.**
- `b2b_dispute` → **escalate, don't chase money.**
- `buyer_price_sensitive` → nudge, then a **capped** incentive link.
- `b2b_cashflow` → capture a promise-to-pay, remind near the date, then escalate.

## Guardrails (`engine/guardrails.ts`) — checks, in order

1. opt-out → hard stop
2. past deadline → stop
3. money action: max attempts, cooldown
4. contact action: max contacts, quiet hours (defer), per-customer daily cap (defer)
5. incentive: per-case cap, batch budget
6. high-value: human approval

Note the distinction between a **deferral** and a **stop**: quiet hours and the
daily contact cap reschedule the same action to the next legal moment, while
opt-out, the deadline and the attempt caps end the case. That distinction is why
compliance costs recovery *time* rather than silently dropping cases.

### The human gate is real, not mocked

With `humanGate: "manual"`, a money action on a case at or above the approval
threshold does not execute — the case parks as `awaiting_human` and appears in the
dashboard's Approvals queue. Approving replays the batch with those case ids in
`approvedCaseIds`, and only those actions proceed. Because the whole run is
deterministic, "approve and re-run" is an exact replay with one input changed —
which is also how the approval decision itself stays auditable.

## The simulator (`sim/world.ts`)

Each case has a hidden `Persona` (`funds_on_date`, `transient`, `needs_new_method`,
`price_sensitive`, `distracted_reachable`, `b2b_will_pay`, `b2b_dispute`, `dead`).
The world:

- decides whether a charge truly succeeds (persona + method + time),
- keeps an **idempotency store** keyed by idempotency key — money moves once per key,
- detects a **double-charge** (a second successful capture on a case via a *different*
  key, i.e. a re-charge without reconciliation),
- injects two chaos sources: **lost confirmations** (a true success reported as
  `unknown`) and **transient API errors** (a throw before any state change),
- models **annoyance**: opt-out probability rises with contacts and spikes in quiet
  hours, so spamming is genuinely punished in the metrics.

## The Executor seam

```
            ┌─────────────────────┐
   loop ───▶│  Executor interface │
            └─────────────────────┘
               ▲               ▲
     SimExecutor           RazorpayExecutor
   (measured metrics)   (real test-mode Payment Links)
```

The identical decision engine runs either way. Metrics come from the SimExecutor;
the RazorpayExecutor proves the same actions work against real Razorpay test-mode
APIs (idempotent via `reference_id`, reconciled via live status fetch).

## Metrics (`metrics/report.ts`)

`computeReport` produces recovered count, gross/net recovered, recovery by root
cause and by loss type, an exception list, and the safety counters.
`computeBaseline` runs the naive agent on the same batch/world. The dashboard and
CLI both render the **like-for-like** comparison (payments + subs only) alongside
the money unlocked beyond it.
