// Live mini-batch against REAL Razorpay test-mode APIs.
//
//   npm run razorpay:live            # 6 cases, real Payment Links, real reconcile
//   LIVE_N=10 SEED=77 npm run razorpay:live
//
// Proof that "one brain, two hands" is not just a claim: the SAME diagnose →
// policy → gate pipeline that produces our measured batch numbers here drives
// RazorpayExecutor instead of the simulator.
//
// Differences from the simulated batch, stated honestly:
//   • It runs on the WALL CLOCK, not the virtual clock, so the audit trail can
//     be reconciled against Razorpay's dashboard and against webhook events.
//     Cases are treated as detected now.
//   • Because every action here reaches the customer as a payment link, the
//     guard context is marked `linkBasedExecutor`, so retries are held to the
//     contact rules (RBI window, contact caps) as well as the money rules.
//   • Interventions scheduled for the future are REPORTED, not executed. A
//     smart-timed retry that policy puts at 10:00 tomorrow does not fire today
//     just because this is a demo.
//   • No customer contact details are sent and reminders are off, so no real
//     person can be messaged. See FAILURE_STORY.md for why that matters.

import { loadEnv } from "@/lib/core/env";
loadEnv();

import fs from "node:fs";
import path from "node:path";
import { generateBatch } from "@/lib/sim/generate";
import { diagnose } from "@/lib/engine/diagnose";
import { plan } from "@/lib/engine/policy";
import { gate, contactDayKey, type GuardContext } from "@/lib/engine/guardrails";
import { RazorpayExecutor } from "@/lib/engine/razorpay-executor";
import { Ledger } from "@/lib/ledger/ledger";
import { DEFAULT_POLICY } from "@/lib/domain/config";
import { razorpayConfigured, isLiveKey, notificationsAllowed } from "@/lib/razorpay/client";
import { formatINR } from "@/lib/core/money";
import { getLlm } from "@/lib/ai/llm";
import { localHour } from "@/lib/core/time";

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
const LIVE_N = num(process.env.LIVE_N, 6);
const SEED = num(process.env.SEED, 42);

const OUT = path.join(process.cwd(), "artifacts", "live-ledger.jsonl");

function writeLedger(ledger: Ledger): void {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, ledger.toJSONL());
}

async function main() {
  if (!razorpayConfigured()) {
    console.log(`\n  Razorpay keys not configured.`);
    console.log(`  Add RAZORPAY_KEY_ID (rzp_test_…) and RAZORPAY_KEY_SECRET to .env.local, then re-run.\n`);
    return;
  }
  if (isLiveKey()) {
    console.error(`\n  ✗ Refusing to run: RAZORPAY_KEY_ID is a LIVE key. This demo only runs against test mode.\n`);
    process.exit(1);
  }

  const ledger = new Ledger();
  // reference_ids are namespaced by seed so two runs can never collide and
  // adopt each other's links.
  const executor = new RazorpayExecutor(ledger, `rc${SEED}`);
  const llm = getLlm();
  const policy = { ...DEFAULT_POLICY, autoApproveInSim: true };
  const ctx: GuardContext = {
    policy,
    incentiveSpentPaise: 0,
    contactsByCustomerDay: new Map(),
    approve: () => true,
    linkBasedExecutor: true,
  };

  const now = Date.now();
  const { cases } = generateBatch(SEED, 120);
  // Only cases a Payment Link can genuinely recover — we cannot re-charge
  // someone else's saved card in test mode.
  const linkable = cases
    .filter((c) => c.type !== "payment_failed" || c.signal.reason === "card_expired")
    .slice(0, LIVE_N)
    // Treat each as detected now so the wall clock and the policy agree.
    .map((c) => ({ ...c, createdAt: now }));

  console.log(`\n  RECOUP — LIVE Razorpay test-mode batch   seed=${SEED}  cases=${linkable.length}`);
  console.log(`  notifications: ${notificationsAllowed() ? "ENABLED (env opt-in)" : "OFF — no email/SMS/reminders will be sent"}`);
  console.log(`  local hour: ${localHour(now, 330)}:00 IST  ·  RBI contact window 08:00–19:00`);
  console.log(`  ${"─".repeat(72)}\n`);

  const created: Array<{ id: string; url: string; amount: number; linkId: string }> = [];
  let deferred = 0;
  let blocked = 0;

  try {
    for (const c of linkable) {
      c.diagnosis = await diagnose(c, llm);
      const iv = plan(c, now, policy);

      console.log(`  ${c.id}  ${formatINR(c.amount).padStart(12)}  ${c.type}`);
      console.log(`    diagnosed  ${c.diagnosis.rootCause} (${c.diagnosis.source})`);
      console.log(`    planned    ${iv.kind} — ${iv.rationale}`);

      // Smart timing is real: an action scheduled for later does not fire now.
      if (iv.kind !== "escalate_human" && iv.kind !== "stop" && iv.scheduledAt > now) {
        const inHours = ((iv.scheduledAt - now) / 3_600_000).toFixed(1);
        console.log(`    deferred   scheduled in ${inHours}h — not executed now\n`);
        ledger.append({
          at: now,
          caseId: c.id,
          type: "planned",
          summary: `Deferred ${iv.kind} to +${inHours}h (smart timing); no action taken now.`,
          data: { kind: iv.kind, scheduledAt: iv.scheduledAt },
        });
        deferred++;
        continue;
      }

      let action = iv;
      const decision = gate(c, action, ctx, now);
      if (!decision.allowed) {
        console.log(`    gate       BLOCKED (${decision.reason})`);
        ledger.append({
          at: now,
          caseId: c.id,
          type: "gate_blocked",
          summary: `Blocked ${action.kind}: ${decision.reason}.`,
          data: { reason: decision.reason, fallback: decision.fallback },
        });

        // Mirror the simulated loop: a block with a softer fallback is a
        // downgrade, not a dead end. Anything else stops the case here.
        if (decision.fallback === "nudge" && action.kind !== "nudge") {
          action = {
            kind: "nudge",
            scheduledAt: now,
            channel: action.channel,
            message: action.message,
            rationale: `Fallback nudge (was ${action.kind}: ${decision.reason}).`,
            requiresApproval: false,
          };
          const retry = gate(c, action, ctx, now);
          if (!retry.allowed) {
            console.log(`               fallback nudge also blocked (${retry.reason}) → stopping\n`);
            blocked++;
            continue;
          }
          console.log(`               → downgraded to nudge`);
        } else {
          console.log(`               → no money action taken\n`);
          blocked++;
          continue;
        }
      }
      if (action.kind === "escalate_human" || action.kind === "stop") {
        console.log(`    outcome    ${action.kind} — correctly no money action\n`);
        ledger.append({ at: now, caseId: c.id, type: "exception", summary: `${action.kind}: ${action.rationale}` });
        continue;
      }

      const outcome = await executor.execute(c, action, now);
      const linkId = outcome.idempotencyKey!;

      const ev = ledger.forCase(c.id).find((e) => e.type === "action_executed");
      const url = String((ev?.data as { shortUrl?: string } | undefined)?.shortUrl ?? "");
      created.push({ id: c.id, url, amount: c.amount, linkId });
      console.log(`    executed   real Razorpay link → ${url}`);

      // Idempotency proof: repeat the IDENTICAL step. This must run before the
      // contact counters move, because the reference_id is derived from the
      // step index — bumping it first would produce a different reference and
      // therefore a genuinely different link, which would prove the opposite of
      // what we are claiming. (It did exactly that until this was fixed.)
      const again = await executor.execute(c, action, now);
      console.log(
        `    idempotent re-run → ${again.idempotencyKey === linkId ? "SAME link, no duplicate created ✓" : "DIFFERENT link ✗"}`,
      );

      // Only now commit the contact against the caps, exactly as the simulated
      // loop does — otherwise the contact and budget bounds would be inert here.
      c.contacts++;
      const dayKey = contactDayKey(c.customer.id, now, c.customer.timezoneOffsetMin);
      ctx.contactsByCustomerDay.set(dayKey, (ctx.contactsByCustomerDay.get(dayKey) ?? 0) + 1);
      if (action.kind === "incentive_link") ctx.incentiveSpentPaise += action.incentivePaise ?? 0;

      const recovered = await executor.reconcile(linkId);
      console.log(`    reconciled → recovered=${recovered === "success" ? "true ✓" : "false (awaiting customer payment)"}\n`);
      ledger.append({
        at: Date.now(),
        caseId: c.id,
        type: "reconciliation",
        summary: `Reconciled ${linkId} against Razorpay: ${recovered === "success" ? "PAID — recovery confirmed" : "not yet paid"}.`,
        data: { linkId, result: recovered },
      });

      // Razorpay rate-limits; pace the batch so a demo never trips a 429.
      await new Promise((r) => setTimeout(r, 700));
    }
  } finally {
    // Always persist whatever happened — a mid-run failure must not erase the
    // audit trail for links that were already created.
    writeLedger(ledger);
  }

  console.log(`  ${"─".repeat(72)}`);
  console.log(`  ${created.length} link(s) created · ${deferred} deferred by smart timing · ${blocked} blocked by guardrails · ${ledger.count()} audit events`);
  if (created.length) {
    console.log(`\n  Pay one of these with a Razorpay test card (4111 1111 1111 1111), then re-run`);
    console.log(`  the SAME command (SEED=${SEED}) to watch it reconcile as recovered:`);
    for (const l of created) console.log(`    ${l.url}   ${formatINR(l.amount)}   (${l.id})`);
  }
  console.log(`\n  wrote ${path.relative(process.cwd(), OUT)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
