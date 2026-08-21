# What broke, and how I got out

Two kinds of failure matter here: the one the product is **built to survive**, and
the ones I **hit while building it**. Both are below, honestly.

---

## Part 1 — The failure the product is designed to survive

### The money-critical one: a lost payment confirmation

The scariest thing a recovery agent can do to a payments company isn't *failing to
recover* — it's **double-charging a customer**. It happens in one specific,
realistic way: a retry *succeeds*, but the confirmation is lost (timeout, dropped
webhook). A naive agent sees "no success," retries, and bills the customer twice.

Recoup treats an unknown charge outcome as a first-class state. It **reconciles
before it ever re-charges**. Here is a real, unedited slice of the audit ledger
(`artifacts/ledger.jsonl`):

```
detected        payment_failed ₹2,624 — bank_down
diagnosed       bank_downtime (80% via rules): short-cooldown retry likely succeeds
planned         retry_payment
action_result   Charge outcome UNKNOWN (lost confirmation) — reconciling BEFORE any re-charge
reconciliation  Reconciled: money HAD been captured. Skipped re-charge (prevented a double-charge). Recovered ₹2,624.
recovered       ₹2,624 (confirmed via reconciliation)
```

Across **6,000 cases in 50 independent worlds** the agent's double-charge count is
**0**. The naive baseline, on the same cases, double-charges **48** times. And it
holds under stress: at a 50% lost-confirmation rate the agent reconciles ~25 times
per batch and *still* never double-charges (see the sensitivity table in
[`SIMULATION.md`](SIMULATION.md)). You can watch it live — raise the
*Lost-confirm* slider on the dashboard and re-run.

Two more failures handled the same deliberate way:

- **Transient gateway error** (simulated 503): the executor retries the *call*
  with the **same idempotency key**, so money can never move twice — logged as
  `action_retried`.
- **Customer opt-out**: honored immediately and permanently. Post-opt-out
  contacts across 6,000 cases: **0**.

---

## Part 2 — What actually broke while building it

### 1. The loop that scheduled the same action forever

**Symptom.** Early on, a chunk of cases never resolved. The batch either hung or
produced a suspiciously low recovery rate, and the event queue kept growing.

**Root cause.** `plan()` scheduled the next action relative to `now`
(`retry at now + 1 day`). But the loop re-plans a case *when its scheduled time
arrives* — and at that moment `now` had advanced, so `plan()` computed *another*
`now + 1 day` and pushed the action further out. Every wake-up re-deferred the
case by another day. A classic "the deadline keeps receding" bug.

**Fix.** Schedule from **stable anchors**, never `now`. A retry is anchored to the
last attempt's timestamp (or `createdAt`); a contact to the last contact time.
Re-planning at the scheduled time now yields a time `<= now`, so the action fires
exactly once and the ladder advances. One idea — *anchor to state, not to the
clock* — fixed both the hang and the metrics.

### 2. Metrics that looked *too* good — twice

**First symptom.** The first end-to-end run reported a **1790% uplift** over the
baseline. Great for a headline; I didn't believe it, and neither would a judge.

**Root cause.** The naive baseline only retries payments — it ignores abandoned
carts and overdue invoices entirely, and B2B invoices are the single biggest
bucket of at-risk money. The "uplift" was mostly comparing against a baseline that
wasn't playing on two-thirds of the field.

**Fix.** Report the **like-for-like** number: on payments and subscriptions only,
Recoup recovers **3.4×** the baseline on seed 42. Money unlocked beyond the
baseline's reach is reported **separately**, never blended into a vanity multiple.

**Second symptom.** Once I ran 50 seeds, the mean uplift came out **8.81× ± 5.96×**
— a standard deviation two-thirds the size of the mean, with a range of 2.14× to
34.57×. A number that unstable is not a number you quote.

**Root cause.** The baseline recovers so little that its denominator is tiny and
lumpy: one lucky large case in the baseline's favour halves the ratio, one
unlucky one triples it. The *ratio of means* is stable; the *mean of ratios* is
not.

**Fix.** Quote the **pooled** figure — total agent recovery ÷ total baseline
recovery across all 6,000 cases = **6.38×** — and publish the per-seed
distribution and median (7.83×) beside it so nobody has to take my word for it.

### 3. The reproducibility trap

**Symptom.** I wanted the batch to (a) run with zero setup for a reviewer, (b)
give the *same* numbers every time, and (c) still support a real LLM. Those pull
in different directions — an LLM call is non-deterministic and needs a key; `tsx`
scripts don't auto-load `.env` the way Next.js does.

**Fix.** The engine uses a **seeded PRNG and a virtual clock** — no `Math.random`,
no wall-clock — so a run is a pure function of its seed. The **LLM is optional**:
diagnosis falls back to a deterministic offline heuristic, so the headline metrics
never depend on a key or a network call. Scripts load env via Node 24's built-in
`process.loadEnvFile`. `npm run recover:batch` works on a fresh clone and prints
the numbers in this repo.

### 4. Obeying the regulator cost me money, and I kept it

**Symptom.** My first quiet-hours window was 21:00–09:00, chosen because it
*seemed* polite. Then I checked what the rule actually is: RBI's recovery-agent
guidelines (12 Aug 2022) direct that borrowers not be contacted outside
**08:00–19:00**.

**What happened when I fixed it.** A narrower contact window means more messages
get deferred, and some deferred past a case's deadline. Gross recovery on seed 42
fell from ₹19.65L to **₹19.07L** — about **₹57,000 of recovery given up to be
compliant** (interestingly, *more* cases resolved, 71 → 74; the money that moved
was concentrated in a few large invoices whose reminders slipped).

**The call.** I kept the compliant window and wrote the citation into
`src/lib/domain/config.ts` next to the value. A recovery agent that invents its
own contact hours is not shippable in India, and a number that only looks good
because it ignores the rule is not a number worth reporting.

### 5. The dev server died and the build didn't — a 90-minute red herring

**Symptom.** After a UI change, `GET /` started returning 500 with a Turbopack
panic: `evaluate_webpack_loader failed → creating new process → node process
exited before we could connect to it, exit code 0xc0000142`. My first instinct was
that my new Server Component was crashing.

**How I found it.** `npm run build` compiled the *same* code and the *same* CSS
successfully. A failure that reproduces in dev but not in build isn't a code
failure — it's an environment failure. `0xc0000142` on Windows is
`STATUS_DLL_INIT_FAILED`: the OS refused to start a new process. Counting
processes found **77 orphaned Chrome instances** left behind by repeated
Playwright screenshot sessions, exhausting the desktop heap so Turbopack's PostCSS
worker couldn't fork.

**Fix.** Killed the orphans, cleared `.next/dev`, restarted — 200 OK, no code
change. The lesson I actually took: *when a failure reproduces in one runtime and
not another, stop reading your own diff.*

### 6. A lint rule that was right

Fetching the first batch in a `useEffect` on mount tripped
`react-hooks/set-state-in-effect`. The lazy fix is a disable comment. The correct
fix was to make `page.tsx` a Server Component that runs the batch and passes the
result in as a prop — which removed the effect, removed the loading flash, and
made the first paint show real numbers. The lint rule was pointing at a design
smell, not a formality.

---

**The through-line:** in money software the interesting work is at the failure
boundary — the lost confirmation, the receding deadline, the number that's too
good, the rule that costs you revenue. Recoup is built to make those boundaries
visible, bounded, and auditable rather than to hide them.
