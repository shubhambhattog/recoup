// All money in Recoup is integer paise (₹1 = 100 paise), matching Razorpay's
// API. Floats never touch a monetary value.

import type { Paise } from "@/lib/domain/types";

/** Rupees → paise. */
export const rupees = (r: number): Paise => Math.round(r * 100);

/** Paise → rupees (for display / analytics only). */
export const toRupees = (p: Paise): number => p / 100;

/** Format paise as an INR string with Indian digit grouping (lakh/crore). */
export function formatINR(p: Paise): string {
  const neg = p < 0;
  const abs = Math.abs(p);
  const whole = Math.floor(abs / 100);
  const paise = abs % 100;

  const s = whole.toString();
  let grouped: string;
  if (s.length <= 3) {
    grouped = s;
  } else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${rest},${last3}`;
  }

  const body = paise ? `${grouped}.${paise.toString().padStart(2, "0")}` : grouped;
  return `${neg ? "-" : ""}₹${body}`;
}

/** Compact INR for dashboards: ₹1.2L, ₹3.4Cr. */
export function formatINRCompact(p: Paise): string {
  const r = toRupees(p);
  const abs = Math.abs(r);
  const sign = r < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}k`;
  return formatINR(p);
}
