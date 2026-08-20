# What broke, and how I got out

Two kinds of failure matter here: the one the product is **built to survive**, and
the ones I **hit while building it**. Both are below, honestly.

---

## Part 1 — The failure the product is designed to survive

### The money-critical one: a lost payment confirmation

The scariest thing a recovery agent can do to a payments company isn't *failing to
recover* — it's **double-charging a customer**. It happens in one specific, realistic
way: a retry *succeeds*, but the confirmation is lost (timeout, dropped webhook). A
naive agent sees "no success," retries, and bills the customer twice.

Recoup treats an unknown charge outcome as a first-class state. It **reconciles
before it ever re-charges**. Here is a real, unedited slice of the audit ledger
(`artifacts/ledger.jsonl`) for such a case:

```
detected        payment_failed ₹2,624 — bank_down
diagnosed       bank_downtime (80% via rules): short-cooldown retry likely succeeds
planned         retry_payment
action_result   Charge outcome UNKNOWN (lost confirmation) — reconciling BEFORE any re-charge
reconciliation  Reconciled: money HAD been captured. Skipped re-charge (prevented a double-charge). Recovered ₹2,624.
recovered       ₹2,624 (confirmed via reconciliation)
```

Across the 120-case batch, **8 lost confirmations were reconciled → 8 double-charges
prevented**, and the agent's double-charge count is **0**. The naive baseline, on the
same cases, double-charges. You can watch this hold under stress: raise the
*Lost-confirm* slider on the dashboard to 40% and re-run — reconciliations climb,
double-charges stay at zero.

Two more failures handled the same deliberate way:

- **Transient gateway error** (simulated 503): the executor retries the *call* with
  the **same idempotency key**, so money can never move twice — logged as
  `action_retried` in the ledger.
- **Customer opt-out**: honored immediately and permanently — all further contact and
  charges halt. Post-opt-out contacts across the batch: **0**.

---

## Part 2 — What actually broke while building it

### 1. The loop that scheduled the same action forever

**Symptom.** Early on, a chunk of cases never resolved. The batch either hung or
produced a suspiciously low recovery rate, and the event queue kept growing.

**Root cause.** `plan()` scheduled the next action relative to `now`
(`retry at now + 1 day`). But the loop re-plans a case *when its scheduled time
arrives* — and at that moment `now` had advanced, so `plan()` computed *another*
`now + 1 day` and pushed the action further out. Every wake-up re-deferred the case
by another day. A classic "the deadline keeps receding" bug.

**Fix.** Schedule from **stable anchors**, never `now`. A retry is anchored to the
last attempt's timestamp (or `createdAt` if none); a contact is anchored to the last
contact time. Re-planning at the scheduled time now yields a time `<= now`, so the
action fires exactly once and the ladder advances. One idea — "anchor to state, not
to the clock" — fixed both the hang and the metrics. (See the note in
`engine/policy.ts`.)

### 2. Metrics that looked *too* good

**Symptom.** The first end-to-end run reported a **1790% uplift** over the baseline.
Great for a headline — but I didn't believe it, and neither would a judge.

**Root cause.** The naive baseline only knows how to retry payments; it ignores
abandoned carts and overdue invoices entirely. Recoup recovers those too — and the
single biggest bucket of at-risk money is B2B invoices. So the "uplift" was mostly
comparing against a baseline that wasn't even playing on two-thirds of the field.

**Fix.** Report the **like-for-like** number honestly: on payments and subscriptions
only — the cases a naive retry *can* touch — Recoup recovers **3.4×** the baseline
(₹3.5L vs ₹1.04L). The money it unlocks beyond the baseline's reach is reported
**separately** (+₹16.1L), not blended into a vanity multiple. A weaker-sounding but
defensible number beats an impressive one a reviewer will discount on sight.

### 3. The reproducibility trap

**Symptom.** I wanted the batch to (a) run with zero setup for a reviewer, (b) give
the *same* money numbers every time, and (c) still support a real LLM. Those pull in
different directions — an LLM call is non-deterministic and needs a key; `tsx`
scripts don't auto-load `.env` the way Next.js does.

**Fix.** Three decisions. The engine uses a **seeded PRNG and a virtual clock** — no
`Math.random`, no wall-clock — so a run is a pure function of its seed. The **LLM is
optional**: diagnosis falls back to a deterministic offline heuristic, so the headline
metrics never depend on a key or a network call (the LLM is an enhancement for
ambiguous cases and message quality, enabled with `LLM=1`). And scripts load env via
Node 24's built-in `process.loadEnvFile` — zero dependencies, missing file ignored.
Net result: `npm run recover:batch` works on a fresh clone and prints identical
numbers to the ones in this repo.

---

**The through-line:** in money software, the interesting work is at the failure
boundary — the lost confirmation, the receding deadline, the number that's too good.
Recoup is built to make those boundaries visible, bounded, and auditable rather than
to hide them.
