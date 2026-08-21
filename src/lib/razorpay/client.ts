// A thin, typed wrapper over the Razorpay Node SDK (test mode).
//
// Only the pieces Recoup needs: create a Payment Link, look one up by our own
// reference id (that's how we get idempotency — Razorpay rejects a duplicate
// reference_id, so we treat the collision as "already created" instead of
// making a second link), and fetch a link's live status (that's a real
// reconciliation source). Everything money-moving here is idempotent by
// construction, mirroring the guarantee the simulator models.

import Razorpay from "razorpay";

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

/** Returns null (not throws) when keys are absent so callers can degrade gracefully. */
export function getRazorpayCredentials(): RazorpayCredentials | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  if (keyId.includes("xxxx")) return null; // placeholder left from .env.example
  return { keyId, keySecret };
}

export function razorpayConfigured(): boolean {
  return getRazorpayCredentials() !== null;
}

export function isLiveKey(): boolean {
  const id = getRazorpayCredentials()?.keyId ?? "";
  return id.startsWith("rzp_live_");
}

let client: Razorpay | null = null;
function rzp(): Razorpay {
  const creds = getRazorpayCredentials();
  if (!creds) {
    throw new Error(
      "Razorpay keys not set. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (TEST keys, rzp_test_…) to .env.local.",
    );
  }
  if (!client) client = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
  return client;
}

export interface PaymentLinkView {
  id: string;
  shortUrl: string;
  status: string; // created | partially_paid | paid | expired | cancelled
  referenceId?: string;
  amount: number; // paise
  amountPaid: number; // paise
}

// The SDK's returned link object; we only read a few fields.
interface RawLink {
  id: string;
  short_url?: string;
  status?: string;
  reference_id?: string;
  amount?: number | string;
  amount_paid?: number | string;
}

function toView(link: RawLink, referenceId?: string): PaymentLinkView {
  return {
    id: String(link.id),
    shortUrl: String(link.short_url ?? ""),
    status: String(link.status ?? "created"),
    referenceId: referenceId ?? link.reference_id,
    amount: Number(link.amount ?? 0),
    amountPaid: Number(link.amount_paid ?? 0),
  };
}

/**
 * In-process idempotency store, keyed by our reference_id.
 *
 * Razorpay itself is the durable guarantee — it rejects a duplicate
 * reference_id — but its *list* endpoint is read-after-write eventually
 * consistent: a link created milliseconds ago may not yet appear in
 * `paymentLink.all({reference_id})`. Without this cache, an immediate retry of
 * the same step sees "duplicate" from create and "not found" from list, and
 * would surface an error for what is actually a safe, already-completed action.
 * (Found by running the live batch — see FAILURE_STORY.md.)
 */
const linksByReference = new Map<string, PaymentLinkView>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function createPaymentLink(input: {
  amountPaise: number;
  referenceId: string;
  description: string;
  customer: { name: string; email?: string; contact?: string };
  notes?: Record<string, string>;
}): Promise<{ view: PaymentLinkView; idempotentReuse: boolean }> {
  const api = rzp();

  // Fast path: we already created this exact reference in this process.
  const cached = linksByReference.get(input.referenceId);
  if (cached) return { view: cached, idempotentReuse: true };

  try {
    const link = await api.paymentLink.create({
      amount: input.amountPaise,
      currency: "INR",
      accept_partial: false,
      reference_id: input.referenceId,
      description: input.description.slice(0, 2048),
      customer: {
        name: input.customer.name,
        email: input.customer.email,
        contact: input.customer.contact,
      },
      notify: { email: !!input.customer.email, sms: !!input.customer.contact },
      reminder_enable: true,
      notes: input.notes,
    });
    const view = toView(link as RawLink, input.referenceId);
    linksByReference.set(input.referenceId, view);
    return { view, idempotentReuse: false };
  } catch (err) {
    // A duplicate reference_id means this link already exists — return it
    // rather than creating a second one. The list endpoint can lag behind the
    // write, so retry briefly before giving up.
    if (!isDuplicateReferenceError(err)) throw err;
    for (const delay of [0, 400, 1200]) {
      if (delay) await sleep(delay);
      const existing = await findLinkByReference(input.referenceId);
      if (existing) {
        linksByReference.set(input.referenceId, existing);
        return { view: existing, idempotentReuse: true };
      }
    }
    throw err;
  }
}

/** Razorpay reports an already-used reference_id as a 400 BAD_REQUEST_ERROR. */
function isDuplicateReferenceError(err: unknown): boolean {
  const e = err as { statusCode?: number; error?: { description?: string } } | undefined;
  const desc = e?.error?.description ?? "";
  return e?.statusCode === 400 && /reference_id/i.test(desc) && /already exists/i.test(desc);
}

export async function findLinkByReference(referenceId: string): Promise<PaymentLinkView | null> {
  const api = rzp();
  const res = await api.paymentLink.all({
    reference_id: referenceId,
  } as unknown as Parameters<typeof api.paymentLink.all>[0]);
  const link = res?.payment_links?.[0] as RawLink | undefined;
  return link ? toView(link, referenceId) : null;
}

export async function fetchPaymentLink(id: string): Promise<PaymentLinkView | null> {
  const api = rzp();
  const link = (await api.paymentLink.fetch(id)) as RawLink | null;
  return link ? toView(link) : null;
}
