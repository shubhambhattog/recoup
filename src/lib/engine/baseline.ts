// The naive baseline — what "just retry the failed payments" looks like.
//
// It is deliberately dumb, and dumb in the ways real naive dunning is dumb:
//   • no diagnosis — it retries everything the same way,
//   • it only knows how to retry a charge, so it ignores abandoned carts and
//     overdue invoices entirely (no links, no messages, no incentives),
//   • it retries immediately (funds haven't arrived yet → wasted attempts),
//   • it has NO reconciliation — an "unknown" (lost confirmation) is treated as
//     a failure and re-charged, which double-charges the customer.
//
// Running it on the same cases + same world as the agent is the honest A/B: the
// gap in recovered money AND the gap in double-charges are both the agent's.

import { World } from "@/lib/sim/world";
import type { AtRiskCase } from "@/lib/domain/types";

export function runBaseline(cases: AtRiskCase[], world: World): void {
  for (const c of cases) {
    // Naive dunning only understands "retry the charge".
    if (c.type !== "payment_failed" && c.type !== "subscription_failed") {
      c.status = "exception";
      c.exceptionReason = "baseline_ignores_non_payment";
      continue;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const t = c.createdAt + attempt * 60 * 60_000; // retry ~hourly, right away
      const key = `${c.id}:base:${attempt}`;
      let reported: "success" | "failed" | "unknown";
      try {
        reported = world.settle(c, c.originalMethod, t, key).reported;
      } catch {
        // No idempotency discipline: retry the call with a brand-new key.
        try {
          reported = world.settle(c, c.originalMethod, t, `${key}:r`).reported;
        } catch {
          reported = "failed";
        }
      }
      c.attempts.push({
        at: t, kind: "retry_payment", method: c.originalMethod,
        idempotencyKey: key, amount: c.amount, result: reported,
      });
      if (reported === "success") {
        c.recoveredAmount = c.amount;
        c.status = "recovered";
        c.resolvedAt = t;
        break;
      }
      // "unknown" is treated as a plain failure → it re-charges on the next
      // iteration. That is exactly the double-charge the agent avoids.
    }

    if (c.status !== "recovered") {
      c.status = "exception";
      c.exceptionReason = "baseline_exhausted";
    }
  }
}
