// Live mini-batch against REAL Razorpay test-mode APIs.
//
//   npm run razorpay:live            # 6 cases, real Payment Links, real reconcile
//   LIVE_N=10 npm run razorpay:live
//
// This is the proof that "one brain, two hands" is not just a claim: the SAME
// decision loop that produces our measured batch numbers here drives
// RazorpayExecutor instead of the simulator. Every link is created against
// test-mode Razorpay, idempotently (reference_id), and reconciled by fetching
// the link's live status.
//
// Flow for a demo: run it, open a printed link, pay it with a test method, then
// re-run — the reconcile flips that case to `paid`, and the whole thing lands in
// the same append-only ledger as the simulated batch.

import { loadEnv } from "@/lib/core/env";
loadEnv();

import fs from "node:fs";
import path from "node:path";
import { generateBatch } from "@/lib/sim/generate";
import { diagnose } from "@/lib/engine/diagnose";
import { plan } from "@/lib/engine/policy";
import { gate, type GuardContext } from "@/lib/engine/guardrails";
import { RazorpayExecutor } from "@/lib/engine/razorpay-executor";
import { Ledger } from "@/lib/ledger/ledger";
import { DEFAULT_POLICY } from "@/lib/domain/config";
import { razorpayConfigured, isLiveKey, fetchPaymentLink } from "@/lib/razorpay/client";
import { formatINR } from "@/lib/core/money";
import { getLlm } from "@/lib/ai/llm";

const LIVE_N = Number(process.env.LIVE_N ?? 6);
const SEED = Number(process.env.SEED ?? 42);

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
  const executor = new RazorpayExecutor(ledger);
  const llm = getLlm();
  const policy = { ...DEFAULT_POLICY, autoApproveInSim: true };
  const ctx: GuardContext = {
    policy,
    incentiveSpentPaise: 0,
    contactsByCustomerDay: new Map(),
    approve: () => true,
  };

  // Take the same synthetic cases the measured batch uses, but only the ones a
  // Payment Link can genuinely recover (a link is the universal test-mode
  // instrument — we cannot re-charge someone else's card in test mode).
  const { cases } = generateBatch(SEED, 120);
  const linkable = cases
    .filter((c) => c.type !== "payment_failed" || c.signal.reason === "card_expired")
    .slice(0, LIVE_N);

  console.log(`\n  RECOUP — LIVE Razorpay test-mode batch   cases=${linkable.length}`);
  console.log(`  ${"─".repeat(72)}\n`);

  const created: Array<{ id: string; url: string; amount: number; linkId: string }> = [];

  for (const c of linkable) {
    const now = c.createdAt;
    c.diagnosis = await diagnose(c, llm);
    const iv = plan(c, now, policy);
    const decision = gate(c, iv, ctx, now);

    console.log(`  ${c.id}  ${formatINR(c.amount).padStart(12)}  ${c.type}`);
    console.log(`    diagnosed  ${c.diagnosis.rootCause} (${c.diagnosis.source})`);
    console.log(`    planned    ${iv.kind} — ${iv.rationale}`);

    if (!decision.allowed) {
      console.log(`    gate       BLOCKED (${decision.reason}) → no money action taken\n`);
      ledger.append({ at: now, caseId: c.id, type: "gate_blocked", summary: `Blocked ${iv.kind}: ${decision.reason}.` });
      continue;
    }
    if (iv.kind === "escalate_human" || iv.kind === "stop") {
      console.log(`    outcome    ${iv.kind} — correctly no money action\n`);
      ledger.append({ at: now, caseId: c.id, type: "exception", summary: `${iv.kind}: ${iv.rationale}` });
      continue;
    }

    const outcome = await executor.execute(c, iv, now);
    const linkId = outcome.idempotencyKey!;
    const ev = ledger.forCase(c.id).find((e) => e.type === "action_executed");
    const url = String((ev?.data as { shortUrl?: string } | undefined)?.shortUrl ?? "");
    created.push({ id: c.id, url, amount: c.amount, linkId });
    console.log(`    executed   real Razorpay link → ${url}`);

    // Idempotency proof: run the identical step again, expect the same link.
    const again = await executor.execute(c, iv, now);
    const same = again.idempotencyKey === linkId;
    console.log(`    idempotent re-run → ${same ? "SAME link, no duplicate charge ✓" : "DIFFERENT link ✗"}`);

    // Reconcile against Razorpay's live view of the link. `recovered` only
    // becomes true once the customer actually pays it — until then the money is
    // still at risk, which is the honest state to report.
    const live = await fetchPaymentLink(linkId);
    const recovered = await executor.reconcile(linkId);
    console.log(
      `    reconciled Razorpay status="${live?.status ?? "unknown"}" paid=${formatINR(live?.amountPaid ?? 0)}` +
        ` → recovered=${recovered === "success"}${recovered === "success" ? " ✓" : " (awaiting customer payment)"}\n`,
    );
  }

  const outDir = path.join(process.cwd(), "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "live-ledger.jsonl"), ledger.toJSONL());

  console.log(`  ${"─".repeat(72)}`);
  console.log(`  Created ${created.length} real test-mode payment links; ${ledger.count()} audit events.`);
  if (created.length) {
    console.log(`\n  Pay one of these with a Razorpay test method, then re-run to watch it reconcile to "paid":`);
    for (const l of created) console.log(`    ${l.url}   ${formatINR(l.amount)}   (${l.id})`);
  }
  console.log(`\n  wrote artifacts/live-ledger.jsonl\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
