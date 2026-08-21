// Metrics — turn a finished batch into the honest scorecard the Track 03 bar
// asks for: money recovered across the batch, net of what recovery cost, an
// exception list of what could NOT be resolved, the safety counters that prove
// nothing went wrong with money, and (because the simulator owns ground truth)
// a measured diagnosis-accuracy score.

import type { AtRiskCase, Paise, RootCause } from "@/lib/domain/types";
import type { SafetyStats } from "@/lib/engine/loop";
import { scoreDiagnosis, type DiagnosisReport } from "@/lib/metrics/diagnosis";
import { LLM_COST_PER_DIAGNOSIS } from "@/lib/domain/config";

export interface CauseStat {
  cause: string;
  total: number;
  recovered: number;
  grossRecovered: Paise;
}

export interface TypeStat {
  type: string;
  total: number;
  recovered: number;
  grossRecovered: Paise;
}

export interface ExceptionRow {
  id: string;
  type: string;
  amount: Paise;
  rootCause?: string;
  reason?: string;
  escalated: boolean;
}

/** The segment a naive payment-retry baseline can actually touch. */
export interface SegmentStat {
  total: number;
  recovered: number;
  grossRecoveredPaise: Paise;
  atRiskPaise: Paise;
}

export interface AiUsage {
  /** Cases a real model call classified. */
  llmCalls: number;
  /** Cases whose signal was too unstructured for rules (LLM's territory). */
  llmEligible: number;
  /** Cases answered by deterministic rules alone — no model, no cost. */
  rulesOnly: number;
  llmCostPaise: Paise;
  /** Net recovered per rupee of LLM spend (Infinity when no LLM was used). */
  netPerLlmRupee: number;
}

export interface Report {
  totalCases: number;
  recovered: number;
  recoveryRate: number; // 0..1
  escalated: number;
  stopped: number;
  awaitingApproval: number;
  totalAtRiskPaise: Paise;
  grossRecoveredPaise: Paise;
  interventionCostPaise: Paise; // messaging + incentives, across ALL cases
  netRecoveredPaise: Paise;
  recoveryRateByValue: number; // grossRecovered / totalAtRisk
  avgAttempts: number;
  avgHoursToRecovery: number;
  byCause: CauseStat[];
  byType: TypeStat[];
  /** payments + subscriptions only — the like-for-like baseline comparison. */
  paymentsSegment: SegmentStat;
  exceptions: ExceptionRow[];
  safety: SafetyStats;
  ai: AiUsage;
  diagnosis?: DiagnosisReport;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const PAY_TYPES = new Set(["payment_failed", "subscription_failed"]);

export function computeReport(
  cases: AtRiskCase[],
  safety: SafetyStats,
  truthRootCause?: Map<string, RootCause>,
): Report {
  const recovered = cases.filter((c) => c.status === "recovered");
  const exceptions = cases.filter((c) => c.status === "exception");
  const escalated = exceptions.filter((c) => (c.exceptionReason ?? "").startsWith("escalated"));
  const awaiting = exceptions.filter((c) => (c.exceptionReason ?? "").includes("awaiting_human"));

  const totalAtRisk = sum(cases.map((c) => c.amount));
  const grossRecovered = sum(recovered.map((c) => c.recoveredAmount ?? 0));
  const interventionCost = sum(cases.map((c) => c.interventionCost ?? 0));

  const causeMap = new Map<string, CauseStat>();
  const typeMap = new Map<string, TypeStat>();
  for (const c of cases) {
    const cause = c.diagnosis?.rootCause ?? "undiagnosed";
    const cs = causeMap.get(cause) ?? { cause, total: 0, recovered: 0, grossRecovered: 0 };
    cs.total++;
    if (c.status === "recovered") {
      cs.recovered++;
      cs.grossRecovered += c.recoveredAmount ?? 0;
    }
    causeMap.set(cause, cs);

    const ts = typeMap.get(c.type) ?? { type: c.type, total: 0, recovered: 0, grossRecovered: 0 };
    ts.total++;
    if (c.status === "recovered") {
      ts.recovered++;
      ts.grossRecovered += c.recoveredAmount ?? 0;
    }
    typeMap.set(c.type, ts);
  }

  const payCases = cases.filter((c) => PAY_TYPES.has(c.type));
  const payRecovered = payCases.filter((c) => c.status === "recovered");
  const paymentsSegment: SegmentStat = {
    total: payCases.length,
    recovered: payRecovered.length,
    grossRecoveredPaise: sum(payRecovered.map((c) => c.recoveredAmount ?? 0)),
    atRiskPaise: sum(payCases.map((c) => c.amount)),
  };

  const attemptsTotal = sum(cases.map((c) => c.attempts.length));
  const hoursToRecovery = recovered
    .filter((c) => c.resolvedAt != null)
    .map((c) => (c.resolvedAt! - c.createdAt) / 3_600_000);

  const llmCalls = cases.filter((c) => c.diagnosis?.source === "llm").length;
  const rulesOnly = cases.length - cases.filter((c) => needsTextPath(c)).length;
  const llmEligible = cases.length - rulesOnly;
  const llmCost = llmCalls * LLM_COST_PER_DIAGNOSIS;
  const net = grossRecovered - interventionCost - llmCost;

  return {
    totalCases: cases.length,
    recovered: recovered.length,
    recoveryRate: cases.length ? recovered.length / cases.length : 0,
    escalated: escalated.length,
    stopped: exceptions.length - escalated.length,
    awaitingApproval: awaiting.length,
    totalAtRiskPaise: totalAtRisk,
    grossRecoveredPaise: grossRecovered,
    interventionCostPaise: interventionCost,
    netRecoveredPaise: net,
    recoveryRateByValue: totalAtRisk ? grossRecovered / totalAtRisk : 0,
    avgAttempts: cases.length ? attemptsTotal / cases.length : 0,
    avgHoursToRecovery: hoursToRecovery.length ? sum(hoursToRecovery) / hoursToRecovery.length : 0,
    byCause: [...causeMap.values()].sort((a, b) => b.grossRecovered - a.grossRecovered),
    byType: [...typeMap.values()].sort((a, b) => b.grossRecovered - a.grossRecovered),
    paymentsSegment,
    exceptions: exceptions.map((c) => ({
      id: c.id,
      type: c.type,
      amount: c.amount,
      rootCause: c.diagnosis?.rootCause,
      reason: c.exceptionReason,
      escalated: (c.exceptionReason ?? "").startsWith("escalated"),
    })),
    safety,
    ai: {
      llmCalls,
      llmEligible,
      rulesOnly,
      llmCostPaise: llmCost,
      netPerLlmRupee: llmCost > 0 ? net / llmCost : Infinity,
    },
    diagnosis: truthRootCause ? scoreDiagnosis(cases, truthRootCause) : undefined,
  };
}

/** Cases with no structured error code — the ones routed to LLM/heuristic. */
function needsTextPath(c: AtRiskCase): boolean {
  return !c.signal.reason && !c.signal.code;
}

export interface BaselineSummary {
  recovered: number;
  recoveryRate: number;
  grossRecoveredPaise: Paise;
  netRecoveredPaise: Paise;
  doubleCharges: number;
}

export function computeBaseline(cases: AtRiskCase[], doubleCharges: number): BaselineSummary {
  const recovered = cases.filter((c) => c.status === "recovered");
  const gross = sum(recovered.map((c) => c.recoveredAmount ?? 0));
  return {
    recovered: recovered.length,
    recoveryRate: cases.length ? recovered.length / cases.length : 0,
    grossRecoveredPaise: gross,
    netRecoveredPaise: gross, // baseline spends nothing on messaging/incentives
    doubleCharges,
  };
}
