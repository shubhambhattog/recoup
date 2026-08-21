// Guardrail fuzz suite.
//
// The safety claims ("0 double-charges", "never contacts after opt-out",
// "never spends past budget") are enforced by construction in the gate — this
// suite is what proves it. It runs the whole pipeline across many random seeds
// AND random policy/chaos configurations, and asserts the invariants hold in
// every single run. A regression anywhere in diagnose → policy → gate → loop
// shows up here as a failing invariant rather than as a quietly wrong number.

import test from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "@/lib/engine/run";
import { DEFAULT_POLICY, type RecoveryPolicy } from "@/lib/domain/config";
import { makeRng } from "@/lib/core/rng";
import { isWithinQuietHours } from "@/lib/core/time";
import type { AtRiskCase } from "@/lib/domain/types";

const FUZZ_RUNS = Number(process.env.FUZZ_RUNS ?? 24);
const CASES = Number(process.env.FUZZ_CASES ?? 60);

function randomPolicy(seed: number): RecoveryPolicy {
  const rng = makeRng(seed ^ 0x51ee);
  return {
    ...DEFAULT_POLICY,
    maxMoneyAttemptsPerCase: rng.int(1, 4),
    maxContactsPerCase: rng.int(1, 5),
    perCustomerDailyContactCap: rng.int(1, 3),
    cooldownMs: rng.int(1, 12) * 60 * 60_000,
    incentiveBudgetPaise: rng.int(0, 40_000) * 100,
    maxIncentivePerCasePaise: rng.int(0, 800) * 100,
    humanApprovalThresholdPaise: rng.int(5_000, 60_000) * 100,
  };
}

function isTerminal(c: AtRiskCase): boolean {
  return c.status === "recovered" || c.status === "exception";
}

test("safety invariants hold across randomized seeds, policies and chaos", async () => {
  for (let i = 0; i < FUZZ_RUNS; i++) {
    const seed = 7_000 + i * 13;
    const rng = makeRng(seed ^ 0xc4a0);
    const policy = randomPolicy(seed);
    const worldConfig = {
      lostConfirmationP: rng.next() * 0.5,
      apiErrorP: rng.next() * 0.4,
      baseOptOutP: rng.next() * 0.2,
    };

    const sc = await runScenario({ seed, n: CASES, policy, worldConfig });
    const where = `seed=${seed}`;
    const r = sc.report;

    // ---- money safety ----
    assert.equal(r.safety.doubleCharges, 0, `${where}: double-charged a customer`);
    assert.equal(r.safety.postOptOutContacts, 0, `${where}: contacted after opt-out`);
    assert.equal(r.safety.quietHoursContacts, 0, `${where}: contacted during quiet hours`);

    // ---- per-case bounds ----
    for (const c of sc.cases) {
      assert.ok(isTerminal(c), `${where}/${c.id}: left non-terminal (${c.status})`);
      assert.ok(
        c.attempts.length <= policy.maxMoneyAttemptsPerCase,
        `${where}/${c.id}: ${c.attempts.length} money attempts > cap ${policy.maxMoneyAttemptsPerCase}`,
      );
      assert.ok(
        c.contacts <= policy.maxContactsPerCase,
        `${where}/${c.id}: ${c.contacts} contacts > cap ${policy.maxContactsPerCase}`,
      );

      // money attempts respect the cooldown and the deadline
      for (let k = 1; k < c.attempts.length; k++) {
        const gap = c.attempts[k].at - c.attempts[k - 1].at;
        assert.ok(gap >= policy.cooldownMs, `${where}/${c.id}: retry gap ${gap}ms < cooldown`);
      }
      for (const a of c.attempts) {
        assert.ok(
          a.at <= c.createdAt + policy.caseDeadlineMs,
          `${where}/${c.id}: money action after the case deadline`,
        );
      }

      // an unknown charge outcome must always have been reconciled
      for (const a of c.attempts) {
        if (a.result === "unknown") {
          assert.ok(
            a.reconciledResult === "success" || a.reconciledResult === "failed",
            `${where}/${c.id}: unknown charge left unreconciled`,
          );
        }
      }

      // recovered means exactly the amount at risk — never more
      if (c.status === "recovered") {
        assert.equal(c.recoveredAmount, c.amount, `${where}/${c.id}: recovered != amount at risk`);
      }

      // hard declines must never be re-charged
      const cause = c.diagnosis?.rootCause;
      if (cause === "risk_declined" || cause === "card_expired" || cause === "b2b_dispute") {
        assert.equal(c.attempts.length, 0, `${where}/${c.id}: retried a hard decline (${cause})`);
      }
    }

    // ---- budget ----
    const incentiveSpend = sc.ledger
      .filter((e) => e.type === "recovered")
      .reduce((s, e) => s + Number((e.data as { incentive?: number } | undefined)?.incentive ?? 0), 0);
    assert.ok(
      incentiveSpend <= policy.incentiveBudgetPaise,
      `${where}: incentive spend ${incentiveSpend} > budget ${policy.incentiveBudgetPaise}`,
    );

    // ---- accounting ----
    assert.equal(
      r.netRecoveredPaise,
      r.grossRecoveredPaise - r.interventionCostPaise - r.ai.llmCostPaise,
      `${where}: net != gross - cost`,
    );
    assert.ok(Number.isInteger(r.grossRecoveredPaise), `${where}: fractional paise in gross`);
    assert.ok(
      r.grossRecoveredPaise <= r.totalAtRiskPaise,
      `${where}: recovered more than was ever at risk`,
    );
  }
});

test("no outbound contact is ever scheduled inside the RBI quiet-hours window", async () => {
  const sc = await runScenario({ seed: 42, n: 120 });
  const { startHour, endHour } = DEFAULT_POLICY.quietHours;
  const byCase = new Map(sc.cases.map((c) => [c.id, c]));

  for (const e of sc.ledger) {
    if (e.type !== "action_executed") continue;
    if (!/Sent (nudge|switch_method_link|incentive_link|promise_to_pay)/.test(e.summary)) continue;
    const c = byCase.get(e.caseId)!;
    assert.equal(
      isWithinQuietHours(e.at, c.customer.timezoneOffsetMin, startHour, endHour),
      false,
      `${e.caseId}: message sent inside quiet hours`,
    );
  }
});

test("the human gate actually blocks high-value money actions when enabled", async () => {
  const manual = await runScenario({ seed: 42, n: 120, humanGate: "manual" });
  const parked = manual.cases.filter((c) => (c.exceptionReason ?? "").includes("awaiting_human"));
  assert.ok(parked.length > 0, "manual gate parked nothing — the gate is not being exercised");

  for (const c of parked) {
    assert.ok(
      c.amount >= DEFAULT_POLICY.humanApprovalThresholdPaise,
      `${c.id}: parked a case below the approval threshold`,
    );
  }

  // Approving them lets exactly those cases proceed past the gate.
  const approved = await runScenario({
    seed: 42,
    n: 120,
    humanGate: "manual",
    approvedCaseIds: parked.map((c) => c.id),
  });
  const stillParked = approved.cases.filter((c) => (c.exceptionReason ?? "").includes("awaiting_human"));
  assert.equal(stillParked.length, 0, "approved cases were still blocked by the gate");
});
