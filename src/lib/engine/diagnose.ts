// Diagnose — turn a failure signal into a root cause.
//
// The split here is the point of the whole design:
//   • Structured payment failures (Razorpay error code / reason / step) are
//     classified by DETERMINISTIC RULES. Fast, free, auditable, correct. We do
//     NOT ask an LLM "why did card_expired fail" — the answer is in the code.
//   • Behavioural losses (abandoned carts, overdue B2B invoices) carry no error
//     code — only human context. Those, and only those, fall through to the LLM
//     (or an offline keyword heuristic when no LLM is wired), which reads the
//     free-text description and infers intent.

import type { AtRiskCase, Diagnosis } from "@/lib/domain/types";
import type { Llm } from "@/lib/ai/types";
import { toRupees } from "@/lib/core/money";

/**
 * Deterministic classifier. Returns null when the signal is not structured
 * enough to classify confidently — the caller then routes to the LLM/heuristic.
 */
export function diagnoseByRules(c: AtRiskCase): Diagnosis | null {
  const reason = (c.signal.reason ?? "").toLowerCase();
  const code = (c.signal.code ?? "").toLowerCase();
  const step = c.signal.step ?? "";
  const source = c.signal.source ?? "";
  const hay = `${reason} ${code}`;

  const D = (
    rootCause: Diagnosis["rootCause"],
    confidence: number,
    rationale: string,
    recoverableHint: boolean,
  ): Diagnosis => ({ rootCause, confidence, rationale, source: "rules", recoverableHint });

  // Mandate-specific (subscriptions) — check before generic funds so we don't
  // mislabel a revoked mandate as a fixable funds problem.
  if (/mandate|revoked|paused|not_active|cancelled/.test(hay)) {
    return D("mandate_inactive", 0.9, "Mandate is revoked/paused; re-authorization required.", true);
  }
  if (/insufficient|low_balance|balance/.test(hay)) {
    return D("insufficient_funds", 0.95, "Issuer reported insufficient funds — retry after funds likely available.", true);
  }
  if (/expired|card_expired/.test(hay)) {
    return D("card_expired", 0.95, "Payment instrument expired; same-method retry will always fail.", true);
  }
  if (/risk|fraud|security|do_not_honou?r|stolen|blocked/.test(hay)) {
    return D("risk_declined", 0.9, "Issuer risk/fraud decline — must not auto-retry; route to human.", false);
  }
  if (step === "payment_authentication" || /authentication|3d_?secure|otp|auth_failed/.test(hay)) {
    return D("authentication_failed", 0.85, "Authentication (OTP/3DS) not completed; customer can complete it.", true);
  }
  if (/limit|exceeded|max_amount/.test(hay)) {
    return D("limit_exceeded", 0.85, "Per-transaction/daily limit hit; retry later or switch method.", true);
  }
  if (source === "bank" && /down|unavailable|timeout|maintenance/.test(hay)) {
    return D("bank_downtime", 0.8, "Issuing bank temporarily down; short-cooldown retry likely succeeds.", true);
  }
  if (code === "gateway_error") {
    return D("gateway_error", 0.75, "Gateway error; transient — retry after cooldown.", true);
  }
  if (source === "network" || /network|connection|timeout/.test(hay)) {
    return D("network_glitch", 0.8, "Network glitch; transient — retry shortly.", true);
  }

  return null; // not structured enough — defer to LLM/heuristic
}

/** Offline keyword heuristic — stands in for the LLM so the batch runs with no API key. */
function diagnoseByHeuristic(c: AtRiskCase): Diagnosis {
  const desc = (c.signal.description ?? "").toLowerCase();
  const H = (
    rootCause: Diagnosis["rootCause"],
    rationale: string,
    recoverableHint: boolean,
  ): Diagnosis => ({ rootCause, confidence: 0.6, rationale, source: "rules", recoverableHint });

  if (c.type === "checkout_abandoned") {
    if (/price|expensive|costly|discount|coupon|shipping|delivery fee|too much/.test(desc)) {
      return H("buyer_price_sensitive", "Abandoned near price/shipping; a small incentive may convert.", true);
    }
    return H("buyer_distracted", "Abandoned mid-checkout; likely distraction — a reminder may convert.", true);
  }
  if (c.type === "invoice_overdue") {
    if (/dispute|disagree|wrong|incorrect|quality|complaint|not delivered/.test(desc)) {
      return H("b2b_dispute", "Buyer is disputing the invoice; chasing money is wrong — escalate.", false);
    }
    return H("b2b_cashflow", "Overdue, no dispute signal; likely cashflow timing — capture a promise-to-pay.", true);
  }
  if (/insufficient|balance/.test(desc)) return H("insufficient_funds", "Text suggests low balance.", true);
  if (/expired/.test(desc)) return H("card_expired", "Text suggests expired instrument.", true);
  if (/fraud|risk/.test(desc)) return H("risk_declined", "Text suggests a risk decline.", false);
  return H("unknown", "No structured signal and no clear textual cue.", true);
}

/** Full diagnosis: rules first, then LLM (if provided) or offline heuristic. */
export async function diagnose(c: AtRiskCase, llm?: Llm): Promise<Diagnosis> {
  const byRules = diagnoseByRules(c);
  if (byRules) return byRules;

  if (llm) {
    try {
      const r = await llm.classifyRootCause({
        type: c.type,
        amountRupees: toRupees(c.amount),
        signalDescription: c.signal.description,
        reason: c.signal.reason,
        code: c.signal.code,
      });
      return {
        rootCause: r.rootCause,
        confidence: r.confidence,
        rationale: r.rationale,
        source: "llm",
        recoverableHint: r.rootCause !== "b2b_dispute" && r.rootCause !== "unrecoverable",
      };
    } catch {
      // LLM failed — fall back to the deterministic heuristic, never crash the batch.
      return diagnoseByHeuristic(c);
    }
  }
  return diagnoseByHeuristic(c);
}
