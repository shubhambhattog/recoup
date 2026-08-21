// A REAL executor that drives Razorpay test-mode APIs, implementing the same
// Executor interface the simulator does. This is the payoff of keeping the loop
// behind an interface: the identical decision engine can either be measured
// against the simulator (where we get honest batch metrics) or execute real
// recovery actions on Razorpay.
//
// In test mode the universal, verifiable recovery instrument is the Payment
// Link, so every non-terminal intervention becomes a real link (idempotent via
// reference_id). Actual money movement is asynchronous — the customer pays the
// link — so recovery is confirmed by reconcile() fetching the link's live
// status.
//
// TWO SAFETY PROPERTIES, both learned by running this for real:
//
//   1. No contact details are sent. Our synthetic customers carry real-FORMAT
//      Indian mobile numbers, and Razorpay delivers to whatever you give it. We
//      pass neither phone nor email, and never enable reminders, so a demo can
//      never message a stranger. (See FAILURE_STORY.md.)
//
//   2. Because a link here IS a customer contact, the live path must gate it
//      with the contact rules — quiet hours and contact caps — not just the
//      money rules. That is what `linkBasedExecutor` on the guard context does.

import type { Executor, RecoveryOutcome } from "@/lib/engine/executor";
import type { AtRiskCase, Intervention, Millis } from "@/lib/domain/types";
import { MESSAGING_COST_PER_CONTACT } from "@/lib/domain/config";
import type { Ledger } from "@/lib/ledger/ledger";
import { createPaymentLink, fetchPaymentLink } from "@/lib/razorpay/client";
import { toRupees } from "@/lib/core/money";

export class RazorpayExecutor implements Executor {
  /**
   * @param referencePrefix namespaces reference_ids so two runs (different
   *   seeds, or a re-run) cannot collide on the same key and silently adopt an
   *   earlier run's link for a different customer and amount.
   */
  constructor(
    private ledger: Ledger,
    private referencePrefix = "recoup",
  ) {}

  async execute(c: AtRiskCase, iv: Intervention, now: Millis): Promise<RecoveryOutcome> {
    if (iv.kind === "escalate_human") return { kind: "escalated" };
    if (iv.kind === "stop") return { kind: "stopped" };

    const referenceId = this.referenceFor(c, iv);
    const { view, idempotentReuse } = await createPaymentLink({
      amountPaise: c.amount,
      referenceId,
      description: iv.message ?? `Recover ₹${Math.round(toRupees(c.amount))} — ${c.type}`,
      // Deliberately no email/contact: see the safety note above.
      customer: { name: c.customer.name },
      notes: {
        caseId: c.id,
        rootCause: c.diagnosis?.rootCause ?? "unknown",
        intervention: iv.kind,
      },
    });

    this.ledger.append({
      at: now,
      caseId: c.id,
      type: "action_executed",
      summary: idempotentReuse
        ? `Payment link ${view.id} already existed for ${referenceId} — verified against Razorpay and reused, no duplicate created.`
        : `Created Razorpay payment link ${view.id} → ${view.shortUrl}`,
      data: {
        linkId: view.id,
        shortUrl: view.shortUrl,
        referenceId,
        idempotentReuse,
        intervention: iv.kind,
        status: view.status,
        notificationsSent: false,
      },
    });

    return {
      kind: "message_sent",
      // A reused link is not a second outreach, so it costs nothing extra.
      cost: idempotentReuse ? 0 : MESSAGING_COST_PER_CONTACT,
      idempotencyKey: view.id,
    };
  }

  /**
   * Build the idempotency key. Razorpay caps reference_id at 40 characters, so
   * this is compact by necessity: prefix, case number, a short intervention
   * code, and the step index. It must stay stable for a given (run, case, step)
   * — that stability IS the idempotency guarantee.
   */
  private referenceFor(c: AtRiskCase, iv: Intervention): string {
    const KIND: Record<string, string> = {
      retry_payment: "rp",
      switch_method_link: "sml",
      nudge: "nud",
      incentive_link: "inc",
      promise_to_pay: "ptp",
    };
    const caseNo = c.id.replace(/^case_/, "");
    const step = c.contacts + c.attempts.length;
    const ref = `${this.referencePrefix}-${caseNo}-${KIND[iv.kind] ?? iv.kind.slice(0, 3)}-${step}`;
    if (ref.length > 40) {
      throw new Error(`reference_id "${ref}" exceeds Razorpay's 40-character limit`);
    }
    return ref;
  }

  async reconcile(linkId: string): Promise<"success" | "failed"> {
    const link = await fetchPaymentLink(linkId);
    if (!link) return "failed";
    return link.status === "paid" || link.amountPaid >= link.amount ? "success" : "failed";
  }
}
