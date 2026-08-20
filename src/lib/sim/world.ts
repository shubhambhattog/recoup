// The simulated world — ground truth the agent never sees.
//
// This file is deliberately NOT importable by the agent's decision code. It
// holds the hidden reality of each case: whether the customer will actually
// pay, when, and what it takes. The agent has to infer all of this from the
// failure signal alone. That asymmetry is what makes the recovered-money number
// honest — a wrong diagnosis or a mistimed retry genuinely fails here.
//
// It also owns the two chaos sources that stress the safety layer:
//   • lost confirmations — a charge truly succeeds but reports "unknown", so a
//     naive agent re-charges and double-bills; a correct agent reconciles first.
//   • transient API errors — a money call throws; idempotency keys make the
//     retried call safe (money moves once).

import type { Rng } from "@/lib/core/rng";
import type {
  AtRiskCase,
  Intervention,
  Millis,
  Paise,
  PaymentMethod,
} from "@/lib/domain/types";
import { HOUR } from "@/lib/core/time";
import { isWithinQuietHours } from "@/lib/core/time";

export type Persona =
  | { kind: "funds_on_date"; fundsAt: Millis } // pays once funds arrive
  | { kind: "transient"; clearsAt: Millis } // succeeds once the blip clears
  | { kind: "needs_new_method"; reachable: boolean; respondP: number } // only a link works
  | { kind: "price_sensitive"; minIncentive: Paise; respondP: number } // needs a discount
  | { kind: "distracted_reachable"; respondP: number } // a reminder converts
  | { kind: "b2b_will_pay"; payAround: Millis; respondP: number } // pays near a promised date
  | { kind: "b2b_dispute" } // only a human resolves
  | { kind: "dead" }; // unrecoverable (fraud / bad debt / gone)

export interface WorldConfig {
  lostConfirmationP: number; // truly-successful charge reports "unknown"
  apiErrorP: number; // transient throw on a money call
  baseOptOutP: number; // per-contact opt-out probability
}

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  lostConfirmationP: 0.14,
  apiErrorP: 0.1,
  baseOptOutP: 0.04,
};

export interface SettleResult {
  reported: "success" | "failed" | "unknown";
}

export interface MessageResult {
  optOut: boolean;
  willPay: boolean;
  payAt?: Millis;
}

export class TransientApiError extends Error {
  constructor() {
    super("razorpay: gateway temporarily unavailable (simulated 503)");
    this.name = "TransientApiError";
  }
}

export class World {
  private byKey = new Map<string, "success" | "failed">(); // idempotency store
  private captured = new Set<string>(); // caseIds that truly took money

  /** Number of times a case was charged more than once — MUST stay 0 for the agent. */
  public doubleCharges = 0;

  constructor(
    private truth: Map<string, Persona>,
    private cfg: WorldConfig,
    private rng: Rng,
  ) {}

  private persona(caseId: string): Persona {
    return this.truth.get(caseId) ?? { kind: "dead" };
  }

  /** Would a direct charge on the original method truly succeed at time t? */
  private wouldChargeSucceed(c: AtRiskCase, t: Millis): boolean {
    const p = this.persona(c.id);
    switch (p.kind) {
      case "funds_on_date":
        return t >= p.fundsAt;
      case "transient":
        return t >= p.clearsAt;
      default:
        // needs_new_method / abandoned / b2b / dead: a same-method retry can't succeed.
        return false;
    }
  }

  /**
   * Attempt a charge (retry_payment) with an idempotency key. Money moves at
   * most once per key. May throw TransientApiError; the caller retries the CALL
   * with the same key, which is safe precisely because of the key.
   */
  settle(c: AtRiskCase, _method: PaymentMethod, t: Millis, key: string): SettleResult {
    // Idempotent replay: same key never moves money twice.
    const prior = this.byKey.get(key);
    if (prior) return { reported: prior === "success" ? "success" : "failed" };

    // Chaos: transient API error BEFORE any state changes → nothing moved.
    if (this.rng.bool(this.cfg.apiErrorP)) throw new TransientApiError();

    const success = this.wouldChargeSucceed(c, t);
    if (!success) {
      this.byKey.set(key, "failed");
      return { reported: "failed" };
    }

    // A real capture. Detect a double-charge (a second successful capture on a
    // case that already took money via a DIFFERENT key — i.e. the agent failed
    // to reconcile and re-charged).
    if (this.captured.has(c.id)) this.doubleCharges++;
    this.captured.add(c.id);
    this.byKey.set(key, "success");

    // Chaos: the confirmation is lost. Money moved, but the agent is told "unknown".
    if (this.rng.bool(this.cfg.lostConfirmationP)) return { reported: "unknown" };
    return { reported: "success" };
  }

  /** Truthful status check for an unknown outcome — the reconciliation source. */
  reconcile(key: string): "success" | "failed" {
    return this.byKey.get(key) ?? "failed";
  }

  /** Deliver a customer message; returns opt-out and whether/when it converts. */
  deliverMessage(c: AtRiskCase, iv: Intervention, t: Millis): MessageResult {
    // Annoyance rises with prior contacts; quiet-hour contact is extra annoying.
    const quiet = isWithinQuietHours(t, c.customer.timezoneOffsetMin, 21, 9);
    const optOutP =
      this.cfg.baseOptOutP * (1 + 0.6 * c.contacts) * (quiet ? 2.5 : 1);
    if (this.rng.bool(optOutP)) return { optOut: true, willPay: false };

    const p = this.persona(c.id);
    const soon = (): Millis => t + this.rng.int(1, 24) * HOUR;

    const convert = (prob: boolean, at?: Millis): MessageResult => ({
      optOut: false,
      willPay: prob,
      payAt: prob ? at ?? soon() : undefined,
    });

    switch (p.kind) {
      case "needs_new_method": {
        if (!p.reachable) return { optOut: false, willPay: false };
        const strong = iv.kind === "switch_method_link";
        return convert(this.rng.bool(strong ? p.respondP : p.respondP * 0.3));
      }
      case "price_sensitive": {
        if (iv.kind === "incentive_link" && (iv.incentivePaise ?? 0) >= p.minIncentive) {
          return convert(this.rng.bool(p.respondP));
        }
        // A plain nudge rarely converts a price-sensitive abandoner.
        return convert(this.rng.bool(p.respondP * 0.2));
      }
      case "distracted_reachable":
        return convert(this.rng.bool(p.respondP));
      case "b2b_will_pay": {
        if (iv.kind === "promise_to_pay" || iv.kind === "nudge") {
          const at = p.payAround + this.rng.int(-12, 12) * HOUR;
          return convert(this.rng.bool(p.respondP), at);
        }
        return { optOut: false, willPay: false };
      }
      case "funds_on_date":
        // A method-switch link can rescue this once funds exist.
        if (iv.kind === "switch_method_link" && t >= p.fundsAt) return convert(this.rng.bool(0.6));
        return { optOut: false, willPay: false };
      case "transient":
        if (iv.kind === "switch_method_link" && t >= p.clearsAt) return convert(this.rng.bool(0.7));
        return { optOut: false, willPay: false };
      default:
        return { optOut: false, willPay: false }; // b2b_dispute, dead
    }
  }
}
