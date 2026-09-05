# Recoup — 5-minute pitch video script

Every beat below is written as **DO** (what to click), **POINT** (exactly where on
screen your cursor goes), and **SAY** (the words). Follow it top to bottom.

**Tone:** calm and specific. Numbers, not adjectives. Never say "leverage",
"seamless", or "revolutionary".

---

# PART 0 · Before you hit record

## Set up the screen

- [ ] `npm run dev` → **http://localhost:3000**
- [ ] Header controls: Seed **42** · Cases **120** · `lost-confirm` **14%** ·
      `api-error` **10%** · **Human gate: Auto**
- [ ] Browser zoom **~110%** so numbers are legible on a phone.
- [ ] Close Slack/mail/notifications. No bookmarks bar.
- [ ] Record **1080p minimum**.

## Set up the terminal

Open **one** terminal in the project root — in VS Code press **Ctrl + `**, or hit
the Windows key, type `PowerShell`, then:

```
cd E:\Projects\hackathons\razorpay-buildathon
```

> There is no terminal inside the app. This is just a normal terminal window you
> alt-tab to. Everything below runs **before** you record, so its output is
> already sitting in the scrollback and you only ever scroll — never wait.

Run these three, in order:

1. **`npm run sweep`** → leave the summary block visible.
2. **`npm run eval:diagnosis`** → the heuristic-vs-Gemini table.
3. **`$env:SEED=101; npm run razorpay:live`** → open a printed link → pay with test
   card **4111 1111 1111 1111**, any future expiry, any CVV → **re-run the exact
   same command in the same window.**

Step 3's **re-run** is the single most valuable thing in the whole video: it is
the only moment where real money moves and the agent notices. You are looking for
`idempotent re-run → SAME link ✓` and `recovered=true ✓`. The first run is not the
money shot — the re-run is.

> ⚠️ Re-run with the **same seed**. A different seed generates different reference
> ids and will not find your paid link. `$env:SEED` only lives in that one
> PowerShell window — a fresh window silently falls back to seed 42.

> ⏰ **Do step 3 between 08:00 and 19:00 IST.** The RBI contact window is enforced
> for real on the live path: after 19:00 the guardrails correctly block link
> creation and there is nothing to pay.

## 🚫 Do NOT run `npm run recover:batch` on camera

Your `.env` sets `LLM=1`, so that command routes text-only cases through Gemini
and prints **₹20,38,563** — while the dashboard next to it says **₹19,04,811**,
because the web app always uses the offline heuristic. Two different totals on
screen reads as a bug. You don't need it: the dashboard already shows those
numbers, and `sweep` agrees with the dashboard because neither uses the model.

## Do one full dry run

Not for polish — to find the one thing that breaks.

---

# PART 1 · The script

## 0:00 – 0:30 · The problem

**DO:** Start already on the dashboard, ₹19.0L on screen. No title card, no
webcam, no "hi, I'm…". The first 25 seconds decide whether they keep watching.

**POINT:** nothing yet — just let the big green number sit there.

**SAY:**

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

## 0:30 – 1:20 · One real case, end to end 🐢 SLOW DOWN

**DO:** Scroll down to the **Audit trail** panel (right-hand side, next to "Case
board"). It has already auto-opened the right case — **case_0042** — because the
dashboard deliberately opens on the first successful reconciliation. Scroll its
timeline slowly.

**POINT (in this order):**

| # | Point your cursor at | It reads |
|---|---|---|
| 1 | The **`CASE DETECTED`** row at the top | ₹2,624 payment failed |
| 2 | The **`DIAGNOSED`** row | `bank_downtime` · source: rules |
| 3 | The **`PLANNED`** row | retry_payment, scheduled for later |
| 4 | The **`ACTION RESULT`** row | outcome **unknown** |
| 5 | The **`RECONCILIATION`** row — *it has a tinted highlight background* | found already captured |
| 6 | The **`RECOVERED`** row — *also highlighted* | booked, no second charge |

**SAY:**

> "Every case runs one loop: detect, diagnose, decide, gate, act, observe.
>
> Here's one. ₹2,624 payment failed, Razorpay reason `bank_down`. Recoup
> diagnosed *bank downtime* deterministically from the error code — no model
> needed, the answer is in the error. Policy said: retry, but at a smart time,
> because the bank will be back.
>
> Then look at this line —" **(point at `ACTION RESULT`)** "— the charge outcome
> came back **unknown**. The confirmation was lost.
>
> A naive agent treats unknown as failed and charges again. Recoup **reconciles
> first** —" **(point at the highlighted `RECONCILIATION` row)** "— finds the money
> *had* actually been captured, skips the re-charge, and books the recovery.
> That's a double-charge prevented, and it's on the permanent record.
>
> Every line you're reading is the audit trail. Not logging I added for the demo —
> this *is* how the agent runs."

---

## 1:20 – 2:15 · The money, honestly

**DO:** Scroll back up to the top hero card. Then alt-tab to the terminal and
scroll to the **`sweep`** summary block.

**POINT (in this order):**

| # | Point at | Location |
|---|---|---|
| 1 | The big green **₹19.0L** | top-left card, under "Net recovered" |
| 2 | The line **"₹19,07,364 recovered of ₹39,32,259 at risk"** | directly beneath it |
| 3 | The **`3.4× vs baseline`** badge | top-right corner of that same card |
| 4 | The **"Recovered  74 / 120"** mini-stat | bottom strip of that card |
| 5 | *(alt-tab)* the `sweep` summary | terminal |

**SAY:**

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

## 2:15 – 3:00 · Break it on purpose 🐢 SLOW DOWN

**DO:** In the header, drag the **`lost-confirm`** slider (the left of the two
"Inject chaos" sliders) from **14% → 40%**. Click **Run batch**. Wait for it.

**POINT:** the **"Safety — bounded & gated"** card — the smaller card to the
**right** of the big green one.

| # | Point at | It reads |
|---|---|---|
| 1 | The **"5 lost confirmations reconciled"** line | this number jumps up after the re-run |
| 2 | The big **`0`** above it | "double charges" — still zero |

**SAY:**

> "Let me break it. This slider is the rate at which a successful charge loses its
> confirmation — the exact condition that causes double-charges. From 14% to 40%,
> and re-run.
>
> Reconciliations jump —" **(point at the reconciled line)** "— the safety machinery
> is doing far more work. Double-charges —" **(point at the big 0)** "— **still
> zero**.
>
> That holds to a 50% failure rate, across all 6,000 cases in the sweep. The naive
> baseline double-charges 48 times on the same data.
>
> It's structural, not luck: every charge carries an idempotency key, and an
> unknown outcome is *always* reconciled before any retry."

---

## 3:00 – 3:40 · Bounded and gated 🐢 SLOW DOWN

**Controls, exactly:** Seed **42** · Cases **120** · `lost-confirm` **14%** ·
`api-error` **10%** — every slider back at its default.

**DO, in order:**

1. ⚠️ **First drag `lost-confirm` back to 14%** and click **Run batch**. The last
   section left it at 40%, and the figures below are default-chaos numbers — skip
   this and the screen contradicts your narration. Do it *silently* while speaking
   the first two paragraphs.
2. On the **"Human gate"** card (rightmost of the three-card row), click
   **Manual**. Wait for the **Approvals queue** panel to appear.
3. Click **Approve all & re-run**.

**POINT:**

| # | Point at | It reads |
|---|---|---|
| 1 | The **Approvals queue** rows | 5 held actions: **₹40,158 · ₹46,216 · ₹35,733 · ₹87,238 · ₹72,551** |
| 2 | The big green **Net recovered** number | drops **₹19.05L → ₹18.06L** |
| 3 | *(after approving)* the same number | back to **₹19,04,811**, **0 awaiting**, 74/120 |

**SAY:**

> "Bounded means the agent physically cannot act outside its limits. Attempt caps,
> cooldowns, a per-customer daily cap, an incentive budget, opt-out honoured
> forever.
>
> Customers are only ever contacted between **08:00 and 19:00** local — outside
> that the agent stays silent. That's not my taste, that's RBI's recovery-agent
> guideline. Complying cost me about ₹57,000 of recovery on this batch. I kept it,
> and cited the rule next to the value in the config.
>
> And the human gate is real. Watch —" **(click Manual)** "— five high-value
> actions, ₹35,000 to ₹87,000, just **stopped**. Net drops from ₹19.05 lakh to
> ₹18.06 lakh. The agent will not move that money without a person.
>
> I approve —" **(click Approve all & re-run)** "— and only then do they proceed. The
> gate costs money on purpose. That's what makes it a gate."

---

## 3:40 – 4:25 · AI judgment, measured + real Razorpay

**DO:** You are already on the three-card row — the **Human gate** card you just
used is the **rightmost** of three. Move **left** along that same row. No
scrolling needed.

**POINT (dashboard first, then terminal):**

| # | Point at | Card | It reads |
|---|---|---|---|
| 1 | **88.3%**, "106/120 correct" | **Diagnosis accuracy** (leftmost) | headline |
| 2 | **rules (error codes) — 100.0%** | same card | green bar |
| 3 | **text path (LLM/heuristic) — 72.0%** | same card | blue bar |
| 4 | **58%**, "answered with no model at all" | **AI usage** (middle) | headline |
| 5 | *(now alt-tab)* the `eval:diagnosis` table | terminal | 72% → **84%** |
| 6 | scroll down to the `razorpay:live` **re-run** | terminal | `SAME link ✓`, `recovered=true ✓` |

> ⚠️ **Two numbers in this beat are NOT on the dashboard.** Gemini's **84%** and
> the **₹1 → ₹1.34 lakh** ROI exist only in the terminal. Also **never point at
> the AI usage card's `Model calls · cost` row** — it reads **`0 · ₹0.00`**,
> because the web app never calls the model, and pointing there while you say
> "₹1 of model spend" puts a flat contradiction on screen. Say the dashboard
> numbers on the dashboard, **alt-tab first**, then say the Gemini and ROI
> numbers.

**SAY:**

> "On AI: the model is deliberately kept **out of the money path**. It never
> decides or authorises a charge. It does two things — classify cases that carry
> no error code, and write the customer message, in Hinglish where that fits.
>
> **58% of cases never touch a model at all**, because a deterministic rule
> answers them perfectly.
>
> And I measured it rather than claiming it. The simulator owns hidden ground
> truth, so I can grade every diagnosis. Rules: 100%. Text-only cases: the
> heuristic gets 72%," **(now alt-tab to the terminal)** "**Gemini 3.7 Flash gets
> 84%** — and money sitting behind a wrong call drops from ₹4.26 lakh to ₹20,000.
> **₹1 of model spend, ₹1.34 lakh more net recovery**, because a better diagnosis
> means it stops chasing dead cases.
>
> And this isn't only a simulation." **(scroll to the `razorpay:live` re-run)**
> "Same decision loop, pointed at real Razorpay test-mode APIs. Real payment
> links, idempotent — the re-run returns the **same** link, never a duplicate. And
> here's smart timing **deferring** a retry to tomorrow morning instead of firing
> it now — the same RBI window applies to these real calls too; run this after 7pm
> and it blocks them outright.
>
> And here —" **(point at the `recovered=true ✓` line)** "— I paid one of these links
> with a test card, re-ran, and the agent reconciled it as recovered. Detection to
> real money, closed."

---

## 4:25 – 5:00 · Close

**DO:** Switch to the README with the green CI badge, or the live URL
(https://recoup-shubhambhattog.vercel.app).

**POINT:** the green **CI badge** in the README, then the live URL in the address
bar.

**SAY:**

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

# PART 2 · Delivery notes

- **Know the beats, don't read the script.** Monotone narration of true numbers
  loses to energetic narration of the same numbers. Read it aloud twice, then talk
  from memory.
- **Slowest** on the reconciliation trace (0:30) and the gate demo (3:00). Those
  two moments are the pitch. Everything else can be brisk.
- **Don't read numbers off the screen** — say them, let the screen confirm.
- **Silence is fine** while something loads. Filler ("um, so, basically") is not.
- If something misbehaves live, **say what you expected and move on.** Recovering
  gracefully on camera is exactly on-brand for this project.
- **The script lands at exactly 5:00, so it has zero slack.** Aim to finish at
  **4:40–4:50**. The AI section (3:40) is the pressure valve — it survives being
  cut to two sentences. The reconciliation trace and the human gate must stay at
  full length.
- Upload **unlisted**, title it `Recoup — Bounded Revenue Recovery Agent (Razorpay
  AI Buildathon, Track 03)`. Put the repo URL, the live demo URL, and chapter
  timestamps in the description (`0:00 Problem · 0:30 One case end-to-end · 1:20
  Measured results · 2:15 Breaking it live · 3:00 Human gate · 3:40 AI + real
  Razorpay · 4:25 Close`) — a judge who skims jumps straight to what they care
  about instead of scrubbing blind.

## If you have time for a second take

The highest-value change between take 1 and take 2 is usually **cutting your own
preamble**. Watch take 1 and delete every sentence before "Merchants don't lose
revenue in one clean event."

---

# PART 3 · After the video

Shortlisted builders go straight to a panel — no aptitude test, no group
discussion. Think through, in your own words: why the LLM is kept out of the money
path, why anyone should believe numbers from a simulator you wrote, how this would
go to production, the worst bug you shipped, and what you'd build next. You have a
real answer to every one of those; the only mistake would be hearing them for the
first time in the room.
