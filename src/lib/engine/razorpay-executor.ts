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
// status, exactly the reconciliation pattern the simulator exercises.

import type { Executor, RecoveryOutcome } from "@/lib/engine/executor";
import type { AtRiskCase, Intervention, Millis } from "@/lib/domain/types";
import { MESSAGING_COST_PER_CONTACT } from "@/lib/domain/config";
import type { Ledger } from "@/lib/ledger/ledger";
import { createPaymentLink, fetchPaymentLink } from "@/lib/razorpay/client";
import { toRupees } from "@/lib/core/money";

export class RazorpayExecutor implements Executor {
  constructor(private ledger: Ledger) {}

  async execute(c: AtRiskCase, iv: Intervention, now: Millis): Promise<RecoveryOutcome> {
    if (iv.kind === "escalate_human") return { kind: "escalated" };
    if (iv.kind === "stop") return { kind: "stopped" };

    // reference_id is our idempotency key: re-running the same step returns the
    // same link rather than creating a duplicate.
    const referenceId = `${c.id}-${iv.kind}-${c.contacts + c.attempts.length}`;
    const { view, idempotentReuse } = await createPaymentLink({
      amountPaise: c.amount,
      referenceId,
      description: iv.message ?? `Recover ₹${Math.round(toRupees(c.amount))} — ${c.type}`,
      customer: {
        name: c.customer.name,
        email: c.customer.contact.email,
        contact: c.customer.contact.phone,
      },
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
      summary: `Razorpay ${idempotentReuse ? "reused (idempotent) " : "created "}payment link ${view.id} → ${view.shortUrl}`,
      data: { linkId: view.id, shortUrl: view.shortUrl, referenceId, idempotentReuse, intervention: iv.kind },
    });

    return { kind: "message_sent", cost: MESSAGING_COST_PER_CONTACT, idempotencyKey: view.id };
  }

  async reconcile(linkId: string): Promise<"success" | "failed"> {
    const link = await fetchPaymentLink(linkId);
    if (!link) return "failed";
    return link.status === "paid" || link.amountPaid >= link.amount ? "success" : "failed";
  }
}
