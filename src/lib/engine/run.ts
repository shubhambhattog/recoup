// runScenario — one entry point that runs the agent AND the naive baseline on
// the same generated batch + same world, and returns a fully serializable
// result. Both the CLI (run-batch.ts) and the web API (/api/run) call this, so
// the numbers on the dashboard are exactly the numbers in the terminal.

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

export interface ScenarioOptions {
  seed?: number;
  n?: number;
  policy?: RecoveryPolicy;
  worldConfig?: Partial<WorldConfig>;
  llm?: Llm;
}

export interface ScenarioResult {
  seed: number;
  n: number;
  worldConfig: WorldConfig;
  report: Report;
  baseline: BaselineSummary;
  cases: AtRiskCase[];
  ledger: LedgerEvent[];
}

export async function runScenario(opts: ScenarioOptions = {}): Promise<ScenarioResult> {
  const seed = opts.seed ?? 42;
  const n = opts.n ?? 120;
  const policy = opts.policy ?? DEFAULT_POLICY;
  const worldConfig: WorldConfig = { ...DEFAULT_WORLD_CONFIG, ...opts.worldConfig };

  // Agent run.
  const { cases, truth } = generateBatch(seed, n);
  const agentWorld = new World(truth, worldConfig, makeRng((seed ^ 0xa6e7) >>> 0));
  const ledger = new Ledger();
  const exec = new SimExecutor(agentWorld, ledger);
  const result = await runRecovery(cases, exec, {
    policy,
    ledger,
    llm: opts.llm,
    getDoubleCharges: () => agentWorld.doubleCharges,
  });
  const report = computeReport(result.cases, result.safety);

  // Baseline run — identical cases, fresh world.
  const { cases: baseCases, truth: baseTruth } = generateBatch(seed, n);
  const baseWorld = new World(baseTruth, worldConfig, makeRng((seed ^ 0xb33f) >>> 0));
  runBaseline(baseCases, baseWorld);
  const baseline = computeBaseline(baseCases, baseWorld.doubleCharges);

  return {
    seed,
    n,
    worldConfig,
    report,
    baseline,
    cases: result.cases,
    ledger: [...ledger.all()],
  };
}
