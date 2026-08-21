// POST /api/razorpay/webhook — receive real Razorpay events.
//
// Polling a payment link tells you the truth eventually; a webhook tells you the
// moment it happens. This is the production-shaped path: Razorpay calls us on
// `payment_link.paid` / `payment.captured`, we verify the HMAC signature, and
// the recovery is recorded in the same append-only ledger the batch writes to.
//
// Two things matter here and both are money-safety properties:
//   1. SIGNATURE VERIFICATION — an unverified webhook is an open door to
//      anyone who wants to mark invoices paid. Unsigned/invalid → 400, no state
//      change.
//   2. IDEMPOTENCY — Razorpay retries webhooks. We key on the event id and
//      ignore duplicates, so a redelivered "paid" can never be counted twice.

import Razorpay from "razorpay";
import { Ledger } from "@/lib/ledger/ledger";
import type { LedgerEvent } from "@/lib/ledger/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Process-local store. A real deployment writes these to the same durable
// ledger as the batch; keeping it in-process keeps the demo dependency-free.
const ledger = new Ledger();
const seenEventIds = new Set<string>();

interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment_link?: { entity?: { id?: string; reference_id?: string; amount?: number; status?: string } };
    payment?: { entity?: { id?: string; amount?: number; status?: string; error_reason?: string } };
  };
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return Response.json(
      { ok: false, reason: "not_configured", message: "Set RAZORPAY_WEBHOOK_SECRET to enable webhooks." },
      { status: 503 },
    );
  }

  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";

  let valid = false;
  try {
    valid = Razorpay.validateWebhookSignature(raw, signature, secret);
  } catch {
    valid = false;
  }
  if (!valid) {
    // Never touch state on an unverified event.
    return Response.json({ ok: false, reason: "invalid_signature" }, { status: 400 });
  }

  // Idempotency: Razorpay retries until it gets a 2xx.
  const eventId = req.headers.get("x-razorpay-event-id") ?? "";
  if (eventId && seenEventIds.has(eventId)) {
    return Response.json({ ok: true, duplicate: true, eventId });
  }
  if (eventId) seenEventIds.add(eventId);

  const body = JSON.parse(raw) as RazorpayWebhookBody;
  const link = body.payload?.payment_link?.entity;
  const payment = body.payload?.payment?.entity;
  // reference_id is the case id we set when creating the link.
  const caseId = link?.reference_id?.replace(/-live$/, "") ?? "unknown";
  const at = Date.now();

  switch (body.event) {
    case "payment_link.paid": {
      ledger.append({
        at,
        caseId,
        type: "recovered",
        summary: `Webhook: payment link ${link?.id} PAID — recovery confirmed by Razorpay (not polled).`,
        data: { linkId: link?.id, amount: link?.amount, eventId, source: "webhook" },
      });
      break;
    }
    case "payment.captured": {
      ledger.append({
        at,
        caseId,
        type: "action_result",
        summary: `Webhook: payment ${payment?.id} captured (${payment?.amount} paise).`,
        data: { paymentId: payment?.id, amount: payment?.amount, eventId, source: "webhook" },
      });
      break;
    }
    case "payment.failed": {
      ledger.append({
        at,
        caseId,
        type: "action_result",
        summary: `Webhook: payment ${payment?.id} failed (${payment?.error_reason ?? "unknown"}).`,
        data: { paymentId: payment?.id, reason: payment?.error_reason, eventId, source: "webhook" },
      });
      break;
    }
    default:
      ledger.append({
        at,
        caseId,
        type: "action_result",
        summary: `Webhook: unhandled event ${body.event}.`,
        data: { eventId, event: body.event },
      });
  }

  return Response.json({ ok: true, event: body.event, caseId, events: ledger.count() });
}

/** GET returns what the webhook has recorded — handy for the demo. */
export async function GET(): Promise<Response> {
  const events: readonly LedgerEvent[] = ledger.all();
  return Response.json({
    configured: Boolean(process.env.RAZORPAY_WEBHOOK_SECRET?.trim()),
    count: events.length,
    events,
  });
}
