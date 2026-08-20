// Virtual-time helpers. The batch runs on a simulated clock (Millis from an
// arbitrary epoch), so ten days of retry scheduling resolve instantly and
// identically on every run. No wall-clock, no Date.now() in the engine.

import type { Millis } from "@/lib/domain/types";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const addMinutes = (t: Millis, m: number): Millis => t + m * MINUTE;
export const addHours = (t: Millis, h: number): Millis => t + h * HOUR;
export const addDays = (t: Millis, d: number): Millis => t + d * DAY;

/** Local hour-of-day (0..23) for a virtual instant, given a tz offset in minutes. */
export function localHour(t: Millis, tzOffsetMin: number): number {
  const local = t + tzOffsetMin * MINUTE;
  return ((Math.floor(local / HOUR) % 24) + 24) % 24;
}

/** Local day index since epoch — used for per-day contact caps. */
export function localDayIndex(t: Millis, tzOffsetMin: number): number {
  return Math.floor((t + tzOffsetMin * MINUTE) / DAY);
}

/** Is this instant inside the customer's quiet hours (no contact allowed)? */
export function isWithinQuietHours(
  t: Millis,
  tzOffsetMin: number,
  startHour: number,
  endHour: number,
): boolean {
  const h = localHour(t, tzOffsetMin);
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  // wraps midnight, e.g. 21:00 → 09:00
  return h >= startHour || h < endHour;
}

/** Earliest instant >= t that is outside quiet hours. */
export function nextAllowedContactTime(
  t: Millis,
  tzOffsetMin: number,
  startHour: number,
  endHour: number,
): Millis {
  let cur = t;
  for (let i = 0; i < 48; i++) {
    if (!isWithinQuietHours(cur, tzOffsetMin, startHour, endHour)) return cur;
    cur += 30 * MINUTE;
  }
  return cur;
}

/** Next occurrence (>= t) of a given local hour of day. */
export function nextLocalHour(t: Millis, tzOffsetMin: number, targetHour: number): Millis {
  const h = localHour(t, tzOffsetMin);
  const deltaHours = (targetHour - h + 24) % 24 || 24; // strictly in the future
  return t + deltaHours * HOUR;
}
