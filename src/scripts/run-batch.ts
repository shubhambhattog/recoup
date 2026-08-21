// Headless batch runner — the reproducible proof.
//
//   npm run recover:batch            # seed 42, 120 cases
//   SEED=7 N=200 npm run recover:batch
//   LLM=1 npm run recover:batch      # use the configured LLM for ambiguous diagnosis
//   GATE=manual npm run recover:batch # make the human-approval gate real
//
// Runs the agent and the naive baseline on the SAME generated cases and world,
// prints the scorecard, and writes artifacts/ledger.jsonl (the full audit
// trail) and artifacts/report.json.

import fs from "node:fs";
import path from "node:path";
import { runScenario } from "@/lib/engine/run";
import type { Report, BaselineSummary } from "@/lib/metrics/report";
import { formatINR } from "@/lib/core/money";
import { getLlm, llmLabel } from "@/lib/ai/llm";
import { loadEnv } from "@/lib/core/env";

loadEnv();

const SEED = Number(process.env.SEED ?? 42);
const N = Number(process.env.N ?? 120);
const GATE = process.env.GATE === "manual" ? "manual" : "auto";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

function printReport(r: Report, b: BaselineSummary) {
  const line = "─".repeat(66);
  console.log(`\n${line}`);
  console.log(`  RECOUP — revenue recovery batch   seed=${SEED}  cases=${r.totalCases}  gate=${GATE}`);
  console.log(line);

  console.log(`\n  MONEY`);
  console.log(`    At risk (batch)      ${padL(formatINR(r.totalAtRiskPaise), 16)}`);
  console.log(`    Gross recovered      ${padL(formatINR(r.grossRecoveredPaise), 16)}   (${pct(r.recoveryRateByValue)} of value)`);
  console.log(`    Intervention cost    ${padL("-" + formatINR(r.interventionCostPaise), 16)}   (messaging + incentives, incl. wasted)`);
  console.log(`    AI cost              ${padL("-" + formatINR(r.ai.llmCostPaise), 16)}   (${r.ai.llmCalls} model calls)`);
  console.log(`    Net recovered        ${padL(formatINR(r.netRecoveredPaise), 16)}`);

  console.log(`\n  THROUGHPUT`);
  console.log(`    Recovered            ${padL(`${r.recovered}/${r.totalCases}`, 16)}   (${pct(r.recoveryRate)})`);
  console.log(`    Escalated to human   ${padL(String(r.escalated), 16)}`);
  console.log(`    Awaiting approval    ${padL(String(r.awaitingApproval), 16)}`);
  console.log(`    Stopped (unrecov.)   ${padL(String(r.stopped), 16)}`);
  console.log(`    Avg attempts/case    ${padL(r.avgAttempts.toFixed(2), 16)}`);
  console.log(`    Avg time-to-recover  ${padL(`${r.avgHoursToRecovery.toFixed(1)}h`, 16)}`);

  if (r.diagnosis) {
    const d = r.diagnosis;
    console.log(`\n  DIAGNOSIS ACCURACY  (scored against hidden ground truth)`);
    console.log(`    Overall              ${padL(`${d.correct}/${d.total}`, 10)} ${padL(pct(d.accuracy), 8)}`);
    for (const p of d.byPath) {
      const label = p.path === "rules" ? "rules (error codes)" : "text path (LLM/heuristic)";
      console.log(`    ${pad(label, 21)}${padL(`${p.correct}/${p.total}`, 10)} ${padL(pct(p.accuracy), 8)}`);
    }
    console.log(`    Rules coverage       ${padL(pct(d.rulesCoverage), 19)}   (share needing no model at all)`);
    if (d.confusions.length) {
      console.log(`    Top confusions:`);
      for (const c of d.confusions.slice(0, 4)) {
        console.log(`      ${pad(`${c.truth} → ${c.predicted}`, 42)} ${padL(String(c.count), 3)}  ${padL(formatINR(c.amountPaise), 12)}`);
      }
    }
  }

  console.log(`\n  AI USAGE  (right tool, right place)`);
  console.log(`    Rules-only cases     ${padL(`${r.ai.rulesOnly}/${r.totalCases}`, 16)}   (no model needed — error code answers it)`);
  console.log(`    Text-path cases      ${padL(`${r.ai.llmEligible}/${r.totalCases}`, 16)}   (ambiguous — model's territory)`);
  console.log(`    Model calls made     ${padL(String(r.ai.llmCalls), 16)}`);
  if (r.ai.llmCalls > 0) {
    console.log(`    Net per ₹1 of AI     ${padL(`₹${r.ai.netPerLlmRupee.toFixed(0)}`, 16)}`);
  }

  console.log(`\n  RECOVERY BY ROOT CAUSE`);
  for (const c of r.byCause) {
    console.log(`    ${pad(c.cause, 22)} ${padL(`${c.recovered}/${c.total}`, 8)}  ${padL(formatINR(c.grossRecovered), 14)}`);
  }

  console.log(`\n  RECOVERY BY LOSS TYPE`);
  for (const t of r.byType) {
    console.log(`    ${pad(t.type, 22)} ${padL(`${t.recovered}/${t.total}`, 8)}  ${padL(formatINR(t.grossRecovered), 14)}`);
  }

  console.log(`\n  SAFETY  (all must be zero except reconciliations)`);
  console.log(`    Double charges                    ${padL(String(r.safety.doubleCharges), 6)}`);
  console.log(`    Lost-confirmations reconciled     ${padL(String(r.safety.reconciliationsPreventingDoubleCharge), 6)}   (double-charges prevented)`);
  console.log(`    Contacts after opt-out            ${padL(String(r.safety.postOptOutContacts), 6)}`);
  console.log(`    Quiet-hours contacts              ${padL(String(r.safety.quietHoursContacts), 6)}   (RBI 19:00–08:00 window)`);
  console.log(`    Overspend attempts blocked        ${padL(String(r.safety.overspendBlocked), 6)}`);

  const seg = r.paymentsSegment;
  const unlocked = r.grossRecoveredPaise - seg.grossRecoveredPaise;
  const mult = b.grossRecoveredPaise > 0 ? seg.grossRecoveredPaise / b.grossRecoveredPaise : Infinity;

  console.log(`\n  AGENT vs NAIVE BASELINE  (baseline = retry 3× immediately, no diagnosis)`);
  console.log(`    Like-for-like — payments & subscriptions only (all a naive retry can touch):`);
  console.log(`      agent     ${padL(`${seg.recovered}/${seg.total}`, 8)}  ${padL(formatINR(seg.grossRecoveredPaise), 14)}`);
  console.log(
    `      baseline  ${padL(`${b.recovered}/${seg.total}`, 8)}  ${padL(formatINR(b.grossRecoveredPaise), 14)}` +
      (Number.isFinite(mult) ? `   → ${mult.toFixed(1)}× on the SAME cases` : ""),
  );
  console.log(`    Plus Recoup unlocks carts + invoices the baseline ignores entirely:  +${formatINR(unlocked)}`);
  console.log(
    `    Double charges:  agent ${r.safety.doubleCharges}   baseline ${b.doubleCharges}` +
      `   (Recoup reconciled ${r.safety.reconciliationsPreventingDoubleCharge} lost confirmations)`,
  );

  console.log(`\n  EXCEPTIONS (could not auto-resolve) — ${r.exceptions.length} of ${r.totalCases}`);
  for (const e of r.exceptions.slice(0, 10)) {
    console.log(`    ${pad(e.id, 12)} ${pad(e.type, 20)} ${pad(e.rootCause ?? "-", 20)} ${padL(formatINR(e.amount), 12)}  ${e.reason}`);
  }
  if (r.exceptions.length > 10) console.log(`    … and ${r.exceptions.length - 10} more (see artifacts/report.json)`);
  console.log(`\n${line}\n`);
}

async function main() {
  const useLlm = process.env.LLM === "1" || process.env.LLM === "true";
  const llm = useLlm ? getLlm() : undefined;
  console.log(`  diagnosis: ${useLlm ? llmLabel() : "offline heuristic (deterministic, no key needed)"}`);

  const sc = await runScenario({ seed: SEED, n: N, llm, humanGate: GATE });
  printReport(sc.report, sc.baseline);

  const outDir = path.join(process.cwd(), "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "ledger.jsonl"), sc.ledger.map((e) => JSON.stringify(e)).join("\n"));
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    JSON.stringify({ seed: sc.seed, n: sc.n, gate: sc.humanGate, report: sc.report, baseline: sc.baseline }, null, 2),
  );
  console.log(`  wrote artifacts/ledger.jsonl (${sc.ledger.length} events) and artifacts/report.json\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
