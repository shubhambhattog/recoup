// Policy — decide the next intervention for a case.
//
// This is deterministic on purpose. Given a diagnosis and what has already been
// tried, it returns exactly one next action and when to run it. It is the
// "judgment" that separates Recoup from a dumb retry loop:
//   • it does NOT retry an expired card or a risk-decline (wasted attempts),
//   • it times funds retries for the morning / a couple of days out,
//   • it escalates disputes and high-risk declines to a human,
//   • it spends a capped incentive only on price-sensitive abandoners.
//
// The naive baseline (baseline.ts) ignores all of this and just retries 3× now.
// The measured gap between the two is the whole point of the submission.
//
// Scheduling uses STABLE ANCHORS (last attempt time / last contact time), never
// "now". That way, when the loop re-plans a case at its scheduled time, the same
// action resolves to a time <= now and executes, instead of forever deferring.

import type { RecoveryPolicy } from "@/lib/domain/config";
import type {
  AtRiskCase,
  Intervention,
  Millis,
  Paise,
  RootCause,
} from "@/lib/domain/types";
import { addDays, addHours, DAY, nextAllowedContactTime, nextLocalHour } from "@/lib/core/time";
import { toRupees } from "@/lib/core/money";

const TRANSIENT: ReadonlySet<RootCause> = new Set([
  "bank_downtime",
  "gateway_error",
  "network_glitch",
]);

function scheduleRetry(anchor: Millis, cause: RootCause, idx: number, tz: number): Millis {
  if (cause === "insufficient_funds") {
    // Wait for likely funds, retry mid-morning. Escalating waits.
    const base = addDays(anchor, idx === 0 ? 1 : 3);
    return nextLocalHour(base, tz, 10);
  }
  if (TRANSIENT.has(cause)) return addHours(anchor, [2, 6, 24][Math.min(idx, 2)]);
  if (cause === "authentication_failed") return addHours(anchor, 2);
  if (cause === "limit_exceeded") return addDays(anchor, 1);
  return addHours(anchor, 12);
}

function scheduleContact(anchor: Millis, tz: number, p: RecoveryPolicy): Millis {
  return nextAllowedContactTime(anchor, tz, p.quietHours.startHour, p.quietHours.endHour);
}

function incentiveFor(c: AtRiskCase, p: RecoveryPolicy): Paise {
  return Math.min(p.maxIncentivePerCasePaise, Math.round(c.amount * 0.05));
}

function needsApproval(kind: Intervention["kind"], amount: Paise, p: RecoveryPolicy): boolean {
  // Agent-initiated money moves on high-value cases need a human in the loop.
  return (
    (kind === "retry_payment" || kind === "incentive_link") &&
    amount >= p.humanApprovalThresholdPaise
  );
}

function message(c: AtRiskCase, intent: string, incentiveRupees?: number): string {
  const name = c.customer.name.split(" ")[0];
  const amt = Math.round(toRupees(c.amount));
  const hi = c.customer.locale === "hi-IN";
  switch (intent) {
    case "switch_method":
      return hi
        ? `Hi ${name}, aapka ₹${amt} ka payment nahi ho paaya. Doosre method (UPI/card) se pay karne ke liye yeh secure link use karein.`
        : `Hi ${name}, your ₹${amt} payment didn't go through. Use this secure link to pay via another method (UPI/card).`;
    case "incentive":
      return hi
        ? `Hi ${name}, aapka cart wait kar raha hai! ₹${incentiveRupees} off ke saath abhi checkout karein.`
        : `Hi ${name}, your cart is waiting — complete checkout now and get ₹${incentiveRupees} off.`;
    case "promise_to_pay":
      return hi
        ? `Hi ${name}, ₹${amt} ka invoice due hai. Kripya payment ki expected date confirm karein — hum us din reminder bhej denge.`
        : `Hi ${name}, invoice for ₹${amt} is due. Please confirm an expected payment date and we'll remind you then.`;
    case "nudge":
    default:
      return hi
        ? `Hi ${name}, ₹${amt} ka payment abhi tak pending hai. Yeh raha aapka secure payment link.`
        : `Hi ${name}, a ₹${amt} payment is still pending. Here's your secure payment link.`;
  }
}

/** Choose the next intervention for a case. Pure and deterministic. */
export function plan(c: AtRiskCase, now: Millis, p: RecoveryPolicy): Intervention {
  const cause = c.diagnosis?.rootCause ?? "unknown";
  const tz = c.customer.timezoneOffsetMin;
  const nMoney = c.attempts.length;
  const nContact = c.contacts;
  const retryAnchor = nMoney ? c.attempts[nMoney - 1].at : c.createdAt;
  const contactAnchor = (c.lastContactAt ?? c.createdAt) + (nContact > 0 ? DAY : 0);

  const retry = (idx: number): Intervention => ({
    kind: "retry_payment",
    scheduledAt: scheduleRetry(retryAnchor, cause, idx, tz),
    rationale: `Retry attempt ${idx + 1} for ${cause} at a smart time.`,
    requiresApproval: needsApproval("retry_payment", c.amount, p),
  });
  const contact = (
    kind: Intervention["kind"],
    intent: string,
    incentivePaise?: Paise,
  ): Intervention => {
    const incentiveRupees = incentivePaise ? Math.round(toRupees(incentivePaise)) : undefined;
    return {
      kind,
      scheduledAt: scheduleContact(contactAnchor, tz, p),
      incentivePaise,
      channel: c.customer.contact.phone ? "whatsapp" : "email",
      message: message(c, intent, incentiveRupees),
      rationale: `${kind} for ${cause}.`,
      requiresApproval: needsApproval(kind, c.amount, p),
    };
  };
  const terminal = (kind: "escalate_human" | "stop", why: string): Intervention => ({
    kind,
    scheduledAt: now,
    rationale: why,
    requiresApproval: false,
  });

  switch (cause) {
    case "insufficient_funds":
      if (nMoney < 2) return retry(nMoney);
      if (nContact < 1) return contact("switch_method_link", "switch_method");
      return terminal("stop", "Funds retries + method-switch exhausted.");

    case "bank_downtime":
    case "gateway_error":
    case "network_glitch":
      if (nMoney < 3) return retry(nMoney);
      return terminal("stop", "Transient retries exhausted.");

    case "card_expired":
    case "mandate_inactive":
      if (nContact < 1) return contact("switch_method_link", "switch_method");
      if (nContact < 2) return contact("nudge", "nudge");
      return terminal("stop", "Instrument dead; customer did not re-authorize.");

    case "risk_declined":
      return terminal("escalate_human", "Risk/fraud decline — human review, never auto-retry.");

    case "authentication_failed":
      if (nMoney < 1) return retry(0);
      if (nContact < 1) return contact("nudge", "nudge");
      return terminal("stop", "Authentication not completed after nudge.");

    case "limit_exceeded":
      if (nMoney < 1) return retry(0);
      if (nContact < 1) return contact("switch_method_link", "switch_method");
      return terminal("stop", "Limit retry + method-switch exhausted.");

    case "buyer_price_sensitive":
      if (nContact < 1) return contact("nudge", "nudge");
      if (nContact < 2) return contact("incentive_link", "incentive", incentiveFor(c, p));
      return terminal("stop", "Nudge + incentive did not convert.");

    case "buyer_distracted":
      if (nContact < 2) return contact("nudge", "nudge");
      return terminal("stop", "Reminders did not convert.");

    case "b2b_cashflow":
      if (nContact < 1) return contact("promise_to_pay", "promise_to_pay");
      if (nContact < 2) return contact("nudge", "nudge");
      return terminal("escalate_human", "Receivable unpaid after PTP + reminder — escalate to collections.");

    case "b2b_dispute":
      return terminal("escalate_human", "Invoice disputed — route to resolution, do not chase payment.");

    case "unknown":
      if ((c.type === "payment_failed" || c.type === "subscription_failed") && nMoney < 1) return retry(0);
      if (nContact < 1) return contact("nudge", "nudge");
      return terminal("escalate_human", "Unclassified after one attempt — human review.");

    case "unrecoverable":
    default:
      return terminal("stop", "Diagnosed unrecoverable.");
  }
}
