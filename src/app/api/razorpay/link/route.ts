// POST /api/razorpay/link — create a REAL Razorpay test-mode Payment Link for a
// case, or reconcile one by id. Degrades gracefully (ok:false) when no keys are
// configured, so the dashboard can show a friendly "add your test keys" state
// instead of erroring.

import { razorpayConfigured, createPaymentLink, fetchPaymentLink } from "@/lib/razorpay/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  action?: "create" | "reconcile";
  id?: string;
  referenceId?: string;
  amountPaise?: number;
  description?: string;
  name?: string;
  email?: string;
  contact?: string;
  notes?: Record<string, string>;
}

export async function POST(req: Request): Promise<Response> {
  if (!razorpayConfigured()) {
    return Response.json({
      ok: false,
      reason: "not_configured",
      message: "Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test keys, rzp_test_…) to .env.local to enable live links.",
    });
  }

  const body = (await req.json().catch(() => ({}))) as Body;

  try {
    if (body.action === "reconcile") {
      const link = await fetchPaymentLink(String(body.id));
      return Response.json({ ok: true, link });
    }

    const res = await createPaymentLink({
      amountPaise: Math.max(100, Math.round(Number(body.amountPaise) || 100)),
      referenceId: String(body.referenceId || `recoup-${Date.now()}`),
      description: String(body.description || "Recoup — payment recovery"),
      customer: {
        name: String(body.name || "Customer"),
        email: body.email,
        contact: body.contact,
      },
      notes: body.notes,
    });
    return Response.json({ ok: true, ...res });
  } catch (e) {
    return Response.json({
      ok: false,
      reason: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
