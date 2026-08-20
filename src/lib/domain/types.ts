// The domain model for Recoup — a bounded revenue-recovery agent.
//
// Design rule that the whole codebase leans on: the AGENT never sees ground
// truth. Everything in this file is knowledge the agent legitimately has
// (the failure signal, its own attempts, policy). The hidden "will this
// customer actually pay" truth lives only in the simulator and is never
// imported here.

// ---------- Primitives ----------

/** Integer paise. ₹1 = 100 paise (Razorpay convention). Never floats. */
export type Paise = number;

/** Virtual epoch milliseconds within a simulation run. */
export type Millis = number;

export type PaymentMethod =
  | "card"
  | "upi"
  | "netbanking"
  | "wallet"
  | "emi"
  | "mandate";

// ---------- Loss classes (what Detect ingests) ----------

export type CaseType =
  | "payment_failed" // one-time payment attempt failed
  | "subscription_failed" // recurring / mandate charge failed
  | "checkout_abandoned" // customer left without paying
  | "invoice_overdue"; // B2B receivable past due

/**
 * The failure surface the agent observes — deliberately shaped like Razorpay's
 * real error object (code + reason + source + step). Structured fields drive
 * the deterministic classifier; `description` is the only free-text field and
 * is the sole place the LLM is allowed to reason about a diagnosis.
 */
export interface FailureSignal {
  code?: string; // e.g. "BAD_REQUEST_ERROR", "GATEWAY_ERROR"
  reason?: string; // e.g. "insufficient_funds", "payment_failed"
  source?: "bank" | "gateway" | "customer" | "business" | "network";
  step?: "payment_authentication" | "payment_authorization" | "payment_capture";
  description?: string; // free text — LLM territory only
  method?: PaymentMethod;
}

// ---------- Diagnose ----------

export type RootCause =
  | "insufficient_funds"
  | "bank_downtime"
  | "gateway_error"
  | "card_expired"
  | "risk_declined"
  | "authentication_failed"
  | "limit_exceeded"
  | "mandate_inactive"
  | "network_glitch"
  | "buyer_price_sensitive"
  | "buyer_distracted"
  | "b2b_cashflow"
  | "b2b_dispute"
  | "unrecoverable"
  | "unknown";

export interface Diagnosis {
  rootCause: RootCause;
  confidence: number; // 0..1
  rationale: string; // human-readable, lands in the audit ledger
  source: "rules" | "llm"; // which path produced it (auditable)
  /** Rough prior on whether recovery is worth attempting at all. */
  recoverableHint: boolean;
}

// ---------- Customer ----------

export interface Customer {
  id: string;
  name: string;
  contact: { email?: string; phone?: string };
  locale: "en-IN" | "hi-IN"; // drives Hinglish messaging
  optedOut: boolean; // hard stop for any contact / charge
  timezoneOffsetMin: number; // for quiet-hours math (IST = +330)
}

// ---------- Case ----------

export type CaseStatus =
  | "new"
  | "diagnosing"
  | "planning"
  | "acting"
  | "waiting" // next action scheduled in the (virtual) future
  | "recovered"
  | "exception"; // gave up / escalated / unrecoverable

export interface Attempt {
  at: Millis;
  kind: "retry_payment" | "payment_link";
  method: PaymentMethod;
  idempotencyKey: string;
  amount: Paise;
  /** "unknown" = the money action's result was lost (chaos). Must be reconciled. */
  result: "success" | "failed" | "unknown";
  /** Filled by the reconciliation step when result was "unknown". */
  reconciledResult?: "success" | "failed";
}

export interface AtRiskCase {
  id: string;
  type: CaseType;
  customer: Customer;
  amount: Paise; // gross amount at risk
  currency: "INR";
  createdAt: Millis; // when the loss event happened (virtual)
  dueAt?: Millis; // invoices: due date; carts: soft expiry
  signal: FailureSignal; // what Detect observed
  originalMethod: PaymentMethod;

  // mutable working state
  attempts: Attempt[]; // money attempts (retries + link charges)
  contacts: number; // messages sent (for contact cap)
  status: CaseStatus;
  diagnosis?: Diagnosis;
  nextActionAt?: Millis; // when the loop should next touch this case
  lastContactAt?: Millis; // last outbound message time (for contact spacing)

  // outcome accounting (filled as it resolves)
  recoveredAmount?: Paise;
  interventionCost?: Paise; // incentives + messaging cost
  resolvedAt?: Millis;
  exceptionReason?: string;
}

// ---------- Decide (intervention plan) ----------

export type InterventionKind =
  | "retry_payment" // re-attempt the charge (smart-timed)
  | "switch_method_link" // dunning: Payment Link to update method / pay differently
  | "nudge" // reminder message, no incentive
  | "incentive_link" // Payment Link + incentive (has a cost)
  | "promise_to_pay" // capture a PTP date, schedule follow-up
  | "escalate_human" // hand to a human
  | "stop"; // give up per a stopping rule

export interface Intervention {
  kind: InterventionKind;
  scheduledAt: Millis; // when to execute (smart timing)
  incentivePaise?: Paise; // for incentive_link
  channel?: "email" | "sms" | "whatsapp";
  message?: string; // LLM-composed (Hinglish where locale = hi-IN)
  rationale: string; // why this action — lands in the audit ledger
  requiresApproval: boolean; // human gate (value threshold / risk)
}

// ---------- Guardrail decision ----------

export interface GateResult {
  allowed: boolean;
  reason?: string; // why blocked (audit)
  /** A suggested safe fallback when blocked (e.g. escalate instead of charge). */
  fallback?: InterventionKind;
}
