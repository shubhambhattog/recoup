# The simulator: what is real, what is assumed, and why you should still believe the numbers

Recoup's headline result — *₹19L recovered, 6.4× a naive retry baseline, zero
double-charges* — is produced against a simulator we wrote. That is a fair thing
for a reviewer to be suspicious of, so this document states every assumption
plainly, separates the parts grounded in external rules from the parts we chose,
and shows what we did to stop the conclusions depending on those choices.

**The short version:** the *safety* results are structural and would hold under
any assumptions. The *money* results depend on assumptions, so we report them as
a distribution across 50 independent worlds plus a sensitivity sweep, not as a
single number.

---

## 1. What the agent is never allowed to see

The design rule the whole thing rests on: **the agent has no access to ground
truth.** `src/lib/sim/world.ts` holds a hidden `Persona` per case (will this
customer pay? when? what does it take?) and the hidden true root cause. Nothing
in `src/lib/engine/*` imports either. The agent sees only what a real system
would: the Razorpay-shaped failure signal, its own attempt history, and policy.

That asymmetry is what makes the number earned rather than staged. A wrong
diagnosis genuinely fails; a mistimed retry genuinely fails. Our own diagnosis
scoring proves the agent is *not* omniscient: it gets **88.3%** of root causes
right on seed 42 (100% on structured error codes, **72% on the text-only
cases**) — see `npm run eval:diagnosis`.

## 2. Grounded in external rules (not our invention)

| Bound | Value | Source |
| --- | --- | --- |
| No customer contact outside 08:00–19:00 local | `quietHours: 19 → 8` | RBI, *Outsourcing of Financial Services — Responsibilities of REs employing Recovery Agents* (12 Aug 2022), which directs REs and their agents not to contact borrowers outside 8am–7pm. |
| Cap re-attempts on a declined authorization | `maxMoneyAttemptsPerCase: 3` | Card networks limit authorization re-attempts and levy fees for excessive retries (Visa/Mastercard authorization-reattempt rules). We stay well inside any published limit, and never retry a *hard* decline at all. |
| Never re-charge without confirming prior state | reconciliation before retry | Standard payments practice: an unknown outcome is not a failed outcome. This is the single most important rule in the system. |
| Money as integer minor units | paise everywhere | Razorpay API convention (`amount` in paise). |

These are the bounds a reviewer should check hardest, because getting them wrong
is a compliance problem, not a scoring problem.

## 3. What we assumed (and the honest label: these are assumptions)

None of the following are measured from production data. We had no access to
real merchant recovery data, so we chose plausible values and then tested whether
the conclusions survive changing them (§5).

**Case mix** (`src/lib/sim/generate.ts`, weights per archetype)

| Loss type | Share of batch | Notes |
| --- | --- | --- |
| Failed payments | ~44% | split across insufficient funds, bank downtime, gateway errors, expired cards, risk declines, auth failures, limits |
| Failed subscriptions / mandates | ~14% | funds + revoked mandates |
| Abandoned checkouts | ~21% | price-sensitive, distracted, and genuinely-no-intent |
| Overdue B2B invoices | ~12% | cashflow delay, disputed, likely bad debt |

**Amounts.** Consumer payments ₹200–₹5,000, with 12% large-ticket ₹30k–₹90k so
the human-approval gate is genuinely exercised. B2B invoices ₹15k–₹3L. B2B being
larger is why B2B dominates the recovered-rupee total — see the caveat in §6.

**Customer behaviour** (the biggest assumptions, all in `world.ts`)

| Assumption | Value | Reasoning |
| --- | --- | --- |
| Funds-constrained customers pay once funds arrive | 12–96h later (15% much later) | models salary/credit cycles |
| Transient failures clear | 0–8h | bank downtime / gateway blips are short |
| Method-switch link converts a reachable dead-instrument customer | 50–80% | a link is a strong instrument; unreachable customers (25–30%) never convert |
| A capped incentive converts a price-sensitive abandoner | 55–80%, only if incentive ≥ their hidden threshold | a discount below their threshold mostly fails |
| A plain reminder converts a distracted abandoner | 50–75% | |
| A promise-to-pay converts a cashflow-delayed B2B buyer | 60–85%, paying near the promised date | |
| Opt-out probability per message | 4% base, rising 60% per prior contact, ×2.5 inside quiet hours | **this punishes over-contacting** — spam is not free in our world |
| Genuinely unrecoverable cases | risk declines, window-shoppers, bad debt | no intervention works; the correct behaviour is to stop or escalate |

**Costs.** ₹0.35 per outbound message; incentive = 5% of amount capped at ₹500
per case and ₹20,000 across the batch; ₹0.02 per LLM diagnosis call. All are
subtracted from gross before we report net.

**Chaos** (default): 14% of successful charges report an *unknown* outcome (lost
confirmation), 10% of money calls throw a transient API error. These are
deliberately high — a stress setting, not a claim about Razorpay's reliability.

## 4. What the baseline is, and why it is a fair comparison

The baseline (`src/lib/engine/baseline.ts`) is "retry the failed charge 3×,
roughly hourly, no diagnosis, no reconciliation" — the naive dunning behaviour
Recoup is arguing against. It is deliberately dumb, so we do **not** compare
totals:

- The baseline cannot touch abandoned carts or overdue invoices at all, so we
  report the **like-for-like** comparison on payments + subscriptions only
  (**3.4×** on seed 42; **6.38× pooled** across 6,000 cases), and report money
  unlocked beyond the baseline's reach *separately*.
- Both run on the **same generated cases and the same world config**, so the gap
  is attributable to decision quality, not luck.

An earlier version of this README quoted a "1790% uplift" by comparing totals.
That number was true and misleading; it is gone. See `FAILURE_STORY.md`.

## 5. How we de-risk the assumptions

**Multi-seed.** `npm run sweep` runs 50 independent seeds (each a fresh batch
*and* a fresh world) = 6,000 cases, and reports mean ± SD and range:

| Metric (50 seeds × 120 cases) | Result |
| --- | --- |
| Recovery rate | 61.9% ± 4.2% (51.7% – 70.0%) |
| Diagnosis accuracy | 92.3% ± 2.2% |
| Pooled uplift vs baseline (like-for-like) | **6.38×** (median per-seed 7.83×) |
| Runs where the baseline beat us | **0 of 50** |
| **Double charges** | **0 across all 6,000 cases** (baseline: 48) |
| Contacts after opt-out / quiet-hours contacts | **0 / 0** |

**Sensitivity.** The same script sweeps the chaos parameters from zero to
extreme. The conclusions do not move:

| lost-confirm | api-error | recovery rate | uplift | reconciliations | double charges |
| --- | --- | --- | --- | --- | --- |
| 0% | 0% | 62.7% | 8.02× | 0.0 | **0** |
| 5% | 5% | 62.2% | 8.24× | 2.7 | **0** |
| 14% | 10% | 63.6% | 8.38× | 7.7 | **0** |
| 30% | 25% | 63.8% | 10.86× | 14.8 | **0** |
| 50% | 40% | 63.6% | 12.98× | 24.8 | **0** |

Two things worth reading off that table: double-charges stay at zero as the world
gets four times more hostile, and the *reconciliation* count rises exactly in
step with the lost-confirmation rate — the safety machinery is doing more work,
and holding.

**Randomised policies.** `npm test` fuzzes the policy itself (random attempt
caps, contact caps, cooldowns, budgets, thresholds) across seeds and asserts the
invariants hold in every run. Safety does not depend on our chosen policy values.

## 6. What we are *not* claiming

- **Not** that these conversion rates match any real merchant's. They are
  assumptions; a real deployment would fit them from historical data.
- **Not** that 61.9% recovery would transfer to production. The transferable
  claims are the *relative* one (diagnosis-driven beats blind retries) and the
  *structural* one (the guardrails hold).
- **Not** that B2B invoices are as easy in reality as here. B2B is ~80% of the
  recovered *rupees* because those invoices are 10–100× larger, and our
  promise-to-pay conversion (60–85%) is optimistic for real receivables. This is
  why the dashboard and CLI lead with the payments-only like-for-like figure, and
  why `report.paymentsSegment` is a first-class metric.
- **Not** that the LLM is required. The headline numbers run with the
  deterministic offline heuristic and no API key; the LLM is measured separately
  (`npm run eval:diagnosis`).

## 7. Reproduce or falsify it

```bash
npm run recover:batch     # one batch, full scorecard + audit ledger
npm run sweep             # 50 seeds + sensitivity; exits non-zero if any run double-charges
npm test                  # fuzzed guardrail invariants
npm run eval:diagnosis    # diagnosis graded against hidden ground truth
```

Every run is a pure function of its seed — no `Math.random`, no wall clock in the
engine. Change the assumptions in `src/lib/sim/world.ts` and
`src/lib/sim/generate.ts`, re-run the sweep, and see whether the conclusions
move. If you can find a configuration where the agent double-charges, the sweep
will fail and we want to know.
