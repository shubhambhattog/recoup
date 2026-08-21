// The guardrail gate — the last thing between a plan and a money action.
//
// The policy engine proposes; the gate disposes. Even if diagnosis or policy
// (or, in a future variant, an LLM) tried to do something unsafe, nothing
// reaches money without passing every check here. These checks encode the
// "bounded and gated" half of the Track 03 bar and are what make the safety
// metrics (zero double-charges, zero post-opt-out contacts, zero overspend)
// hold by construction rather than by luck.

import type { RecoveryPolicy } from "@/lib/domain/config";
import type {
  AtRiskCase,
  GateResult,
  Intervention,
  InterventionKind,
  Millis,
  Paise,
} from "@/lib/domain/types";
import {
  isWithinQuietHours,
  localDayIndex,
  nextAllowedContactTime,
} from "@/lib/core/time";

const MONEY_ACTIONS: ReadonlySet<InterventionKind> = new Set([
  "retry_payment",
]);
const CONTACT_ACTIONS: ReadonlySet<InterventionKind> = new Set([
  "nudge",
  "switch_method_link",
  "incentive_link",
  "promise_to_pay",
]);

export interface GuardContext {
  policy: RecoveryPolicy;
  /** Batch-wide incentive spend so far (mutated by the loop after commit). */
  incentiveSpentPaise: Paise;
  /** key = `${customerId}:${localDayIndex}` → messages sent that local day. */
  contactsByCustomerDay: Map<string, number>;
  /** Human-approval hook. In sim, a mock approver; in prod, a real gate. */
  approve?: (c: AtRiskCase, iv: Intervention) => boolean;
  /**
   * Set when the executor fulfils EVERY intervention by sending the customer a
   * payment link (the Razorpay test-mode path). There, a `retry_payment` is not
   * a silent re-charge — it reaches the customer — so it must also satisfy the
   * contact rules (quiet hours, contact caps), not just the money rules.
   * Without this, a "retry" would legally bypass the RBI contact window.
   */
  linkBasedExecutor?: boolean;
}

/** A gate decision, with an optional deferral time for "come back later" blocks. */
export interface GateDecision extends GateResult {
  /** When set, the block is a deferral: reschedule the same action to this time. */
  retryAt?: Millis;
}

export function contactDayKey(customerId: string, at: Millis, tzOffsetMin: number): string {
  return `${customerId}:${localDayIndex(at, tzOffsetMin)}`;
}

export function gate(
  c: AtRiskCase,
  iv: Intervention,
  ctx: GuardContext,
  now: Millis,
): GateDecision {
  const p = ctx.policy;
  const isMoney = MONEY_ACTIONS.has(iv.kind);
  // With a link-based executor every action also reaches the customer, so the
  // contact rules apply to money actions too.
  const isContact =
    CONTACT_ACTIONS.has(iv.kind) || (ctx.linkBasedExecutor === true && isMoney);

  // 1. Opt-out is an absolute stop — no contact, no charge, ever.
  if (c.customer.optedOut) {
    return { allowed: false, reason: "customer_opted_out", fallback: "stop" };
  }

  // 2. Past the recovery deadline → stop chasing.
  if (now > c.createdAt + p.caseDeadlineMs) {
    return { allowed: false, reason: "past_deadline", fallback: "stop" };
  }

  // 3. Money-action bounds.
  if (isMoney) {
    if (c.attempts.length >= p.maxMoneyAttemptsPerCase) {
      return { allowed: false, reason: "max_money_attempts", fallback: "stop" };
    }
    const last = c.attempts[c.attempts.length - 1];
    if (last && now - last.at < p.cooldownMs) {
      return {
        allowed: false,
        reason: "cooldown_active",
        retryAt: last.at + p.cooldownMs,
      };
    }
  }

  // 4. Contact-action bounds (anti-spam).
  if (isContact) {
    if (c.contacts >= p.maxContactsPerCase) {
      return { allowed: false, reason: "max_contacts", fallback: "stop" };
    }
    // Quiet hours: defer to the next allowed time rather than fail.
    if (
      isWithinQuietHours(
        now,
        c.customer.timezoneOffsetMin,
        p.quietHours.startHour,
        p.quietHours.endHour,
      )
    ) {
      return {
        allowed: false,
        reason: "quiet_hours",
        retryAt: nextAllowedContactTime(
          now,
          c.customer.timezoneOffsetMin,
          p.quietHours.startHour,
          p.quietHours.endHour,
        ),
      };
    }
    // Per-customer daily cap: defer to tomorrow (if still within deadline).
    const key = contactDayKey(c.customer.id, now, c.customer.timezoneOffsetMin);
    const sentToday = ctx.contactsByCustomerDay.get(key) ?? 0;
    if (sentToday >= p.perCustomerDailyContactCap) {
      const tomorrow = now + 24 * 60 * 60_000;
      if (tomorrow > c.createdAt + p.caseDeadlineMs) {
        return { allowed: false, reason: "daily_cap_and_deadline", fallback: "stop" };
      }
      return { allowed: false, reason: "daily_contact_cap", retryAt: tomorrow };
    }
  }

  // 5. Incentive budget (per-case and batch-wide).
  if (iv.kind === "incentive_link") {
    const inc = iv.incentivePaise ?? 0;
    if (inc > p.maxIncentivePerCasePaise) {
      return { allowed: false, reason: "incentive_over_per_case_cap", fallback: "nudge" };
    }
    if (ctx.incentiveSpentPaise + inc > p.incentiveBudgetPaise) {
      return { allowed: false, reason: "incentive_budget_exhausted", fallback: "nudge" };
    }
  }

  // 6. High-value human-approval gate.
  if (iv.requiresApproval) {
    const approved = ctx.approve?.(c, iv) ?? false;
    if (!approved) {
      return { allowed: false, reason: "awaiting_human", fallback: "escalate_human" };
    }
  }

  return { allowed: true };
}
