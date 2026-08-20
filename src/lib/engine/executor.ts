// The executor is the seam between "decide" and "the outside world".
//
// The loop never touches Razorpay (or the simulator) directly — it calls an
// Executor. That means the exact same recovery loop that produces our measured
// batch numbers against the SimExecutor also runs, unchanged, against a
// RazorpayExecutor (Payment Links + retries on test-mode APIs) for the live
// demo. One brain, two hands.
//
// The SimExecutor also demonstrates graceful failure handling: a transient
// gateway error is retried with the SAME idempotency key (so money can never
// move twice), and a lost confirmation is surfaced as "charge_unknown" for the
// loop to reconcile rather than blindly re-charge.

import type { AtRiskCase, Intervention, Millis, Paise, PaymentMethod } from "@/lib/domain/types";
import { MESSAGING_COST_PER_CONTACT } from "@/lib/domain/config";
import type { Ledger } from "@/lib/ledger/ledger";
import { World, TransientApiError } from "@/lib/sim/world";

export type RecoveryOutcomeKind =
  | "charged_success"
  | "charged_failed"
  | "charge_unknown" // lost confirmation → the loop must reconcile before re-charging
  | "message_sent"
  | "opted_out"
  | "escalated"
  | "stopped"
  | "noop";

export interface RecoveryOutcome {
  kind: RecoveryOutcomeKind;
  amount?: Paise;
  idempotencyKey?: string;
  cost?: Paise; // messaging cost incurred
  willPayAt?: Millis; // inbound conversion time (link/nudge/PTP)
  method?: PaymentMethod;
}

export interface Executor {
  execute(c: AtRiskCase, iv: Intervention, now: Millis): Promise<RecoveryOutcome>;
  reconcile(key: string): Promise<"success" | "failed">;
}

export class SimExecutor implements Executor {
  constructor(
    private world: World,
    private ledger: Ledger,
    private maxCallRetries = 4,
  ) {}

  async execute(c: AtRiskCase, iv: Intervention, now: Millis): Promise<RecoveryOutcome> {
    switch (iv.kind) {
      case "retry_payment":
        return this.retry(c, now);
      case "nudge":
      case "switch_method_link":
      case "incentive_link":
      case "promise_to_pay":
        return this.contact(c, iv, now);
      case "escalate_human":
        return { kind: "escalated" };
      case "stop":
        return { kind: "stopped" };
      default:
        return { kind: "noop" };
    }
  }

  async reconcile(key: string): Promise<"success" | "failed"> {
    return this.world.reconcile(key);
  }

  private retry(c: AtRiskCase, now: Millis): RecoveryOutcome {
    const key = `${c.id}:pay:${c.attempts.length}`;
    for (let i = 0; i < this.maxCallRetries; i++) {
      try {
        const r = this.world.settle(c, c.originalMethod, now, key);
        const kind: RecoveryOutcomeKind =
          r.reported === "success"
            ? "charged_success"
            : r.reported === "unknown"
              ? "charge_unknown"
              : "charged_failed";
        return { kind, amount: c.amount, idempotencyKey: key, method: c.originalMethod };
      } catch (e) {
        if (e instanceof TransientApiError) {
          this.ledger.append({
            at: now,
            caseId: c.id,
            type: "action_retried",
            summary: `Transient gateway error on charge; retrying call ${i + 1}/${this.maxCallRetries} with the same idempotency key (${key}) — money cannot move twice.`,
            data: { idempotencyKey: key, attempt: i + 1 },
          });
          continue;
        }
        throw e;
      }
    }
    this.ledger.append({
      at: now,
      caseId: c.id,
      type: "action_result",
      summary: `Charge abandoned after ${this.maxCallRetries} transient gateway errors; idempotency guarantees no money moved.`,
      data: { idempotencyKey: key },
    });
    return { kind: "charged_failed", amount: c.amount, idempotencyKey: key, method: c.originalMethod };
  }

  private contact(c: AtRiskCase, iv: Intervention, now: Millis): RecoveryOutcome {
    const res = this.world.deliverMessage(c, iv, now);
    const cost = MESSAGING_COST_PER_CONTACT;
    if (res.optOut) return { kind: "opted_out", cost };
    return { kind: "message_sent", cost, willPayAt: res.willPay ? res.payAt : undefined };
  }
}
