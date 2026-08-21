# Recoup — 5-minute pitch video script

**Format:** screen recording of the dashboard + terminal, your voice over.
**Tone:** calm and specific. Numbers, not adjectives. Never say "leverage",
"seamless", or "revolutionary".

---

## Before you record — setup checklist

**Environment**
- [ ] `npm run dev` → http://localhost:3000. Seed **42**, cases **120**, gate **Auto**.
- [ ] Browser zoom **~110%** so numbers are legible when someone watches on a phone.
- [ ] A second terminal open in the project root, font size bumped, window large.
- [ ] Close Slack/mail/notifications. Full-screen or a clean window — no bookmarks bar clutter.
- [ ] Record **1080p minimum**. Use a real mic if you have one; laptop mic in a quiet room beats a bad headset.

**Content to have staged (so you never wait on a network call)**
- [ ] Terminal A: `npm run sweep` already run once, output scrolled to the summary block.
- [ ] Terminal B: `npm run eval:diagnosis` output visible (the head-to-head table).
- [ ] Terminal C: `npm run razorpay:live` output visible, **plus one link paid** (see below).
- [ ] The Razorpay dashboard open in a tab showing the created links (optional but strong).

**Do this first — it is the single strongest 5 minutes you can spend**

> Run `$env:SEED=101; npm run razorpay:live` (PowerShell) or `SEED=101 npm run razorpay:live`
> (Git Bash). Open one printed link, pay it with test card **4111 1111 1111 1111**,
> any future expiry, any CVV. Then re-run **the exact same command** — the case
> reconciles to `recovered=true ✓`.
>
> Record that. It is the only moment in the whole video where **real money
> actually moves and the agent notices**. Everything else is a claim; this is a
> demonstration.
>
> ⚠️ Re-run with the **same seed**. A different seed generates a different case
> set with different reference ids and will not find your paid link.

**Do a full dry run once.** Not for polish — to find the one thing that breaks.

---

## 0:00 – 0:30 · The problem (problem taste)

> **Open on the dashboard, ₹19L already on screen. No title card, no webcam, no
> "hi, I'm…". The first 25 seconds decide whether they keep watching.**

> "Merchants don't lose revenue in one clean event — it drips. A payment fails, a
> checkout is abandoned, a subscription bounces, an invoice goes overdue.
>
> Today most of that is chased with dumb retries: hit the same card three times
> and hope. That retries an *expired* card that will never work. It retries before
> the customer's salary lands. And when a charge succeeds but the confirmation is
> lost, it retries again — and double-charges a real person.
>
> This is Recoup. It recovers more of that money than blind retries, and it
> **cannot** misbehave with money."

---

## 0:30 – 1:20 · One real case, end to end (the loop)

**On screen:** the auto-selected case in the Audit trail panel — the
reconciliation one. Scroll the timeline slowly. **Slow down here.**

> "Every case runs one loop: detect, diagnose, decide, gate, act, observe.
>
> Here's one. ₹2,624 payment failed, Razorpay reason `bank_down`. Recoup
> diagnosed *bank downtime* deterministically from the error code — no model
> needed, the answer is in the error. Policy said: retry, but at a smart time,
> because the bank will be back.
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

## 1:20 – 2:15 · The money, honestly (measured across a batch)

**On screen:** scroll up to the hero, then cut to Terminal A (`sweep` summary).

> "On this batch: ₹39.3 lakh at risk, **₹19 lakh recovered net**, 74 of 120 cases.
>
> But one batch proves nothing — the brief says that explicitly. So: **50
> independent seeds, 6,000 cases.** Recovery 61.9% ± 4.2%.
>
> And the comparison is deliberately unflattering to me. The baseline is 'retry
> three times, no diagnosis'. It can only touch payments and subscriptions — so I
> compare **only on those cases**. That's **6.4× pooled**. The money Recoup
> unlocks from carts and invoices the baseline can't even see, I report
> **separately**, never blended in.
>
> My first run said '1790% uplift'. Technically true, completely misleading. I
> threw it away. That story's in the repo."

---

## 2:15 – 3:00 · Break it on purpose (failure recovery)

**On screen:** drag **Lost-confirm** to ~40%. Click **Run batch**. Point at the
Safety card. **Slow down here too — this is the money shot.**

> "Let me break it. This slider is the rate at which a successful charge loses its
> confirmation — the exact condition that causes double-charges. From 14% to 40%,
> and re-run.
>
> Reconciliations jump —" **(point)** "— the safety machinery is doing far more
> work. Double-charges: **still zero**.
>
> That holds to a 50% failure rate, across all 6,000 cases in the sweep. The naive
> baseline double-charges 48 times on the same data.
>
> It's structural, not luck: every charge carries an idempotency key, and an
> unknown outcome is *always* reconciled before any retry."

---

## 3:00 – 3:40 · Bounded and gated (trust)

**On screen:** flip **Human gate** to **Manual**. Wait for the Approvals queue.
Then **Approve all & re-run**.

> "Bounded means the agent physically cannot act outside its limits. Attempt caps,
> cooldowns, a per-customer daily cap, an incentive budget, opt-out honoured
> forever.
>
> Customers are only ever contacted between **08:00 and 19:00** local — outside
> that the agent stays silent. That's not my taste, that's RBI's recovery-agent
> guideline. Complying cost me about ₹57,000 of recovery on this batch. I kept it,
> and cited the rule next to the value in the config.
>
> And the human gate is real. Watch —" **(flip to Manual)** "— five high-value
> actions, ₹35,000 to ₹87,000, just **stopped**. Net drops from ₹19.05 lakh to
> ₹18.06 lakh. The agent will not move that money without a person.
>
> I approve —" **(click)** "— and only then do they proceed. The gate costs money
> on purpose. That's what makes it a gate."

---

## 3:40 – 4:25 · AI judgment, measured + real Razorpay

**On screen:** the Diagnosis accuracy + AI usage cards → Terminal B
(`eval:diagnosis`) → Terminal C (`razorpay:live`, **including the paid link**).

> "On AI: the model is deliberately kept **out of the money path**. It never
> decides or authorises a charge. It does two things — classify cases that carry
> no error code, and write the customer message, in Hinglish where that fits.
>
> **58% of cases never touch a model at all**, because a deterministic rule
> answers them perfectly.
>
> And I measured it rather than claiming it. The simulator owns hidden ground
> truth, so I can grade every diagnosis. Rules: 100%. Text-only cases: the
> heuristic gets 72%, **Gemini 3.7 Flash gets 84%** — and money sitting behind a
> wrong call drops from ₹4.26 lakh to ₹20,000. **₹1 of model spend, ₹1.34 lakh
> more net recovery**, because a better diagnosis means it stops chasing dead
> cases.
>
> And this isn't only a simulation." **(Terminal C)** "Same decision loop, pointed at
> real Razorpay test-mode APIs. Real payment links, idempotent. Here's a guardrail
> blocking a **real** API call. Here's smart timing **deferring** a retry to
> tomorrow morning instead of firing it now.
>
> And here —" **(the paid link)** "— I pay one with a test card, re-run, and the
> agent reconciles it as recovered. Detection to money, closed."

---

## 4:25 – 5:00 · Close (why you'd trust it)

**On screen:** the README with the green CI badge, or the live URL.

> "The measured results are reproducible from a seed — clone it, run
> `npm run recover:batch`, get these exact numbers with no API key at all. The
> Gemini and Razorpay pieces need keys; the metrics don't.
>
> The safety claims aren't assertions. A fuzz suite runs the invariants under
> randomised policies, and CI fails the build if any run ever double-charges.
>
> It's also live —" **(show the URL)** "— run the batch yourself in a browser.
>
> Honest summary: 6.4× a naive retry on comparable cases, zero double-charges in
> 6,000, every rupee explainable, and every assumption written down in
> SIMULATION.md — including what I'm *not* claiming.
>
> That's Recoup."

---

## Delivery notes

- **Know the beats, don't read the script.** Monotone narration of true numbers
  loses to energetic narration of the same numbers. Read it aloud twice, then
  talk from memory.
- **Slowest** on the reconciliation trace (0:30) and the gate demo (3:00). Those
  two moments are the pitch. Everything else can be brisk.
- **Don't read numbers off the screen** — say them, let the screen confirm.
- **Silence is fine** while something loads. Filler ("um, so, basically") is not.
- If something misbehaves live, **say what you expected and move on**. Recovering
  gracefully on camera is exactly on-brand for this project.
- **Under 5:00.** If you must cut: shorten the AI section to two sentences. The
  reconciliation and the human gate must stay.
- Upload **unlisted**, title it `Recoup — Bounded Revenue Recovery Agent (Razorpay
  AI Buildathon, Track 03)`, and put the repo + live URL in the description.

## If you have time for a second take

The single highest-value change between take 1 and take 2 is usually **cutting
your own preamble**. Watch take 1 and delete every sentence before "Merchants
don't lose revenue in one clean event."

---

## After the video

Shortlisted builders go straight to a panel — no aptitude test, no group
discussion. Think through, in your own words: why the LLM is kept out of the
money path, why anyone should believe numbers from a simulator you wrote, how
this would go to production, the worst bug you shipped, and what you'd build
next. You have a real answer to every one of those; the only mistake would be
hearing them for the first time in the room.
