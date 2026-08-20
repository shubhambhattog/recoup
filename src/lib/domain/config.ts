// The recovery policy — every bound the agent operates under, in one place.
// This is the "bounded and gated" contract from the Track 03 bar. The agent
// physically cannot act outside these limits: the guardrail layer enforces
// them, not the LLM.

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
   * In headless simulation, a mock approver auto-approves gated actions so the
   * batch can run end-to-end. In a real deployment this is false and the case
   * parks in `exception` with reason "awaiting_human".
   */
  autoApproveInSim: boolean;
}

export const DEFAULT_POLICY: RecoveryPolicy = {
  maxMoneyAttemptsPerCase: 3,
  maxContactsPerCase: 4,
  perCustomerDailyContactCap: 2,
  quietHours: { startHour: 21, endHour: 9 }, // 9pm–9am IST, no contact
  cooldownMs: 2 * HOUR,
  caseDeadlineMs: 10 * DAY,
  incentiveBudgetPaise: rupees(20_000),
  maxIncentivePerCasePaise: rupees(500),
  humanApprovalThresholdPaise: rupees(25_000),
  autoApproveInSim: true,
};

/** Per-message cost assumption (SMS/WhatsApp), counted against net recovery. */
export const MESSAGING_COST_PER_CONTACT: Paise = rupees(0.35);
