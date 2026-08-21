# Recoup — 5-minute pitch video script

**Format:** screen recording of the dashboard + terminal, your voice over.
**Tone:** calm and specific. Numbers, not adjectives. Never say "leverage",
"seamless", or "revolutionary".

**Before you record**
- `npm run dev` → http://localhost:3000, seed 42, 120 cases, gate = Auto.
- A second terminal ready, in the project root.
- Have `SEED=77 npm run razorpay:live` output and one Razorpay test link open in
  a tab (from `npm run razorpay:live`).
- Close notifications. Record at 1080p+. Zoom the browser to ~110% so numbers are
  readable on a phone.

---

## 0:00 – 0:30 · The problem (problem taste)

**On screen:** the dashboard, full view, already loaded.

> "Merchants don't lose revenue in one clean event — it drips. A payment fails, a
> checkout is abandoned, a subscription bounces, an invoice goes overdue.
>
> Today most of that is handled by dumb retries: hit the same card three times and
> hope. That retries an *expired* card that will never work. It retries before the
> customer's salary lands. And when a charge succeeds but the confirmation is
> lost, it retries again — and double-charges a real person.
>
> This is Recoup. It recovers more of that money than blind retries, and it
> **cannot** misbehave with money."

---

## 0:30 – 1:20 · What it does, on one real case (the loop)

**On screen:** click the auto-selected case in the Audit trail panel (the
reconciliation one). Scroll the timeline slowly.

> "Every case runs one loop: detect, diagnose, decide, gate, act, observe.
>
> Here's one, end to end. ₹2,624 payment failed, Razorpay reason `bank_down`.
> Recoup diagnosed *bank downtime* deterministically from the error code —
> no model needed, the answer is in the error. Policy said: retry, but at a smart
> time, because the bank will be back.
>
> Then look at this line —" **(point at ACTION RESULT)** "— the charge outcome came
> back **unknown**. The confirmation was lost.
>
> A naive agent treats unknown as failed and charges again. Recoup **reconciles
> first** —" **(point at RECONCILIATION)** "— finds the money *had* actually been
> captured, skips the re-charge, and books the recovery. That's a double-charge
> prevented, and it's on the permanent record.
>
> Every line you're reading is the audit trail. Not logging I added for the demo —
> this *is* how the agent runs."

---

## 1:20 – 2:20 · The money, honestly (measured across a batch)

**On screen:** scroll up to the hero. Then switch to terminal and run
`npm run sweep` — or show `artifacts/sweep.md` if you want to keep it tight.

> "Across this batch: ₹39.3 lakh at risk, **₹19 lakh recovered net**, 74 of 120
> cases.
>
> But one batch proves nothing — the brief says that explicitly. So here's the
> sweep: **50 independent seeds, 6,000 cases.** Recovery rate 61.9% ± 4.2%.
>
> And the comparison is deliberately unflattering to me. The baseline is 'retry
> three times, no diagnosis'. It can only touch payments and subscriptions, so I
> compare **only on those cases** — that's **6.4× pooled**. The money Recoup
> unlocks from carts and invoices that the baseline can't even see, I report
> **separately**, never blended in.
>
> My first run said '1790% uplift'. It was technically true and completely
> misleading, so I threw it away. That story is in the repo."

---

## 2:20 – 3:05 · The failure, live (failure recovery)

**On screen:** drag the **Lost-confirm** slider to ~40%. Click **Run batch**.
Point at the Safety card.

> "Let me break it on purpose. This slider is the rate at which a successful
> charge loses its confirmation — the exact condition that causes double-charges.
> I'll take it from 14% to 40% and re-run.
>
> Reconciliations jump —" **(point)** "— the safety machinery is doing far more
> work. And double-charges: **still zero**.
>
> That holds all the way to a 50% failure rate, across all 6,000 cases in the
> sweep. The naive baseline double-charges 48 times on the same data.
>
> It's structural, not luck: every charge carries an idempotency key, and an
> unknown outcome is *always* reconciled before any retry."

---

## 3:05 – 3:50 · Bounded and gated (the trust story)

**On screen:** flip **Human gate** to **Manual**. Wait for the Approvals queue.
Then click **Approve all & re-run**.

> "Bounded means the agent physically cannot act outside its limits. Attempt caps,
> cooldowns, a per-customer daily cap, an incentive budget, and opt-out honoured
> forever.
>
> Quiet hours are **08:00 to 19:00** — that's not my taste, that's RBI's
> recovery-agent guideline. Complying cost me about ₹57,000 of recovery on this
> batch. I kept it, and cited the rule next to the value in the config.
>
> And the human gate is real. Watch —" **(flip to Manual)** "— five high-value
> actions, ₹35,000 to ₹87,000, just **stopped**. Net recovery drops from ₹19.05
> lakh to ₹18.06 lakh. The agent will not move that money without a person.
>
> I approve —" **(click)** "— and only then do they proceed. The gate costs money
> on purpose. That's what makes it a gate."

---

## 3:50 – 4:35 · AI judgment, measured (and the real Razorpay)

**On screen:** the Diagnosis accuracy + AI usage cards. Then terminal:
`npm run eval:diagnosis` output, then the `razorpay:live` output.

> "On AI: the model is deliberately kept **out of the money path**. It never
> decides or authorises a charge. It does two things — classify cases that carry
> no error code, and write the customer message, in Hinglish where that fits.
>
> **58% of cases never touch a model at all**, because a deterministic rule
> answers them perfectly.
>
> And I measured it rather than claiming it. The simulator owns hidden ground
> truth, so I can grade every diagnosis. Rules: 100%. The text-only cases:
> heuristic gets 72%, **Gemini 3.7 Flash gets 84%** — and the money sitting behind
> a wrong call drops from ₹4.26 lakh to ₹20,000. That's **₹1 of model spend for
> ₹1.34 lakh more net recovery**, because a better diagnosis means it stops
> chasing dead cases.
>
> Finally — this isn't only a simulation." **(show razorpay:live)** "Same decision
> loop, pointed at real Razorpay test-mode APIs. Real payment links, idempotent —
> and here, a guardrail blocking a **real** API call because it was outside the
> RBI contact window."

**Optional, strong if you do it live:** open the test link, pay with card
`4111 1111 1111 1111`, re-run `SEED=77 npm run razorpay:live`, show it reconcile
to paid.

---

## 4:35 – 5:00 · Close (why you'd trust it)

**On screen:** the repo README, or the green CI badge.

> "Everything I showed is reproducible from a seed — clone it, run
> `npm run recover:batch`, get these exact numbers. No API key needed.
>
> The safety claims aren't assertions: a fuzz suite runs the invariants under
> randomised policies, and CI fails the build if any run ever double-charges.
>
> The honest summary: recovers 6.4× a naive retry on comparable cases, zero
> double-charges in 6,000, every rupee explainable, and every assumption I made
> written down in SIMULATION.md — including what I'm *not* claiming.
>
> That's Recoup."

---

## Delivery notes

- **Slowest** on the reconciliation trace (1:20) and the gate demo (3:05) — those
  two moments are the whole pitch.
- Don't read the numbers off the screen; say them and let the screen confirm.
- If something misbehaves live, say what you expected and move on. Recovering
  gracefully on camera is on-brand for this project.
- Keep it under 5:00. If you must cut, cut the AI section to two sentences — the
  reconciliation and the human gate must stay.
