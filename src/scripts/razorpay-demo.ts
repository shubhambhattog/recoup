// Proof that the real Razorpay test-mode integration works end to end:
//   npm run razorpay:demo
//
// 1) creates a real TEST payment link (visible in your Razorpay dashboard),
// 2) re-creates it with the SAME reference_id → idempotent, no duplicate link,
// 3) reconciles by fetching the link's live status.
// Open the printed link, pay it with a test method, then re-run to watch the
// status flip to "paid".

import { loadEnv } from "@/lib/core/env";
loadEnv();

import { razorpayConfigured, createPaymentLink, fetchPaymentLink } from "@/lib/razorpay/client";

async function main() {
  if (!razorpayConfigured()) {
    console.log("Razorpay keys not set. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test keys) to .env.local.");
    return;
  }

  const ref = `recoup-demo-${process.env.DEMO_REF ?? "case_0042"}`;
  const amountPaise = 249900;

  console.log("1) Creating a real Razorpay TEST payment link…");
  const a = await createPaymentLink({
    amountPaise,
    referenceId: ref,
    description: "Recoup demo — recover ₹2,499 (card_expired → switch method)",
    customer: { name: "Rohan Mehta", email: "rohan@example.com", contact: "+919800000000" },
    notes: { source: "recoup-demo" },
  });
  console.log(`   ✓ ${a.view.shortUrl}`);
  console.log(`     id=${a.view.id}  status=${a.view.status}  ref=${ref}`);

  console.log("\n2) Idempotency — creating again with the SAME reference_id…");
  const b = await createPaymentLink({
    amountPaise,
    referenceId: ref,
    description: "duplicate attempt",
    customer: { name: "Rohan Mehta" },
  });
  console.log(`   idempotentReuse=${b.idempotentReuse}  sameLink=${b.view.id === a.view.id}`);
  console.log(`   → ${b.view.id === a.view.id ? "no duplicate link created; a customer can never be double-charged." : "WARNING: different link returned."}`);

  console.log("\n3) Reconcile — fetching the link's live status…");
  const live = await fetchPaymentLink(a.view.id);
  console.log(`   status=${live?.status}  amountPaid=₹${((live?.amountPaid ?? 0) / 100).toFixed(2)}`);

  console.log(`\nOpen the link, pay with a test method, then re-run:  DEMO_REF=${process.env.DEMO_REF ?? "case_0042"} npm run razorpay:demo`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
