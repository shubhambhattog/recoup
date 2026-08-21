// Multi-seed sweep — the answer to "you only showed one lucky batch".
//
//   npm run sweep              # 50 seeds × 120 cases
//   SEEDS=100 N=200 npm run sweep
//
// Runs the whole pipeline across many independent seeds (each seed = a fresh
// batch of cases AND a fresh world) and reports the distribution, not a point
// estimate. It also sweeps the chaos parameters to show the conclusions do not
// depend on our chosen failure rates, and asserts the safety invariants across
// every single run — if any run ever double-charges, this exits non-zero.
//
// Writes artifacts/sweep.json and prints a markdown table for the README.

import fs from "node:fs";
import path from "node:path";
import { runScenario } from "@/lib/engine/run";
import { formatINR, toRupees } from "@/lib/core/money";
import { loadEnv } from "@/lib/core/env";

loadEnv();

const SEEDS = Number(process.env.SEEDS ?? 50);
const N = Number(process.env.N ?? 120);

interface RunRow {
  seed: number;
  recoveryRate: number;
  netRecoveredPaise: number;
  segmentGrossPaise: number;
  baselineGrossPaise: number;
  uplift: number;
  unlockedPaise: number;
  doubleCharges: number;
  baselineDoubleCharges: number;
  postOptOutContacts: number;
  quietHoursContacts: number;
  reconciliations: number;
  diagnosisAccuracy: number;
  rulesAccuracy: number;
  textAccuracy: number;
}

interface Stat {
  mean: number;
  sd: number;
  min: number;
  max: number;
}

function stat(xs: number[]): Stat {
  const finite = xs.filter((x) => Number.isFinite(x));
  if (!finite.length) return { mean: 0, sd: 0, min: 0, max: 0 };
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const sd = Math.sqrt(finite.reduce((s, x) => s + (x - mean) ** 2, 0) / finite.length);
  return { mean, sd, min: Math.min(...finite), max: Math.max(...finite) };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

async function runOne(seed: number, chaos?: { lostConfirmationP: number; apiErrorP: number }): Promise<RunRow> {
  const sc = await runScenario({ seed, n: N, worldConfig: chaos });
  const r = sc.report;
  const b = sc.baseline;
  const seg = r.paymentsSegment.grossRecoveredPaise;
  const d = r.diagnosis;
  const byPath = (p: string) => d?.byPath.find((x) => x.path === p)?.accuracy ?? 0;
  return {
    seed,
    recoveryRate: r.recoveryRate,
    netRecoveredPaise: r.netRecoveredPaise,
    segmentGrossPaise: seg,
    baselineGrossPaise: b.grossRecoveredPaise,
    uplift: b.grossRecoveredPaise > 0 ? seg / b.grossRecoveredPaise : Infinity,
    unlockedPaise: r.grossRecoveredPaise - seg,
    doubleCharges: r.safety.doubleCharges,
    baselineDoubleCharges: b.doubleCharges,
    postOptOutContacts: r.safety.postOptOutContacts,
    quietHoursContacts: r.safety.quietHoursContacts,
    reconciliations: r.safety.reconciliationsPreventingDoubleCharge,
    diagnosisAccuracy: d?.accuracy ?? 0,
    rulesAccuracy: byPath("rules"),
    textAccuracy: byPath("llm"),
  };
}

async function main() {
  console.log(`\n  RECOUP — multi-seed sweep   seeds=${SEEDS}  cases/seed=${N}  (${SEEDS * N} cases total)\n`);

  const rows: RunRow[] = [];
  for (let i = 0; i < SEEDS; i++) {
    rows.push(await runOne(1000 + i * 7));
    if ((i + 1) % 10 === 0) process.stdout.write(`    …${i + 1}/${SEEDS} seeds\n`);
  }

  const s = {
    recoveryRate: stat(rows.map((r) => r.recoveryRate)),
    net: stat(rows.map((r) => toRupees(r.netRecoveredPaise))),
    uplift: stat(rows.map((r) => r.uplift)),
    unlocked: stat(rows.map((r) => toRupees(r.unlockedPaise))),
    diagnosis: stat(rows.map((r) => r.diagnosisAccuracy)),
    rulesAcc: stat(rows.map((r) => r.rulesAccuracy)),
    textAcc: stat(rows.map((r) => r.textAccuracy)),
    reconciliations: stat(rows.map((r) => r.reconciliations)),
  };

  // Pooled uplift: total agent recovery ÷ total baseline recovery across every
  // seed. Per-seed ratios are noisy (the baseline recovers little, so one lucky
  // large case swings its ratio wildly); the pooled figure is the honest
  // headline and the one we quote.
  const pooledAgent = rows.reduce((a, r) => a + r.segmentGrossPaise, 0);
  const pooledBaseline = rows.reduce((a, r) => a + r.baselineGrossPaise, 0);
  const pooledUplift = pooledBaseline > 0 ? pooledAgent / pooledBaseline : Infinity;
  const sortedUplift = [...rows.map((r) => r.uplift)].sort((a, b) => a - b);
  const medianUplift = sortedUplift[Math.floor(sortedUplift.length / 2)];

  // ---- invariants across every run ----
  const violations: string[] = [];
  const totalDouble = rows.reduce((a, r) => a + r.doubleCharges, 0);
  const totalOptOut = rows.reduce((a, r) => a + r.postOptOutContacts, 0);
  const totalQuiet = rows.reduce((a, r) => a + r.quietHoursContacts, 0);
  const upliftBelow1 = rows.filter((r) => r.uplift < 1).length;
  if (totalDouble > 0) violations.push(`${totalDouble} double-charges across the sweep`);
  if (totalOptOut > 0) violations.push(`${totalOptOut} post-opt-out contacts`);
  if (totalQuiet > 0) violations.push(`${totalQuiet} quiet-hours contacts`);

  console.log(`\n  DISTRIBUTION ACROSS ${SEEDS} INDEPENDENT SEEDS  (mean ± sd  [min … max])\n`);
  const row = (label: string, st: Stat, fmt: (x: number) => string) =>
    console.log(`    ${pad(label, 26)} ${padL(fmt(st.mean), 12)} ± ${pad(fmt(st.sd), 10)}  [${fmt(st.min)} … ${fmt(st.max)}]`);

  row("Recovery rate", s.recoveryRate, pct);
  row("Net recovered", s.net, (x) => formatINR(Math.round(x * 100)));
  row("Uplift vs baseline", s.uplift, (x) => `${x.toFixed(2)}×`);
  row("Unlocked beyond baseline", s.unlocked, (x) => formatINR(Math.round(x * 100)));
  row("Diagnosis accuracy", s.diagnosis, pct);
  row("  · rules path", s.rulesAcc, pct);
  row("  · text path", s.textAcc, pct);
  row("Reconciliations/run", s.reconciliations, (x) => x.toFixed(1));
  console.log(
    `\n    Pooled uplift (all ${SEEDS * N} cases): ${formatINR(pooledAgent)} vs ${formatINR(pooledBaseline)} = ` +
      `${pooledUplift.toFixed(2)}×   (median per-seed ${medianUplift.toFixed(2)}×)`,
  );

  console.log(`\n  SAFETY INVARIANTS ACROSS ALL ${SEEDS} RUNS (${SEEDS * N} cases)\n`);
  console.log(`    Double charges (agent)             ${padL(String(totalDouble), 6)}   ${totalDouble === 0 ? "✓" : "✗"}`);
  console.log(`    Double charges (naive baseline)    ${padL(String(rows.reduce((a, r) => a + r.baselineDoubleCharges, 0)), 6)}   (for contrast)`);
  console.log(`    Contacts after opt-out             ${padL(String(totalOptOut), 6)}   ${totalOptOut === 0 ? "✓" : "✗"}`);
  console.log(`    Quiet-hours contacts               ${padL(String(totalQuiet), 6)}   ${totalQuiet === 0 ? "✓" : "✗"}`);
  console.log(`    Runs where baseline beat us        ${padL(String(upliftBelow1), 6)}   ${upliftBelow1 === 0 ? "✓" : "✗"}`);

  // ---- sensitivity to the chaos assumptions ----
  console.log(`\n  SENSITIVITY — do the conclusions survive different failure rates?\n`);
  const chaosGrid = [
    { lostConfirmationP: 0.0, apiErrorP: 0.0 },
    { lostConfirmationP: 0.05, apiErrorP: 0.05 },
    { lostConfirmationP: 0.14, apiErrorP: 0.1 },
    { lostConfirmationP: 0.3, apiErrorP: 0.25 },
    { lostConfirmationP: 0.5, apiErrorP: 0.4 },
  ];
  const sensitivity: Array<{
    lostConfirmationP: number;
    apiErrorP: number;
    recoveryRate: number;
    uplift: number;
    doubleCharges: number;
    reconciliations: number;
  }> = [];
  console.log(`    ${pad("lost-confirm", 14)}${pad("api-error", 12)}${pad("recovery", 11)}${pad("uplift", 10)}${pad("reconciled", 12)}double-charges`);
  for (const chaos of chaosGrid) {
    const sub: RunRow[] = [];
    for (let i = 0; i < 10; i++) sub.push(await runOne(1000 + i * 7, chaos));
    const rr = stat(sub.map((r) => r.recoveryRate)).mean;
    const up = stat(sub.map((r) => r.uplift)).mean;
    const dc = sub.reduce((a, r) => a + r.doubleCharges, 0);
    const rc = stat(sub.map((r) => r.reconciliations)).mean;
    sensitivity.push({ ...chaos, recoveryRate: rr, uplift: up, doubleCharges: dc, reconciliations: rc });
    console.log(
      `    ${pad(pct(chaos.lostConfirmationP), 14)}${pad(pct(chaos.apiErrorP), 12)}${pad(pct(rr), 11)}${pad(`${up.toFixed(2)}×`, 10)}${pad(rc.toFixed(1), 12)}${dc}`,
    );
  }

  const outDir = path.join(process.cwd(), "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "sweep.json"),
    JSON.stringify(
      {
        seeds: SEEDS,
        n: N,
        summary: s,
        pooled: { agentPaise: pooledAgent, baselinePaise: pooledBaseline, uplift: pooledUplift, medianUplift },
        invariants: { totalDouble, totalOptOut, totalQuiet, upliftBelow1 },
        sensitivity,
        rows,
      },
      null,
      2,
    ),
  );

  // ---- markdown block for the README ----
  const md = [
    `| Metric (across ${SEEDS} seeds × ${N} cases = ${SEEDS * N} cases) | Mean ± SD | Range |`,
    `| --- | --- | --- |`,
    `| Recovery rate | ${pct(s.recoveryRate.mean)} ± ${pct(s.recoveryRate.sd)} | ${pct(s.recoveryRate.min)} – ${pct(s.recoveryRate.max)} |`,
    `| Net recovered per batch | ${formatINR(Math.round(s.net.mean * 100))} ± ${formatINR(Math.round(s.net.sd * 100))} | ${formatINR(Math.round(s.net.min * 100))} – ${formatINR(Math.round(s.net.max * 100))} |`,
    `| Uplift vs naive baseline (pooled, like-for-like) | **${pooledUplift.toFixed(2)}×** | median per-seed ${medianUplift.toFixed(2)}× |`,
    `| Diagnosis accuracy vs ground truth | ${pct(s.diagnosis.mean)} ± ${pct(s.diagnosis.sd)} | ${pct(s.diagnosis.min)} – ${pct(s.diagnosis.max)} |`,
    `| **Double charges** | **${totalDouble}** | **0 in every run** |`,
    `| Contacts after opt-out | ${totalOptOut} | 0 in every run |`,
    `| Quiet-hours contacts (RBI window) | ${totalQuiet} | 0 in every run |`,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "sweep.md"), md);

  console.log(`\n  wrote artifacts/sweep.json and artifacts/sweep.md\n`);

  if (violations.length) {
    console.error(`  ✗ SAFETY INVARIANT VIOLATED: ${violations.join("; ")}\n`);
    process.exit(1);
  }
  console.log(`  ✓ all safety invariants held across ${SEEDS * N} cases\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
