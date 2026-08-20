// The recovery loop — the agent's control flow.
//
// It is an event-driven simulation over VIRTUAL time. Each case starts as a
// "process" event at its detection time; processing it runs one step of
// DETECT → DIAGNOSE → DECIDE → GATE → ACT, then either resolves the case or
// schedules the next step. Customer payments against links arrive as "inbound"
// events at their (simulated) settlement time.
//
// The safety-critical branch is `charge_unknown`: instead of re-charging a lost
// confirmation, the loop RECONCILES first and only recovers if money truly
// moved — which is exactly what keeps double-charges at zero.

import { diagnose } from "@/lib/engine/diagnose";
import { plan } from "@/lib/engine/policy";
import { gate, contactDayKey, type GuardContext } from "@/lib/engine/guardrails";
import type { Executor, RecoveryOutcome } from "@/lib/engine/executor";
import { Ledger } from "@/lib/ledger/ledger";
import type { RecoveryPolicy } from "@/lib/domain/config";
import type { AtRiskCase, Intervention, Millis, Paise } from "@/lib/domain/types";
import type { Llm } from "@/lib/ai/types";
import { formatINR } from "@/lib/core/money";
import { isWithinQuietHours } from "@/lib/core/time";

interface Ev {
  t: Millis;
  seq: number;
  kind: "process" | "inbound";
  caseId: string;
  gross?: Paise;
  incentive?: Paise;
}

export interface SafetyStats {
  doubleCharges: number;
  postOptOutContacts: number;
  quietHoursContacts: number;
  overspendBlocked: number;
  reconciliationsPreventingDoubleCharge: number;
}

export interface RunResult {
  cases: AtRiskCase[];
  ledger: Ledger;
  safety: SafetyStats;
  incentiveReservedPaise: Paise;
}

export interface RunOptions {
  policy: RecoveryPolicy;
  llm?: Llm;
  ledger?: Ledger;
  /** Pulls the double-charge count from the simulated world at the end. */
  getDoubleCharges?: () => number;
}

const truncate = (s?: string, n = 80): string =>
  !s ? "" : s.length <= n ? s : `${s.slice(0, n - 1)}…`;

export async function runRecovery(
  cases: AtRiskCase[],
  executor: Executor,
  options: RunOptions,
): Promise<RunResult> {
  const { policy } = options;
  const ledger = options.ledger ?? new Ledger();
  const byId = new Map(cases.map((c) => [c.id, c]));
  const ctx: GuardContext = {
    policy,
    incentiveSpentPaise: 0,
    contactsByCustomerDay: new Map(),
    approve: () => policy.autoApproveInSim, // mock approver in sim; real gate in prod
  };
  const safety: SafetyStats = {
    doubleCharges: 0,
    postOptOutContacts: 0,
    quietHoursContacts: 0,
    overspendBlocked: 0,
    reconciliationsPreventingDoubleCharge: 0,
  };

  // Small priority queue (linear min-scan; batch scale makes this trivial).
  let seq = 0;
  const queue: Ev[] = [];
  const schedule = (
    t: Millis,
    kind: Ev["kind"],
    caseId: string,
    extra?: { gross?: Paise; incentive?: Paise },
  ) => queue.push({ t, seq: seq++, kind, caseId, ...extra });
  const pop = (): Ev | undefined => {
    if (!queue.length) return undefined;
    let mi = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i];
      const b = queue[mi];
      if (a.t < b.t || (a.t === b.t && a.seq < b.seq)) mi = i;
    }
    return queue.splice(mi, 1)[0];
  };

  const quiet = (c: AtRiskCase, now: Millis) =>
    isWithinQuietHours(now, c.customer.timezoneOffsetMin, policy.quietHours.startHour, policy.quietHours.endHour);

  const resolveException = (c: AtRiskCase, now: Millis, reason: string, escalated = false) => {
    c.status = "exception";
    c.resolvedAt = now;
    c.exceptionReason = reason;
    ledger.append({
      at: now,
      caseId: c.id,
      type: "exception",
      summary: `${escalated ? "Escalated to human" : "Stopped"}: ${reason}.`,
      data: { reason, escalated },
    });
  };

  const handleOutcome = async (
    c: AtRiskCase,
    iv: Intervention,
    outcome: RecoveryOutcome,
    now: Millis,
  ) => {
    switch (outcome.kind) {
      case "charged_success": {
        c.attempts.push({
          at: now, kind: "retry_payment", method: outcome.method ?? c.originalMethod,
          idempotencyKey: outcome.idempotencyKey!, amount: c.amount, result: "success",
        });
        c.recoveredAmount = c.amount;
        c.status = "recovered";
        c.resolvedAt = now;
        ledger.append({ at: now, caseId: c.id, type: "action_result", summary: `Charge succeeded (${outcome.idempotencyKey}).` });
        ledger.append({ at: now, caseId: c.id, type: "recovered", summary: `Recovered ${formatINR(c.amount)} via retry.`, data: { gross: c.amount } });
        return;
      }
      case "charged_failed": {
        c.attempts.push({
          at: now, kind: "retry_payment", method: outcome.method ?? c.originalMethod,
          idempotencyKey: outcome.idempotencyKey!, amount: c.amount, result: "failed",
        });
        ledger.append({ at: now, caseId: c.id, type: "action_result", summary: `Charge failed (${outcome.idempotencyKey}).` });
        schedule(now, "process", c.id); // move to next rung
        return;
      }
      case "charge_unknown": {
        const key = outcome.idempotencyKey!;
        c.attempts.push({
          at: now, kind: "retry_payment", method: outcome.method ?? c.originalMethod,
          idempotencyKey: key, amount: c.amount, result: "unknown",
        });
        ledger.append({
          at: now, caseId: c.id, type: "action_result",
          summary: `Charge outcome UNKNOWN (lost confirmation) for ${key} — reconciling BEFORE any re-charge.`,
        });
        const truth = await executor.reconcile(key);
        c.attempts[c.attempts.length - 1].reconciledResult = truth;
        if (truth === "success") {
          safety.reconciliationsPreventingDoubleCharge++;
          c.recoveredAmount = c.amount;
          c.status = "recovered";
          c.resolvedAt = now;
          ledger.append({
            at: now, caseId: c.id, type: "reconciliation",
            summary: `Reconciled ${key}: money HAD been captured. Skipped re-charge (prevented a double-charge). Recovered ${formatINR(c.amount)}.`,
            data: { key, result: "success" },
          });
          ledger.append({ at: now, caseId: c.id, type: "recovered", summary: `Recovered ${formatINR(c.amount)} (confirmed via reconciliation).`, data: { gross: c.amount } });
        } else {
          ledger.append({ at: now, caseId: c.id, type: "reconciliation", summary: `Reconciled ${key}: no capture found. Safe to continue.`, data: { key, result: "failed" } });
          schedule(now, "process", c.id);
        }
        return;
      }
      case "message_sent": {
        c.contacts++;
        c.lastContactAt = now;
        const dayKey = contactDayKey(c.customer.id, now, c.customer.timezoneOffsetMin);
        ctx.contactsByCustomerDay.set(dayKey, (ctx.contactsByCustomerDay.get(dayKey) ?? 0) + 1);
        c.interventionCost = (c.interventionCost ?? 0) + (outcome.cost ?? 0);
        if (quiet(c, now)) safety.quietHoursContacts++;
        ledger.append({ at: now, caseId: c.id, type: "action_executed", summary: `Sent ${iv.kind} via ${iv.channel}: "${truncate(iv.message)}"` });
        if (outcome.willPayAt) {
          const incentive = iv.kind === "incentive_link" ? (iv.incentivePaise ?? 0) : 0;
          if (incentive) ctx.incentiveSpentPaise += incentive; // reserve against batch budget
          c.status = "waiting";
          c.nextActionAt = outcome.willPayAt;
          schedule(outcome.willPayAt, "inbound", c.id, { gross: c.amount, incentive });
          ledger.append({ at: now, caseId: c.id, type: "action_result", summary: `Customer will pay in ~${Math.round((outcome.willPayAt - now) / 3_600_000)}h.` });
        } else {
          c.status = "waiting";
          schedule(now, "process", c.id); // next rung
        }
        return;
      }
      case "opted_out": {
        c.contacts++;
        c.lastContactAt = now;
        c.customer.optedOut = true;
        c.interventionCost = (c.interventionCost ?? 0) + (outcome.cost ?? 0);
        ledger.append({ at: now, caseId: c.id, type: "opt_out", summary: `Customer opted out — halting all further contact and charges immediately.` });
        resolveException(c, now, "customer_opted_out");
        return;
      }
      case "escalated":
        resolveException(c, now, `escalated:${c.diagnosis?.rootCause ?? "unknown"}`, true);
        return;
      case "stopped":
        resolveException(c, now, iv.rationale);
        return;
      default:
        resolveException(c, now, "noop");
    }
  };

  // Seed the queue.
  for (const c of cases) {
    ledger.append({
      at: c.createdAt, caseId: c.id, type: "case_detected",
      summary: `Detected ${c.type} at risk: ${formatINR(c.amount)} — ${c.signal.reason ?? c.signal.description ?? "no signal"}.`,
      data: { type: c.type, amount: c.amount },
    });
    schedule(c.createdAt, "process", c.id);
  }

  // Drain.
  for (let ev = pop(); ev; ev = pop()) {
    const c = byId.get(ev.caseId)!;
    if (c.status === "recovered" || c.status === "exception") continue;
    const now = ev.t;

    if (ev.kind === "inbound") {
      if (now > c.createdAt + policy.caseDeadlineMs) {
        resolveException(c, now, "inbound_after_deadline");
        continue;
      }
      c.recoveredAmount = ev.gross;
      c.interventionCost = (c.interventionCost ?? 0) + (ev.incentive ?? 0);
      c.status = "recovered";
      c.resolvedAt = now;
      ledger.append({
        at: now, caseId: c.id, type: "recovered",
        summary: `Recovered ${formatINR(ev.gross ?? 0)} via customer payment${ev.incentive ? ` (incentive ${formatINR(ev.incentive)})` : ""}.`,
        data: { gross: ev.gross, incentive: ev.incentive },
      });
      continue;
    }

    // process
    if (!c.diagnosis) {
      c.status = "diagnosing";
      c.diagnosis = await diagnose(c, options.llm);
      ledger.append({
        at: now, caseId: c.id, type: "diagnosed",
        summary: `Diagnosed ${c.diagnosis.rootCause} (${Math.round(c.diagnosis.confidence * 100)}% via ${c.diagnosis.source}): ${c.diagnosis.rationale}`,
        data: { rootCause: c.diagnosis.rootCause, source: c.diagnosis.source, confidence: c.diagnosis.confidence },
      });
    }

    c.status = "planning";
    let iv = plan(c, now, policy);

    // Not time yet → wait.
    if (iv.kind !== "escalate_human" && iv.kind !== "stop" && iv.scheduledAt > now) {
      c.status = "waiting";
      c.nextActionAt = iv.scheduledAt;
      schedule(iv.scheduledAt, "process", c.id);
      continue;
    }

    ledger.append({
      at: now, caseId: c.id, type: "planned",
      summary: `Plan: ${iv.kind} — ${iv.rationale}`,
      data: { kind: iv.kind, requiresApproval: iv.requiresApproval, scheduledAt: iv.scheduledAt },
    });

    const decision = gate(c, iv, ctx, now);
    if (!decision.allowed) {
      ledger.append({ at: now, caseId: c.id, type: "gate_blocked", summary: `Blocked ${iv.kind}: ${decision.reason}.`, data: { reason: decision.reason } });
      if (decision.reason === "incentive_budget_exhausted") safety.overspendBlocked++;

      if (decision.retryAt && decision.retryAt > now) {
        c.status = "waiting";
        c.nextActionAt = decision.retryAt;
        schedule(decision.retryAt, "process", c.id);
        continue;
      }
      if (decision.fallback === "escalate_human") {
        resolveException(c, now, `escalated:${decision.reason}`, true);
        continue;
      }
      if (!decision.fallback || decision.fallback === "stop") {
        resolveException(c, now, decision.reason ?? "stopped");
        continue;
      }
      if (decision.fallback === "nudge") {
        iv = {
          kind: "nudge",
          scheduledAt: now,
          channel: c.customer.contact.phone ? "whatsapp" : "email",
          message: iv.message,
          rationale: `Fallback nudge (was ${iv.kind}: ${decision.reason}).`,
          requiresApproval: false,
        };
        const d2 = gate(c, iv, ctx, now);
        if (!d2.allowed) {
          if (d2.retryAt && d2.retryAt > now) {
            c.status = "waiting";
            schedule(d2.retryAt, "process", c.id);
            continue;
          }
          resolveException(c, now, d2.reason ?? "stopped");
          continue;
        }
      }
    }

    c.status = "acting";
    const outcome = await executor.execute(c, iv, now);
    await handleOutcome(c, iv, outcome, now);
  }

  safety.doubleCharges = options.getDoubleCharges?.() ?? 0;
  return { cases, ledger, safety, incentiveReservedPaise: ctx.incentiveSpentPaise };
}
