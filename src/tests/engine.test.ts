// Engine unit + property tests: determinism, the deterministic classifier, the
// policy ladder's judgement calls, money arithmetic, and the claim that the
// agent beats the naive baseline on the cases the baseline can actually touch.

import test from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "@/lib/engine/run";
import { diagnoseByRules } from "@/lib/engine/diagnose";
import { plan } from "@/lib/engine/policy";
import { DEFAULT_POLICY } from "@/lib/domain/config";
import { makeRng } from "@/lib/core/rng";
import { formatINR, rupees, toRupees } from "@/lib/core/money";
import { isWithinQuietHours, nextAllowedContactTime, localHour } from "@/lib/core/time";
import type { AtRiskCase, Diagnosis, FailureSignal } from "@/lib/domain/types";

// ---------- determinism ----------

test("the same seed produces byte-identical results", async () => {
  const a = await runScenario({ seed: 99, n: 80 });
  const b = await runScenario({ seed: 99, n: 80 });
  assert.deepEqual(a.report, b.report, "report differed between identical runs");
  assert.equal(JSON.stringify(a.ledger), JSON.stringify(b.ledger), "ledger differed");
});

test("different seeds produce different batches", async () => {
  const a = await runScenario({ seed: 1, n: 80 });
  const b = await runScenario({ seed: 2, n: 80 });
  assert.notEqual(a.report.grossRecoveredPaise, b.report.grossRecoveredPaise);
});

test("the seeded rng is reproducible and well-formed", () => {
  const a = makeRng(123);
  const b = makeRng(123);
  for (let i = 0; i < 200; i++) {
    const x = a.next();
    assert.equal(x, b.next());
    assert.ok(x >= 0 && x < 1);
  }
  const r = makeRng(5);
  for (let i = 0; i < 200; i++) {
    const v = r.int(3, 7);
    assert.ok(Number.isInteger(v) && v >= 3 && v <= 7);
  }
});

// ---------- deterministic classifier ----------

const D = (signal: FailureSignal): Diagnosis | null =>
  diagnoseByRules({ signal, type: "payment_failed" } as AtRiskCase);

test("structured Razorpay errors are classified by rules, not a model", () => {
  assert.equal(D({ reason: "insufficient_funds" })?.rootCause, "insufficient_funds");
  assert.equal(D({ reason: "card_expired" })?.rootCause, "card_expired");
  assert.equal(D({ reason: "payment_declined_risk" })?.rootCause, "risk_declined");
  assert.equal(D({ reason: "mandate_revoked" })?.rootCause, "mandate_inactive");
  assert.equal(D({ reason: "payment_limit_exceeded" })?.rootCause, "limit_exceeded");
  assert.equal(D({ code: "GATEWAY_ERROR", reason: "bank_down", source: "bank" })?.rootCause, "bank_downtime");
  assert.equal(D({ step: "payment_authentication" })?.rootCause, "authentication_failed");
});

test("a revoked mandate is not mistaken for a funds problem", () => {
  // Both mention balance-ish words; mandate state must win or we would retry a
  // dead mandate forever.
  assert.equal(D({ reason: "mandate_revoked", source: "customer" })?.rootCause, "mandate_inactive");
});

test("text-only signals fall through to the LLM/heuristic path", () => {
  assert.equal(D({ description: "left checkout after seeing shipping" }), null);
  assert.equal(D({ source: "business", description: "buyer disputes the invoice" }), null);
});

// ---------- policy judgement ----------

function caseWith(cause: Diagnosis["rootCause"], amount = rupees(1000)): AtRiskCase {
  return {
    id: "case_test",
    type: "payment_failed",
    customer: {
      id: "cust_test",
      name: "Test User",
      contact: { email: "t@example.com", phone: "+919800000000" },
      locale: "en-IN",
      optedOut: false,
      timezoneOffsetMin: 330,
    },
    amount,
    currency: "INR",
    createdAt: 10 * 60 * 60_000, // 10:00 IST — outside quiet hours
    signal: {},
    originalMethod: "card",
    attempts: [],
    contacts: 0,
    status: "diagnosing",
    diagnosis: { rootCause: cause, confidence: 0.9, rationale: "test", source: "rules", recoverableHint: true },
  };
}

test("hard declines are escalated, never auto-retried", () => {
  for (const cause of ["risk_declined", "b2b_dispute"] as const) {
    const iv = plan(caseWith(cause), 10 * 60 * 60_000, DEFAULT_POLICY);
    assert.equal(iv.kind, "escalate_human", `${cause} should escalate, got ${iv.kind}`);
  }
});

test("a dead instrument gets a method-switch link, not a retry", () => {
  for (const cause of ["card_expired", "mandate_inactive"] as const) {
    const iv = plan(caseWith(cause), 10 * 60 * 60_000, DEFAULT_POLICY);
    assert.equal(iv.kind, "switch_method_link", `${cause} should send a link, got ${iv.kind}`);
  }
});

test("an insufficient-funds retry is scheduled for the future, not immediately", () => {
  const now = 10 * 60 * 60_000;
  const iv = plan(caseWith("insufficient_funds"), now, DEFAULT_POLICY);
  assert.equal(iv.kind, "retry_payment");
  assert.ok(iv.scheduledAt > now + 12 * 60 * 60_000, "funds retry should wait at least ~half a day");
  assert.equal(localHour(iv.scheduledAt, 330), 10, "funds retry should land mid-morning local time");
});

test("high-value money actions require human approval", () => {
  const small = plan(caseWith("insufficient_funds", rupees(500)), 10 * 60 * 60_000, DEFAULT_POLICY);
  const large = plan(caseWith("insufficient_funds", rupees(80_000)), 10 * 60 * 60_000, DEFAULT_POLICY);
  assert.equal(small.requiresApproval, false);
  assert.equal(large.requiresApproval, true);
});

// ---------- time / compliance helpers ----------

test("quiet hours match the RBI 19:00–08:00 window and defer correctly", () => {
  const { startHour, endHour } = DEFAULT_POLICY.quietHours;
  assert.equal(startHour, 19);
  assert.equal(endHour, 8);

  const at21 = 21 * 60 * 60_000 - 330 * 60_000; // 21:00 IST
  assert.equal(isWithinQuietHours(at21, 330, startHour, endHour), true);
  const deferred = nextAllowedContactTime(at21, 330, startHour, endHour);
  assert.equal(isWithinQuietHours(deferred, 330, startHour, endHour), false);
  assert.ok(deferred > at21);

  const at12 = 12 * 60 * 60_000 - 330 * 60_000; // noon IST
  assert.equal(isWithinQuietHours(at12, 330, startHour, endHour), false);
});

// ---------- money ----------

test("money is integer paise and formats as INR", () => {
  assert.equal(rupees(1234.56), 123456);
  assert.equal(toRupees(123456), 1234.56);
  assert.equal(formatINR(123456), "₹1,234.56");
  assert.equal(formatINR(10000000), "₹1,00,000"); // Indian grouping
  assert.equal(formatINR(0), "₹0");
});

// ---------- the headline claim ----------

test("the agent beats the naive baseline on the cases the baseline can touch", async () => {
  for (const seed of [11, 42, 77, 101, 2024]) {
    const sc = await runScenario({ seed, n: 100 });
    const agent = sc.report.paymentsSegment.grossRecoveredPaise;
    const base = sc.baseline.grossRecoveredPaise;
    assert.ok(agent > base, `seed=${seed}: agent ${agent} did not beat baseline ${base}`);
    assert.equal(sc.report.safety.doubleCharges, 0, `seed=${seed}: agent double-charged`);
  }
});

test("diagnosis is scored against ground truth and is better than chance", async () => {
  const sc = await runScenario({ seed: 42, n: 120 });
  const d = sc.report.diagnosis;
  assert.ok(d, "diagnosis scoring missing");
  assert.ok(d!.total > 0);
  // 15 possible root causes → chance is ~7%. Rules should be near-perfect.
  const rules = d!.byPath.find((p) => p.path === "rules")!;
  assert.ok(rules.accuracy > 0.95, `rules-path accuracy ${rules.accuracy} should be near-perfect`);
  assert.ok(d!.accuracy > 0.5, `overall accuracy ${d!.accuracy} too low`);
});
