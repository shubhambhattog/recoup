// The recovery policy — every bound the agent operates under, in one place.
// This is the "bounded and gated" contract from the Track 03 bar. The agent
// physically cannot act outside these limits: the guardrail layer enforces
// them, not the LLM.
//
// Where a bound comes from an external rule rather than our own judgement, the
// source is cited inline. Recovery/dunning is a regulated activity in India and
// a rule-bound one on the card networks; a recovery agent that invents its own
// contact hours is not shippable.

import { DAY, HOUR } from "@/lib/core/time";
import { rupees } from "@/lib/core/money";
import type { Paise } from "@/lib/domain/types";

export interface RecoveryPolicy {
  /** Hard cap on money attempts (retries + link charges) per case. */
  maxMoneyAttemptsPerCase: number;
  /** Hard cap on outbound messages per case. */
  maxContactsPerCase: number;
  /** Per-customer messages allowed per local day (anti-spam). */
  perCustomerDailyContactCap: number;
  /** No contact inside this local-hour window [start, end) (wraps midnight). */
  quietHours: { startHour: number; endHour: number };
  /** Minimum gap between two money attempts on the same case. */
  cooldownMs: number;
  /** Stop all recovery on a case this long after it was created. */
  caseDeadlineMs: number;
  /** Total incentive budget for the whole batch. */
  incentiveBudgetPaise: Paise;
  /** Max incentive that may be spent on a single case. */
  maxIncentivePerCasePaise: Paise;
  /** Money actions on cases at or above this value need human approval. */
  humanApprovalThresholdPaise: Paise;
  /**
   * When true, a mock approver auto-approves gated actions so a headless batch
   * runs end to end. When false the gate is real: the case parks as
   * `awaiting_human` until a human approves it (see the Approvals queue in the
   * dashboard, or `approvedCaseIds` in RunOptions).
   */
  autoApproveInSim: boolean;
}

export const DEFAULT_POLICY: RecoveryPolicy = {
  // Card networks cap re-attempts on a declined authorization and charge fees
  // for excessive retries (Visa/Mastercard authorization-reattempt rules), and
  // repeated hard declines damage issuer trust. We stay well inside any network
  // limit: at most 3 money attempts per case, and never on a hard decline
  // (expired card / risk decline are routed to a link or a human instead).
  maxMoneyAttemptsPerCase: 3,

  maxContactsPerCase: 4,
  perCustomerDailyContactCap: 2,

  // RBI's Fair Practices / outsourcing guidelines direct regulated entities and
  // their recovery agents not to contact borrowers outside 08:00–19:00 local
  // time. We encode that window directly: contact is blocked 19:00–08:00 IST.
  // (RBI, "Outsourcing of Financial Services — Responsibilities of REs employing
  // Recovery Agents", 12 Aug 2022.)
  quietHours: { startHour: 19, endHour: 8 },

  cooldownMs: 2 * HOUR,
  caseDeadlineMs: 10 * DAY,
  incentiveBudgetPaise: rupees(20_000),
  maxIncentivePerCasePaise: rupees(500),
  humanApprovalThresholdPaise: rupees(25_000),
  autoApproveInSim: true,
};

/** Per-message cost assumption (SMS/WhatsApp), counted against net recovery. */
export const MESSAGING_COST_PER_CONTACT: Paise = rupees(0.35);

/**
 * Assumed cost of one LLM diagnosis call, used for the AI cost/ROI line in the
 * report. Order-of-magnitude for a small, fast model on a short prompt.
 */
export const LLM_COST_PER_DIAGNOSIS: Paise = rupees(0.02);
