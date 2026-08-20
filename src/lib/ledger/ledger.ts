// Append-only audit ledger. Every decision and every money action is written
// here, in order, with the reasoning that produced it. This IS the audit trail
// the Track 03 bar demands: nothing the agent does to money happens off-ledger,
// and the whole run is replayable from these events.

import type { Millis } from "@/lib/domain/types";

export type LedgerEventType =
  | "case_detected"
  | "diagnosed"
  | "planned"
  | "gate_blocked"
  | "action_executed"
  | "action_retried" // transient API error handled with backoff
  | "action_result"
  | "reconciliation" // resolved an unknown/lost charge outcome
  | "recovered"
  | "exception"
  | "opt_out";

export interface LedgerEvent {
  seq: number;
  at: Millis; // virtual time of the event
  caseId: string;
  type: LedgerEventType;
  summary: string; // human-readable line
  data?: Record<string, unknown>; // structured detail (amounts, keys, results)
}

export class Ledger {
  private events: LedgerEvent[] = [];
  private seq = 0;

  append(e: Omit<LedgerEvent, "seq">): LedgerEvent {
    const ev: LedgerEvent = { seq: this.seq++, ...e };
    this.events.push(ev);
    return ev;
  }

  forCase(caseId: string): LedgerEvent[] {
    return this.events.filter((e) => e.caseId === caseId);
  }

  all(): readonly LedgerEvent[] {
    return this.events;
  }

  count(): number {
    return this.events.length;
  }

  /** One event per line — the canonical replayable audit format. */
  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n");
  }
}
