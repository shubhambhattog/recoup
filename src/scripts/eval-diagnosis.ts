// Diagnosis evaluation — measure the AI instead of asserting it.
//
//   npm run eval:diagnosis         # scores the offline heuristic (no key needed)
//   LLM=1 npm run eval:diagnosis   # also scores the configured model, head to head
//
// Because the simulator owns hidden ground truth, we can grade every root-cause
// call. This script scores the deterministic rules, the offline heuristic and
// (when a key is configured) the LLM on the SAME cases, and reports accuracy,
// the confusion pairs, the money sitting behind wrong calls, and the cost of the
// model calls. That is the honest answer to "where is the AI actually helping?"

import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "@/lib/core/env";
loadEnv();

import { generateBatch } from "@/lib/sim/generate";
import { diagnose } from "@/lib/engine/diagnose";
import { scoreDiagnosis } from "@/lib/metrics/diagnosis";
import { getLlm, llmLabel } from "@/lib/ai/llm";
import { formatINR } from "@/lib/core/money";
import { LLM_COST_PER_DIAGNOSIS } from "@/lib/domain/config";
import type { AtRiskCase } from "@/lib/domain/types";

const SEED = Number(process.env.SEED ?? 42);
const N = Number(process.env.N ?? 120);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

async function scoreWith(label: string, cases: AtRiskCase[], useLlm: boolean) {
  const llm = useLlm ? getLlm() : undefined;
  const scored = cases.map((c) => ({ ...c, diagnosis: undefined }) as AtRiskCase);
  let calls = 0;
  for (const c of scored) {
    c.diagnosis = await diagnose(c, llm);
    if (c.diagnosis.source === "llm") calls++;
  }
  return { label, cases: scored, calls };
}

async function main() {
  const { cases, truthRootCause } = generateBatch(SEED, N);
  const useLlm = process.env.LLM === "1" || process.env.LLM === "true";

  console.log(`\n  DIAGNOSIS EVALUATION   seed=${SEED}  cases=${N}`);
  console.log(`  ${"─".repeat(62)}`);
  console.log(`  Ground truth is hidden from the agent; every call is graded against it.\n`);

  const runs = [await scoreWith("rules + offline heuristic", cases, false)];
  if (useLlm) {
    if (!getLlm()) {
      console.log(`  ⚠ LLM=1 was set but no key is configured — skipping the model run.`);
      console.log(`    Add GEMINI_API_KEY to .env.local, then re-run.\n`);
    } else {
      console.log(`  Model: ${llmLabel()}\n`);
      runs.push(await scoreWith(`rules + ${llmLabel()}`, cases, true));
    }
  } else {
    console.log(`  (run with LLM=1 to score the configured model head-to-head)\n`);
  }

  const results = runs.map((r) => ({ ...r, score: scoreDiagnosis(r.cases, truthRootCause) }));

  console.log(`  ${pad("classifier", 34)}${padL("overall", 10)}${padL("rules", 10)}${padL("text path", 12)}${padL("calls", 8)}`);
  for (const r of results) {
    const rules = r.score.byPath.find((p) => p.path === "rules")!;
    const text = r.score.byPath.find((p) => p.path === "llm")!;
    console.log(
      `  ${pad(r.label, 34)}${padL(pct(r.score.accuracy), 10)}${padL(pct(rules.accuracy), 10)}${padL(pct(text.accuracy), 12)}${padL(String(r.calls), 8)}`,
    );
  }

  if (results.length === 2) {
    const [base, withLlm] = results;
    const baseText = base.score.byPath.find((p) => p.path === "llm")!;
    const llmText = withLlm.score.byPath.find((p) => p.path === "llm")!;
    const delta = llmText.accuracy - baseText.accuracy;
    const moneyDelta = base.score.misdiagnosedAmountPaise - withLlm.score.misdiagnosedAmountPaise;
    const cost = withLlm.calls * LLM_COST_PER_DIAGNOSIS;
    console.log(`\n  HEAD TO HEAD (text-only cases — the model's actual territory)`);
    console.log(`    accuracy      ${pct(baseText.accuracy)} → ${pct(llmText.accuracy)}   (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts)`);
    console.log(`    money behind wrong calls  ${formatINR(base.score.misdiagnosedAmountPaise)} → ${formatINR(withLlm.score.misdiagnosedAmountPaise)}   (${moneyDelta >= 0 ? "-" : "+"}${formatINR(Math.abs(moneyDelta))})`);
    console.log(`    model cost    ${formatINR(cost)} for ${withLlm.calls} calls`);
  }

  const worst = results[results.length - 1].score;
  console.log(`\n  TOP CONFUSIONS (${results[results.length - 1].label}) — money-weighted`);
  for (const c of worst.confusions.slice(0, 6)) {
    console.log(`    ${pad(`${c.truth} → ${c.predicted}`, 46)} ${padL(String(c.count), 3)}  ${padL(formatINR(c.amountPaise), 12)}`);
  }
  console.log(`\n  Rules coverage: ${pct(worst.rulesCoverage)} of cases need no model at all.\n`);

  const outDir = path.join(process.cwd(), "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "diagnosis-eval.json"),
    JSON.stringify(
      { seed: SEED, n: N, results: results.map((r) => ({ label: r.label, calls: r.calls, score: r.score })) },
      null,
      2,
    ),
  );
  console.log(`  wrote artifacts/diagnosis-eval.json\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
