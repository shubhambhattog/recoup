// Synthetic batch generator. Produces a realistic mix of at-risk cases across
// all four loss types, each paired with a hidden ground-truth persona that is
// CONSISTENT with the signal the agent will see. Structured payment failures
// carry Razorpay-shaped error fields (rules path); abandoned carts and overdue
// invoices carry only free text (LLM/heuristic path). Fully seeded → identical
// batches every run.
//
// Each archetype also records the TRUE root cause. The agent never sees it; it
// exists so diagnosis accuracy can be scored against ground truth (see
// `metrics/diagnosis.ts` and `npm run eval:diagnosis`). Being able to grade our
// own diagnosis is the whole reason the simulator owns the truth.

import { makeRng, type Rng } from "@/lib/core/rng";
import { rupees } from "@/lib/core/money";
import { DAY, HOUR } from "@/lib/core/time";
import type { AtRiskCase, Customer, FailureSignal, Millis, RootCause } from "@/lib/domain/types";
import type { Persona } from "@/lib/sim/world";

export interface GeneratedBatch {
  cases: AtRiskCase[];
  truth: Map<string, Persona>;
  /** Hidden ground-truth root cause per case — for scoring diagnosis only. */
  truthRootCause: Map<string, RootCause>;
}

const FIRST = [
  "Aarav", "Diya", "Vihaan", "Ananya", "Kabir", "Ishaan", "Meera", "Rohan",
  "Saanvi", "Arjun", "Priya", "Kiaan", "Riya", "Advait", "Zara", "Neha",
  "Aditya", "Sara", "Reyansh", "Anika", "Dhruv", "Myra", "Vivaan", "Aisha",
];
const LAST = [
  "Sharma", "Verma", "Iyer", "Nair", "Reddy", "Gupta", "Mehta", "Khan",
  "Patel", "Rao", "Bose", "Das", "Kaur", "Singh", "Menon", "Joshi",
];

function makeCustomer(rng: Rng, i: number): Customer {
  const name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
  const hasPhone = rng.bool(0.8);
  return {
    id: `cust_${i.toString().padStart(4, "0")}`,
    name,
    contact: {
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
      phone: hasPhone ? `+9198${rng.int(10_000_000, 99_999_999)}` : undefined,
    },
    locale: rng.bool(0.45) ? "hi-IN" : "en-IN",
    optedOut: false,
    timezoneOffsetMin: 330, // IST
  };
}

type Built = {
  type: AtRiskCase["type"];
  signal: FailureSignal;
  amount: number; // paise
  method: AtRiskCase["originalMethod"];
  dueAt?: Millis;
  persona: Persona;
  truthRootCause: RootCause;
};

type Archetype = {
  weight: number;
  build: (rng: Rng, createdAt: Millis) => Built;
};

// Occasionally a large-ticket payment so the human-approval gate is exercised.
function payAmount(rng: Rng): number {
  return rng.bool(0.12) ? rupees(rng.int(30_000, 90_000)) : rupees(rng.int(200, 5_000));
}

const ARCHETYPES: Archetype[] = [
  {
    weight: 12, // insufficient funds — retry after funds arrive
    build: (rng, t) => ({
      type: "payment_failed",
      signal: { code: "BAD_REQUEST_ERROR", reason: "insufficient_funds", source: "customer", step: "payment_authorization", method: "card" },
      amount: payAmount(rng),
      method: "card",
      persona: { kind: "funds_on_date", fundsAt: t + rng.int(12, 96) * HOUR + (rng.bool(0.15) ? 12 * DAY : 0) },
      truthRootCause: "insufficient_funds",
    }),
  },
  {
    weight: 10, // issuing bank down — short-cooldown retry works
    build: (rng, t) => ({
      type: "payment_failed",
      signal: { code: "GATEWAY_ERROR", reason: "bank_down", source: "bank", step: "payment_authorization", method: "netbanking" },
      amount: payAmount(rng),
      method: "netbanking",
      persona: { kind: "transient", clearsAt: t + rng.int(0, 8) * HOUR },
      truthRootCause: "bank_downtime",
    }),
  },
  {
    weight: 6, // gateway timeout — transient
    build: (rng, t) => ({
      type: "payment_failed",
      signal: { code: "GATEWAY_ERROR", reason: "gateway_timeout", source: "gateway" },
      amount: rupees(rng.int(200, 5_000)),
      method: "upi",
      persona: { kind: "transient", clearsAt: t + rng.int(0, 4) * HOUR },
      truthRootCause: "gateway_error",
    }),
  },
  {
    weight: 8, // expired card — only a method-switch link works
    build: (rng) => ({
      type: "payment_failed",
      signal: { reason: "card_expired", source: "customer", method: "card" },
      amount: rupees(rng.int(300, 6_000)),
      method: "card",
      persona: { kind: "needs_new_method", reachable: rng.bool(0.75), respondP: rng.next() * 0.3 + 0.5 },
      truthRootCause: "card_expired",
    }),
  },
  {
    weight: 5, // risk / fraud decline — must escalate, never auto-retry
    build: (rng) => ({
      type: "payment_failed",
      signal: { reason: "payment_declined_risk", source: "bank", step: "payment_authorization" },
      amount: rupees(rng.int(500, 8_000)),
      method: "card",
      persona: { kind: "dead" },
      truthRootCause: "risk_declined",
    }),
  },
  {
    weight: 6, // authentication not completed — retry lets them finish OTP
    build: (rng, t) => ({
      type: "payment_failed",
      signal: { reason: "authentication_failed", source: "customer", step: "payment_authentication", method: "card" },
      amount: rupees(rng.int(300, 5_000)),
      method: "card",
      persona: { kind: "transient", clearsAt: t + rng.int(0, 5) * HOUR },
      truthRootCause: "authentication_failed",
    }),
  },
  {
    weight: 4, // per-txn limit — retry next day after reset
    build: (rng, t) => ({
      type: "payment_failed",
      signal: { reason: "payment_limit_exceeded", source: "customer", method: "upi" },
      amount: rupees(rng.int(1_000, 12_000)),
      method: "upi",
      persona: { kind: "funds_on_date", fundsAt: t + rng.int(20, 30) * HOUR },
      truthRootCause: "limit_exceeded",
    }),
  },
  {
    weight: 8, // subscription insufficient funds
    build: (rng, t) => ({
      type: "subscription_failed",
      signal: { reason: "insufficient_funds", source: "customer", method: "mandate" },
      amount: rupees(rng.int(150, 2_000)),
      method: "mandate",
      persona: { kind: "funds_on_date", fundsAt: t + rng.int(12, 120) * HOUR },
      truthRootCause: "insufficient_funds",
    }),
  },
  {
    weight: 7, // mandate revoked — needs re-authorization link
    build: (rng) => ({
      type: "subscription_failed",
      signal: { reason: "mandate_revoked", source: "customer", method: "mandate" },
      amount: rupees(rng.int(150, 2_500)),
      method: "mandate",
      persona: { kind: "needs_new_method", reachable: rng.bool(0.7), respondP: rng.next() * 0.3 + 0.45 },
      truthRootCause: "mandate_inactive",
    }),
  },
  {
    weight: 10, // abandoned at price/shipping — a capped incentive converts
    build: (rng) => ({
      type: "checkout_abandoned",
      signal: { source: "customer", description: "Left at payment page right after the shipping and price summary appeared." },
      amount: rupees(rng.int(500, 15_000)),
      method: "upi",
      persona: { kind: "price_sensitive", minIncentive: rupees(rng.int(100, 500)), respondP: rng.next() * 0.25 + 0.55 },
      truthRootCause: "buyer_price_sensitive",
    }),
  },
  {
    weight: 10, // abandoned by distraction — a reminder converts
    build: (rng) => ({
      type: "checkout_abandoned",
      signal: { source: "customer", description: "Added items to cart, reached checkout, then navigated away mid-flow." },
      amount: rupees(rng.int(400, 9_000)),
      method: "upi",
      persona: { kind: "distracted_reachable", respondP: rng.next() * 0.25 + 0.5 },
      truthRootCause: "buyer_distracted",
    }),
  },
  {
    weight: 5, // window shopper — genuinely no intent
    build: (rng) => ({
      type: "checkout_abandoned",
      signal: { source: "customer", description: "Browsed a few products, no checkout intent, single session." },
      amount: rupees(rng.int(300, 6_000)),
      method: "upi",
      persona: { kind: "dead" },
      truthRootCause: "unrecoverable",
    }),
  },
  {
    weight: 7, // B2B overdue, cashflow timing — capture a promise-to-pay
    build: (rng, t) => ({
      type: "invoice_overdue",
      signal: { source: "business", description: "Invoice overdue; buyer cited a temporary cashflow gap and said they'll clear it next week." },
      amount: rupees(rng.int(20_000, 300_000)),
      method: "netbanking",
      dueAt: t - rng.int(1, 10) * DAY,
      persona: { kind: "b2b_will_pay", payAround: t + rng.int(1, 6) * DAY, respondP: rng.next() * 0.25 + 0.6 },
      truthRootCause: "b2b_cashflow",
    }),
  },
  {
    weight: 4, // B2B overdue, disputed — escalate, do not chase
    build: (rng, t) => ({
      type: "invoice_overdue",
      signal: { source: "business", description: "Buyer is disputing invoice line items and raised a quality complaint." },
      amount: rupees(rng.int(25_000, 250_000)),
      method: "netbanking",
      dueAt: t - rng.int(1, 14) * DAY,
      persona: { kind: "b2b_dispute" },
      truthRootCause: "b2b_dispute",
    }),
  },
  {
    weight: 3, // B2B overdue, likely bad debt
    build: (rng, t) => ({
      type: "invoice_overdue",
      signal: { source: "business", description: "No response across prior reminders; likely bad debt." },
      amount: rupees(rng.int(15_000, 120_000)),
      method: "netbanking",
      dueAt: t - rng.int(5, 20) * DAY,
      persona: { kind: "dead" },
      truthRootCause: "unrecoverable",
    }),
  },
];

export function generateBatch(seed: number, n = 120): GeneratedBatch {
  const rng = makeRng(seed);
  const weighted = ARCHETYPES.map((a) => [a, a.weight] as const);
  const cases: AtRiskCase[] = [];
  const truth = new Map<string, Persona>();
  const truthRootCause = new Map<string, RootCause>();

  for (let i = 0; i < n; i++) {
    const id = `case_${(i + 1).toString().padStart(4, "0")}`;
    const customer = makeCustomer(rng, i + 1);
    const createdAt = rng.int(0, 12) * HOUR; // some start inside quiet hours
    const arch = rng.weighted(weighted);
    const b = arch.build(rng, createdAt);

    cases.push({
      id,
      type: b.type,
      customer,
      amount: b.amount,
      currency: "INR",
      createdAt,
      dueAt: b.dueAt,
      signal: b.signal,
      originalMethod: b.method,
      attempts: [],
      contacts: 0,
      status: "new",
    });
    truth.set(id, b.persona);
    truthRootCause.set(id, b.truthRootCause);
  }

  return { cases, truth, truthRootCause };
}
