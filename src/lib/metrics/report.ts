// Metrics — turn a finished batch into the honest scorecard the Track 03 bar
// asks for: money recovered across the batch, net of what recovery cost, an
// exception list of what could NOT be resolved, and the safety counters that
// prove nothing went wrong with money.

import type { AtRiskCase, Paise } from "@/lib/domain/types";
import type { SafetyStats } from "@/lib/engine/loop";

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

export interface Report {
  totalCases: number;
  recovered: number;
  recoveryRate: number; // 0..1
  escalated: number;
  stopped: number;
  totalAtRiskPaise: Paise;
  grossRecoveredPaise: Paise;
  interventionCostPaise: Paise; // messaging + incentives, across ALL cases (incl. wasted)
  netRecoveredPaise: Paise;
  recoveryRateByValue: number; // grossRecovered / totalAtRisk
  avgAttempts: number;
  avgHoursToRecovery: number;
  byCause: CauseStat[];
  byType: TypeStat[];
  exceptions: ExceptionRow[];
  safety: SafetyStats;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export function computeReport(cases: AtRiskCase[], safety: SafetyStats): Report {
  const recovered = cases.filter((c) => c.status === "recovered");
  const exceptions = cases.filter((c) => c.status === "exception");
  const escalated = exceptions.filter((c) => (c.exceptionReason ?? "").startsWith("escalated"));

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

  const attemptsTotal = sum(cases.map((c) => c.attempts.length));
  const hoursToRecovery = recovered
    .filter((c) => c.resolvedAt != null)
    .map((c) => (c.resolvedAt! - c.createdAt) / 3_600_000);

  return {
    totalCases: cases.length,
    recovered: recovered.length,
    recoveryRate: cases.length ? recovered.length / cases.length : 0,
    escalated: escalated.length,
    stopped: exceptions.length - escalated.length,
    totalAtRiskPaise: totalAtRisk,
    grossRecoveredPaise: grossRecovered,
    interventionCostPaise: interventionCost,
    netRecoveredPaise: grossRecovered - interventionCost,
    recoveryRateByValue: totalAtRisk ? grossRecovered / totalAtRisk : 0,
    avgAttempts: cases.length ? attemptsTotal / cases.length : 0,
    avgHoursToRecovery: hoursToRecovery.length ? sum(hoursToRecovery) / hoursToRecovery.length : 0,
    byCause: [...causeMap.values()].sort((a, b) => b.grossRecovered - a.grossRecovered),
    byType: [...typeMap.values()].sort((a, b) => b.grossRecovered - a.grossRecovered),
    exceptions: exceptions.map((c) => ({
      id: c.id,
      type: c.type,
      amount: c.amount,
      rootCause: c.diagnosis?.rootCause,
      reason: c.exceptionReason,
      escalated: (c.exceptionReason ?? "").startsWith("escalated"),
    })),
    safety,
  };
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
