// A thin, typed wrapper over the Razorpay Node SDK (test mode).
//
// Only the pieces Recoup needs: create a Payment Link, look one up by our own
// reference id, and fetch a link's live status (a real reconciliation source).
//
// SAFETY NOTE — notifications are OFF by default.
// Razorpay will happily SMS/email the `customer.contact` you hand it, and keep
// re-sending if `reminder_enable` is set. Our synthetic customers carry
// real-FORMAT Indian mobile numbers (the emails are reserved @example.com, but
// there is no reserved mobile range), so enabling delivery on generated data
// means messaging real strangers. We learned this the hard way — see
// FAILURE_STORY.md. Delivery now requires an explicit opt-in per call, and the
// live scripts never pass a phone number at all.

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

/**
 * Master switch for outbound delivery. Even with this set, a caller must still
 * pass `notify` explicitly — two locks, because the failure mode is messaging
 * real people.
 */
export function notificationsAllowed(): boolean {
  return process.env.RAZORPAY_ALLOW_NOTIFICATIONS === "1";
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

interface RawLink {
  id: string;
  short_url?: string;
  status?: string;
  reference_id?: string;
  amount?: number | string;
  amount_paid?: number | string;
}

/** Note: never overwrites the link's real reference_id — a mismatch must stay visible. */
function toView(link: RawLink): PaymentLinkView {
  return {
    id: String(link.id),
    shortUrl: String(link.short_url ?? ""),
    status: String(link.status ?? "created"),
    referenceId: link.reference_id,
    amount: Number(link.amount ?? 0),
    amountPaid: Number(link.amount_paid ?? 0),
  };
}

/**
 * In-process record of reference_id → link id, so repeating a step does not
 * create a duplicate. We deliberately cache only the ID, not the link's state:
 * status and amount_paid change when the customer pays, and a cached snapshot
 * would report a paid link as still "created".
 */
const linkIdByReference = new Map<string, string>();
const MAX_CACHED = 500;

function rememberLink(referenceId: string, id: string): void {
  if (linkIdByReference.size >= MAX_CACHED) {
    const oldest = linkIdByReference.keys().next().value;
    if (oldest !== undefined) linkIdByReference.delete(oldest);
  }
  linkIdByReference.set(referenceId, id);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CreateLinkInput {
  amountPaise: number;
  referenceId: string;
  description: string;
  customer: { name: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  /**
   * Outbound delivery. Defaults to NO email, NO SMS, NO reminders. Only set
   * this for a real customer you are certain about — see the safety note above.
   */
  notify?: { email?: boolean; sms?: boolean };
  reminderEnable?: boolean;
  /** Link expiry (unix seconds). Prevents an unpaid link lingering forever. */
  expireBy?: number;
}

export async function createPaymentLink(
  input: CreateLinkInput,
): Promise<{ view: PaymentLinkView; idempotentReuse: boolean }> {
  const api = rzp();

  // Fast path: this reference already produced a link in this process. Fetch it
  // fresh rather than trusting a stale snapshot.
  const knownId = linkIdByReference.get(input.referenceId);
  if (knownId) {
    const live = await fetchPaymentLink(knownId).catch(() => null);
    if (live) return { view: live, idempotentReuse: true };
  }

  // Delivery is off unless BOTH the env switch and this call opt in.
  const allow = notificationsAllowed();
  const notify = {
    email: allow && input.notify?.email === true,
    sms: allow && input.notify?.sms === true,
  };
  const reminderEnable = allow && input.reminderEnable === true;

  let lastErr: unknown;
  // Retrying a create is safe precisely because reference_id is idempotent:
  // if the first attempt did land, the retry is rejected as a duplicate and we
  // fall through to the existence check below.
  for (let attempt = 0; attempt < 3; attempt++) {
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
        notify,
        reminder_enable: reminderEnable,
        notes: input.notes,
        ...(input.expireBy ? { expire_by: input.expireBy } : {}),
      });
      const view = toView(link as RawLink);
      rememberLink(input.referenceId, view.id);
      return { view, idempotentReuse: false };
    } catch (err) {
      lastErr = err;
      if (isRateLimited(err) && attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      break;
    }
  }

  {
    const err = lastErr;
    // Any failure here may mean the link was actually created and we lost the
    // response — not just an explicit duplicate. So we always ask whether it
    // exists before concluding anything, and never re-create blindly.
    //
    // Razorpay's list endpoint is read-after-write eventually consistent. The
    // ladder below is sized from measurement, not guesswork: `npm run
    // measure:lag` polls the list endpoint after a create and records how long
    // the link takes to appear. Observed over 5 samples — mean 1465ms, p90
    // 2120ms, max 2120ms (artifacts/lag-measurement.json). ~6s of total waiting
    // is roughly 3x the observed worst case.
    //
    // Each attempt is isolated: a transient list error must not abort the rest.
    for (const delay of [0, 500, 1500, 4000]) {
      if (delay) await sleep(delay);
      try {
        const existing = await findLinkByReference(input.referenceId);
        if (existing) {
          rememberLink(input.referenceId, existing.id);
          return { view: existing, idempotentReuse: true };
        }
      } catch {
        // keep trying — the lookup failing tells us nothing about the link
      }
    }
    throw asError(err, `Failed to create payment link for reference ${input.referenceId}`);
  }
}

/** Razorpay throttles bursts; a 429 is transient and worth waiting out. */
function isRateLimited(err: unknown): boolean {
  const e = err as { statusCode?: number; error?: { description?: string } } | undefined;
  return e?.statusCode === 429 || /too many requests/i.test(e?.error?.description ?? "");
}

/** The SDK rejects with a plain object; make it a real Error so callers can log it. */
function asError(err: unknown, context: string): Error {
  if (err instanceof Error) return err;
  const e = err as { statusCode?: number; error?: { code?: string; description?: string } };
  const detail = e?.error?.description ?? JSON.stringify(err);
  const out = new Error(`${context}: ${detail}`);
  Object.assign(out, { statusCode: e?.statusCode, razorpayError: e?.error });
  return out;
}

/**
 * Look a link up by OUR reference id. Verifies the returned link really carries
 * that reference — the SDK does not type this filter, so if Razorpay ever
 * ignored it we would otherwise adopt an unrelated customer's link as our own.
 */
export async function findLinkByReference(referenceId: string): Promise<PaymentLinkView | null> {
  const api = rzp();
  const res = await api.paymentLink.all({
    reference_id: referenceId,
  } as unknown as Parameters<typeof api.paymentLink.all>[0]);
  const links = (res?.payment_links ?? []) as RawLink[];
  const match = links.find((l) => l.reference_id === referenceId);
  return match ? toView(match) : null;
}

export async function fetchPaymentLink(id: string): Promise<PaymentLinkView | null> {
  const api = rzp();
  const link = (await api.paymentLink.fetch(id)) as RawLink | null;
  return link ? toView(link) : null;
}

export async function cancelPaymentLink(id: string): Promise<PaymentLinkView | null> {
  const api = rzp();
  const link = (await api.paymentLink.cancel(id)) as RawLink | null;
  return link ? toView(link) : null;
}
