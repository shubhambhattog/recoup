// The narrow seam through which the LLM is allowed to touch the system.
//
// Note what is NOT here: there is no `decideAction` or `authorizePayment`. The
// LLM never chooses or authorizes a money action. It only (a) classifies an
// ambiguous, text-heavy failure and (b) writes customer-facing copy. Every
// money decision is deterministic policy + guardrails. That boundary is the
// whole "right tool in the right place — and where we chose not to use one".

import type { CaseType, RootCause } from "@/lib/domain/types";

export interface ClassifyInput {
  type: CaseType;
  amountRupees: number;
  signalDescription?: string;
  reason?: string;
  code?: string;
}

export interface ClassifyResult {
  rootCause: RootCause;
  confidence: number; // 0..1
  rationale: string;
}

export interface ComposeInput {
  customerName: string;
  locale: "en-IN" | "hi-IN";
  intent: "nudge" | "switch_method" | "incentive" | "promise_to_pay";
  amountRupees: number;
  incentiveRupees?: number;
  payLink?: string;
}

export interface Llm {
  /** Only used for genuinely ambiguous cases (abandoned carts, overdue B2B). */
  classifyRootCause(input: ClassifyInput): Promise<ClassifyResult>;
  /** Writes the customer message (Hinglish when locale is hi-IN). */
  composeMessage(input: ComposeInput): Promise<string>;
}
