// runScenario — one entry point that runs the agent AND the naive baseline on
// the same generated batch + same world, and returns a fully serializable
// result. The CLI (run-batch.ts), the sweep, the tests and the web API all call
// this, so the numbers on the dashboard are exactly the numbers in the terminal.

import { generateBatch } from "@/lib/sim/generate";
import { World, DEFAULT_WORLD_CONFIG, type WorldConfig } from "@/lib/sim/world";
import { makeRng } from "@/lib/core/rng";
import { Ledger, type LedgerEvent } from "@/lib/ledger/ledger";
import { SimExecutor } from "@/lib/engine/executor";
import { runRecovery } from "@/lib/engine/loop";
import { runBaseline } from "@/lib/engine/baseline";
import { DEFAULT_POLICY, type RecoveryPolicy } from "@/lib/domain/config";
import {
  computeReport,
  computeBaseline,
  type Report,
  type BaselineSummary,
} from "@/lib/metrics/report";
import type { AtRiskCase } from "@/lib/domain/types";
import type { Llm } from "@/lib/ai/types";

export type HumanGate = "auto" | "manual";

export interface ScenarioOptions {
  seed?: number;
  n?: number;
  policy?: RecoveryPolicy;
  worldConfig?: Partial<WorldConfig>;
  llm?: Llm;
  /**
   * "auto" (default) uses the mock approver so a headless batch completes.
   * "manual" makes the human gate real: high-value money actions park as
   * `awaiting_human` unless the case id is in `approvedCaseIds`.
   */
  humanGate?: HumanGate;
  approvedCaseIds?: string[];
}

export interface ScenarioResult {
  seed: number;
  n: number;
  worldConfig: WorldConfig;
  humanGate: HumanGate;
  approvedCaseIds: string[];
  report: Report;
  baseline: BaselineSummary;
  cases: AtRiskCase[];
  ledger: LedgerEvent[];
}

export async function runScenario(opts: ScenarioOptions = {}): Promise<ScenarioResult> {
  const seed = opts.seed ?? 42;
  const n = opts.n ?? 120;
  const humanGate = opts.humanGate ?? "auto";
  const approvedCaseIds = opts.approvedCaseIds ?? [];
  const basePolicy = opts.policy ?? DEFAULT_POLICY;
  const policy: RecoveryPolicy = { ...basePolicy, autoApproveInSim: humanGate === "auto" };
  const worldConfig: WorldConfig = { ...DEFAULT_WORLD_CONFIG, ...opts.worldConfig };

  // Agent run.
  const { cases, truth, truthRootCause } = generateBatch(seed, n);
  const agentWorld = new World(truth, worldConfig, makeRng((seed ^ 0xa6e7) >>> 0));
  const ledger = new Ledger();
  const exec = new SimExecutor(agentWorld, ledger);
  const result = await runRecovery(cases, exec, {
    policy,
    ledger,
    llm: opts.llm,
    approvedCaseIds: new Set(approvedCaseIds),
    getDoubleCharges: () => agentWorld.doubleCharges,
  });
  const report = computeReport(result.cases, result.safety, truthRootCause);

  // Baseline run — identical cases, fresh world.
  const { cases: baseCases, truth: baseTruth } = generateBatch(seed, n);
  const baseWorld = new World(baseTruth, worldConfig, makeRng((seed ^ 0xb33f) >>> 0));
  runBaseline(baseCases, baseWorld);
  const baseline = computeBaseline(baseCases, baseWorld.doubleCharges);

  return {
    seed,
    n,
    worldConfig,
    humanGate,
    approvedCaseIds,
    report,
    baseline,
    cases: result.cases,
    ledger: [...ledger.all()],
  };
}
