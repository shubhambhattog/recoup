// Tests for the Razorpay layer's pure logic.
//
// The network calls themselves aren't exercised here (that's what
// `npm run razorpay:live` is for), but the parts that decide whether money
// moves twice — and whether a real person gets messaged — are pure and belong
// under test. Both of the incidents in FAILURE_STORY.md §7 and §8 would have
// been caught by the assertions below.

import test from "node:test";
import assert from "node:assert/strict";
import { buildReferenceId } from "@/lib/engine/razorpay-executor";
import { notificationsAllowed } from "@/lib/razorpay/client";

// ---------- idempotency key ----------

test("a reference id is stable for the same run/case/intervention/step", () => {
  const a = buildReferenceId("rc42", "case_0004", "switch_method_link", 0);
  const b = buildReferenceId("rc42", "case_0004", "switch_method_link", 0);
  assert.equal(a, b, "identical inputs must produce an identical reference");
  assert.equal(a, "rc42-0004-sml-0");
});

test("a reference id changes with the step — an idempotency check must not bump it first", () => {
  // This is exactly the bug in FAILURE_STORY §8: the verification call ran after
  // `contacts++`, so the "identical" repeat computed step 1 and created a second
  // real link. The asymmetry is correct; the ordering at the call site was not.
  const step0 = buildReferenceId("rc42", "case_0004", "nudge", 0);
  const step1 = buildReferenceId("rc42", "case_0004", "nudge", 1);
  assert.notEqual(step0, step1);
});

test("reference ids are scoped per run, so two seeds cannot adopt each other's links", () => {
  const s42 = buildReferenceId("rc42", "case_0001", "nudge", 0);
  const s77 = buildReferenceId("rc77", "case_0001", "nudge", 0);
  assert.notEqual(s42, s77, "same case id at a different seed is a different customer and amount");
});

test("different interventions on the same case get different references", () => {
  const kinds = ["retry_payment", "switch_method_link", "nudge", "incentive_link", "promise_to_pay"];
  const refs = kinds.map((k) => buildReferenceId("rc42", "case_0001", k, 0));
  assert.equal(new Set(refs).size, kinds.length, `collision among ${refs.join(", ")}`);
});

test("reference ids stay inside Razorpay's 40-character limit", () => {
  // Razorpay rejects anything longer, which fails the money action outright.
  for (const kind of ["retry_payment", "switch_method_link", "promise_to_pay"]) {
    for (const step of [0, 9, 99]) {
      const ref = buildReferenceId("rc123456", "case_9999", kind, step);
      assert.ok(ref.length <= 40, `"${ref}" is ${ref.length} chars`);
    }
  }
});

test("an over-long reference is rejected loudly rather than silently truncated", () => {
  assert.throws(
    () => buildReferenceId("a-very-long-run-prefix-that-eats-the-budget", "case_0001", "nudge", 0),
    /40-character limit/,
  );
});

// ---------- outbound delivery ----------

test("notifications are off unless explicitly enabled in the environment", () => {
  const prev = process.env.RAZORPAY_ALLOW_NOTIFICATIONS;
  try {
    delete process.env.RAZORPAY_ALLOW_NOTIFICATIONS;
    assert.equal(notificationsAllowed(), false, "default must be OFF — generated phone numbers are real-format");

    process.env.RAZORPAY_ALLOW_NOTIFICATIONS = "true";
    assert.equal(notificationsAllowed(), false, "only an explicit \"1\" counts, not any truthy string");

    process.env.RAZORPAY_ALLOW_NOTIFICATIONS = "1";
    assert.equal(notificationsAllowed(), true);
  } finally {
    if (prev === undefined) delete process.env.RAZORPAY_ALLOW_NOTIFICATIONS;
    else process.env.RAZORPAY_ALLOW_NOTIFICATIONS = prev;
  }
});
