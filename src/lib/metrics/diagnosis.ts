// Diagnosis scoring — grade the agent's root-cause calls against hidden truth.
//
// Because the simulator owns ground truth and the agent never sees it, we can
// do something a real production system can only approximate: measure whether
// the diagnosis was actually RIGHT, split by which path produced it (the
// deterministic rules, or the LLM/heuristic used for text-only cases).
//
// This is what turns "we used AI judiciously" from a claim into a number, and
// it is how we compare an LLM against the offline heuristic on identical cases.

import type { AtRiskCase, Paise, RootCause } from "@/lib/domain/types";

export interface PathAccuracy {
  path: "rules" | "llm";
  total: number;
  correct: number;
  accuracy: number; // 0..1
}

export interface Confusion {
  truth: RootCause;
  predicted: RootCause;
  count: number;
  amountPaise: Paise; // money sitting behind this misdiagnosis
}

export interface DiagnosisReport {
  total: number;
  correct: number;
  accuracy: number; // 0..1
  byPath: PathAccuracy[];
  /** Cases whose signal was structured enough for rules (no LLM needed). */
  rulesCoverage: number; // 0..1
  /** Most frequent confusions, worst-money first. */
  confusions: Confusion[];
  /** Money on cases we diagnosed wrong. */
  misdiagnosedAmountPaise: Paise;
}

export function scoreDiagnosis(
  cases: AtRiskCase[],
  truthRootCause: Map<string, RootCause>,
): DiagnosisReport {
  const paths = new Map<"rules" | "llm", { total: number; correct: number }>([
    ["rules", { total: 0, correct: 0 }],
    ["llm", { total: 0, correct: 0 }],
  ]);
  const confusion = new Map<string, Confusion>();
  let correct = 0;
  let total = 0;
  let misdiagnosedAmount = 0;

  for (const c of cases) {
    const truth = truthRootCause.get(c.id);
    const predicted = c.diagnosis?.rootCause;
    if (!truth || !predicted) continue;
    total++;

    // `source` is "rules" for both the deterministic classifier and the offline
    // heuristic fallback; only a real model call is tagged "llm". For scoring we
    // care about which classifier ran, so re-derive: a case the rules could not
    // classify is an LLM-path case regardless of whether a model was wired.
    const path: "rules" | "llm" =
      c.diagnosis?.source === "llm" || isBehavioural(truth) ? "llm" : "rules";
    const bucket = paths.get(path)!;
    bucket.total++;

    if (predicted === truth) {
      correct++;
      bucket.correct++;
    } else {
      misdiagnosedAmount += c.amount;
      const key = `${truth}→${predicted}`;
      const prev = confusion.get(key);
      if (prev) {
        prev.count++;
        prev.amountPaise += c.amount;
      } else {
        confusion.set(key, { truth, predicted, count: 1, amountPaise: c.amount });
      }
    }
  }

  const rulesTotal = paths.get("rules")!.total;

  return {
    total,
    correct,
    accuracy: total ? correct / total : 0,
    byPath: [...paths.entries()].map(([path, v]) => ({
      path,
      total: v.total,
      correct: v.correct,
      accuracy: v.total ? v.correct / v.total : 0,
    })),
    rulesCoverage: total ? rulesTotal / total : 0,
    confusions: [...confusion.values()].sort((a, b) => b.amountPaise - a.amountPaise).slice(0, 8),
    misdiagnosedAmountPaise: misdiagnosedAmount,
  };
}

/** Behavioural losses carry no error code — these are the LLM's territory. */
function isBehavioural(truth: RootCause): boolean {
  return (
    truth === "buyer_price_sensitive" ||
    truth === "buyer_distracted" ||
    truth === "b2b_cashflow" ||
    truth === "b2b_dispute" ||
    truth === "unrecoverable"
  );
}
