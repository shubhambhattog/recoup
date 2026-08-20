// Headless batch runner — the reproducible proof.
//
//   npm run recover:batch            # seed 42, 120 cases
//   SEED=7 N=200 npm run recover:batch
//   LLM=1 npm run recover:batch      # use the configured LLM for ambiguous diagnosis
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

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

function printReport(r: Report, b: BaselineSummary) {
  const line = "─".repeat(64);
  console.log(`\n${line}`);
  console.log(`  RECOUP — revenue recovery batch   seed=${SEED}  cases=${r.totalCases}`);
  console.log(line);

  console.log(`\n  MONEY`);
  console.log(`    At risk (batch)      ${padL(formatINR(r.totalAtRiskPaise), 16)}`);
  console.log(`    Gross recovered      ${padL(formatINR(r.grossRecoveredPaise), 16)}   (${pct(r.recoveryRateByValue)} of value)`);
  console.log(`    Intervention cost    ${padL("-" + formatINR(r.interventionCostPaise), 16)}   (messaging + incentives, incl. wasted)`);
  console.log(`    Net recovered        ${padL(formatINR(r.netRecoveredPaise), 16)}`);

  console.log(`\n  THROUGHPUT`);
  console.log(`    Recovered            ${padL(`${r.recovered}/${r.totalCases}`, 16)}   (${pct(r.recoveryRate)})`);
  console.log(`    Escalated to human   ${padL(String(r.escalated), 16)}`);
  console.log(`    Stopped (unrecov.)   ${padL(String(r.stopped), 16)}`);
  console.log(`    Avg attempts/case    ${padL(r.avgAttempts.toFixed(2), 16)}`);
  console.log(`    Avg time-to-recover  ${padL(`${r.avgHoursToRecovery.toFixed(1)}h`, 16)}`);

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
  console.log(`    Quiet-hours contacts              ${padL(String(r.safety.quietHoursContacts), 6)}`);
  console.log(`    Overspend attempts blocked        ${padL(String(r.safety.overspendBlocked), 6)}`);

  // Fair comparison: restrict to what a naive payment-retry can even touch.
  const payTypes = new Set(["payment_failed", "subscription_failed"]);
  const ap = r.byType.filter((t) => payTypes.has(t.type));
  const apRecovered = ap.reduce((s, t) => s + t.recovered, 0);
  const apTotal = ap.reduce((s, t) => s + t.total, 0);
  const apGross = ap.reduce((s, t) => s + t.grossRecovered, 0);
  const unlocked = r.grossRecoveredPaise - apGross;
  const llMult = b.grossRecoveredPaise > 0 ? apGross / b.grossRecoveredPaise : Infinity;

  console.log(`\n  AGENT vs NAIVE BASELINE  (baseline = retry 3× immediately, no diagnosis)`);
  console.log(`    Like-for-like — payments & subscriptions only (all a naive retry can touch):`);
  console.log(`      agent     ${padL(`${apRecovered}/${apTotal}`, 8)}  ${padL(formatINR(apGross), 14)}`);
  console.log(
    `      baseline  ${padL(`${b.recovered}/${apTotal}`, 8)}  ${padL(formatINR(b.grossRecoveredPaise), 14)}` +
      (Number.isFinite(llMult) ? `   → ${llMult.toFixed(1)}× on the SAME cases` : ""),
  );
  console.log(`    Plus Recoup unlocks carts + invoices the baseline ignores entirely:  +${formatINR(unlocked)}`);
  console.log(
    `    Double charges:  agent ${r.safety.doubleCharges}   baseline ${b.doubleCharges}` +
      `   (Recoup reconciled ${r.safety.reconciliationsPreventingDoubleCharge} lost confirmations → ${r.safety.reconciliationsPreventingDoubleCharge} double-charges prevented)`,
  );

  console.log(`\n  EXCEPTIONS (could not auto-resolve) — ${r.exceptions.length} of ${r.totalCases}`);
  for (const e of r.exceptions.slice(0, 12)) {
    console.log(`    ${pad(e.id, 12)} ${pad(e.type, 20)} ${pad(e.rootCause ?? "-", 20)} ${padL(formatINR(e.amount), 12)}  ${e.reason}`);
  }
  if (r.exceptions.length > 12) console.log(`    … and ${r.exceptions.length - 12} more (see artifacts/report.json)`);
  console.log(`\n${line}\n`);
}

async function main() {
  const useLlm = process.env.LLM === "1" || process.env.LLM === "true";
  const llm = useLlm ? getLlm() : undefined;
  console.log(`  diagnosis: ${useLlm ? llmLabel() : "offline heuristic (deterministic, no key needed)"}`);

  const sc = await runScenario({ seed: SEED, n: N, llm });
  printReport(sc.report, sc.baseline);

  const outDir = path.join(process.cwd(), "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "ledger.jsonl"), sc.ledger.map((e) => JSON.stringify(e)).join("\n"));
  fs.writeFileSync(
    path.join(outDir, "report.json"),
    JSON.stringify({ seed: sc.seed, n: sc.n, report: sc.report, baseline: sc.baseline }, null, 2),
  );
  console.log(`  wrote artifacts/ledger.jsonl (${sc.ledger.length} events) and artifacts/report.json\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
