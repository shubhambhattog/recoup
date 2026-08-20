"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ScenarioResult } from "@/lib/engine/run";
import type { AtRiskCase } from "@/lib/domain/types";
import type { LedgerEvent, LedgerEventType } from "@/lib/ledger/ledger";
import { formatINR, formatINRCompact } from "@/lib/core/money";

// ---------- static maps ----------

const TYPE_LABEL: Record<string, string> = {
  payment_failed: "PAY",
  subscription_failed: "SUB",
  checkout_abandoned: "CART",
  invoice_overdue: "INV",
};

const EVENT_COLOR: Record<LedgerEventType, string> = {
  case_detected: "var(--faint)",
  diagnosed: "var(--blue)",
  planned: "var(--muted)",
  gate_blocked: "var(--amber)",
  action_executed: "var(--muted)",
  action_retried: "var(--amber)",
  action_result: "var(--muted)",
  reconciliation: "var(--cyan)",
  recovered: "var(--emerald)",
  exception: "var(--red)",
  opt_out: "var(--red)",
};

const ESCALATED_BY_DESIGN = new Set(["risk_declined", "b2b_dispute", "unrecoverable"]);

type Bucket = "recovered" | "escalated" | "stopped" | "inflight";
function bucketOf(c: AtRiskCase): Bucket {
  if (c.status === "recovered") return "recovered";
  if (c.status === "exception")
    return (c.exceptionReason ?? "").startsWith("escalated") ? "escalated" : "stopped";
  return "inflight";
}
const BUCKET_COLOR: Record<Bucket, string> = {
  recovered: "var(--emerald)",
  escalated: "var(--violet)",
  stopped: "var(--red)",
  inflight: "var(--amber)",
};

const fmtT = (at: number) => `t+${Math.round(at / 3_600_000)}h`;
const shortId = (id: string) => `#${id.replace(/[^0-9]/g, "").replace(/^0+/, "")}`;

// ---------- small components ----------

function Stat({
  label,
  value,
  sub,
  tone = "var(--text)",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="card px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">{label}</div>
      <div className="mono mt-1 text-2xl font-semibold leading-tight" style={{ color: tone }}>
        {value}
      </div>
      {sub && <div className="mono mt-0.5 text-xs text-[var(--faint)]">{sub}</div>}
    </div>
  );
}

function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card flex flex-col ${className}`}>
      <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
        <h2 className="text-[13px] font-semibold tracking-wide text-[var(--text)]">{title}</h2>
        {right}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-2)]">
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

// ---------- main ----------

export default function Dashboard() {
  const [data, setData] = useState<ScenarioResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [seed, setSeed] = useState(42);
  const [n, setN] = useState(120);
  const [lostP, setLostP] = useState(0.14);
  const [apiP, setApiP] = useState(0.1);
  const [filter, setFilter] = useState<Bucket | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed, n, chaos: { lostConfirmationP: lostP, apiErrorP: apiP } }),
      });
      const json: ScenarioResult = await res.json();
      setData(json);
      // Auto-select a reconciliation case — the money-critical failure handled well.
      const rec = json.ledger.find(
        (e) => e.type === "reconciliation" && (e.data as { result?: string })?.result === "success",
      );
      setSelected(rec?.caseId ?? json.cases[0]?.id ?? null);
    } finally {
      setLoading(false);
    }
  }, [seed, n, lostP, apiP]);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const caseById = useMemo(() => {
    const m = new Map<string, AtRiskCase>();
    data?.cases.forEach((c) => m.set(c.id, c));
    return m;
  }, [data]);

  const trace = useMemo<LedgerEvent[]>(() => {
    if (!data || !selected) return [];
    return data.ledger.filter((e) => e.caseId === selected).sort((a, b) => a.seq - b.seq);
  }, [data, selected]);

  const buckets = useMemo(() => {
    const b: Record<Bucket, AtRiskCase[]> = { recovered: [], escalated: [], stopped: [], inflight: [] };
    data?.cases.forEach((c) => b[bucketOf(c)].push(c));
    return b;
  }, [data]);

  const visibleCases = useMemo(() => {
    if (!data) return [];
    const list = filter === "all" ? data.cases : buckets[filter];
    return [...list].sort((a, b) => b.amount - a.amount);
  }, [data, buckets, filter]);

  const r = data?.report;
  const bl = data?.baseline;

  const compare = useMemo(() => {
    if (!r || !bl) return null;
    const payGross = r.byType
      .filter((t) => t.type === "payment_failed" || t.type === "subscription_failed")
      .reduce((s, t) => s + t.grossRecovered, 0);
    const mult = bl.grossRecoveredPaise > 0 ? payGross / bl.grossRecoveredPaise : 0;
    const unlocked = r.grossRecoveredPaise - payGross;
    return { payGross, mult, unlocked };
  }, [r, bl]);

  return (
    <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col gap-4 px-4 py-5 lg:px-6">
      {/* Header */}
      <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <span
              className="grid h-7 w-7 place-items-center rounded-lg text-sm font-bold text-[var(--bg)]"
              style={{ background: "var(--emerald)" }}
            >
              ₹
            </span>
            <h1 className="text-lg font-semibold tracking-tight">Recoup</h1>
            <span className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Razorpay · Track 03
            </span>
          </div>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            Bounded revenue-recovery agent — recovers more than naive retries, and{" "}
            <span className="text-[var(--text)]">can&apos;t misbehave with money</span>.
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Seed
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
              className="mono w-20 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-sm text-[var(--text)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Cases
            <input
              type="number"
              value={n}
              min={10}
              max={300}
              onChange={(e) => setN(Number(e.target.value))}
              className="mono w-20 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-sm text-[var(--text)]"
            />
          </label>
          <label className="flex w-36 flex-col gap-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Lost-confirm {Math.round(lostP * 100)}%
            <input type="range" min={0} max={50} value={Math.round(lostP * 100)} onChange={(e) => setLostP(Number(e.target.value) / 100)} />
          </label>
          <label className="flex w-36 flex-col gap-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">
            API-error {Math.round(apiP * 100)}%
            <input type="range" min={0} max={50} value={Math.round(apiP * 100)} onChange={(e) => setApiP(Number(e.target.value) / 100)} />
          </label>
          <button
            onClick={run}
            disabled={loading}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-[var(--bg)] transition disabled:opacity-60"
            style={{ background: "var(--emerald)" }}
          >
            {loading ? "Running…" : "▶ Run batch"}
          </button>
        </div>
      </header>

      {!data || !r || !bl || !compare ? (
        <div className="grid flex-1 place-items-center text-[var(--muted)]">Running recovery batch…</div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat
              label="Net recovered"
              value={formatINRCompact(r.netRecoveredPaise)}
              sub={`of ${formatINRCompact(r.totalAtRiskPaise)} at risk`}
              tone="var(--emerald)"
            />
            <Stat
              label="Recovery rate"
              value={`${(r.recoveryRate * 100).toFixed(1)}%`}
              sub={`${r.recovered}/${r.totalCases} cases`}
            />
            <Stat
              label="vs naive baseline"
              value={`${compare.mult.toFixed(1)}×`}
              sub={`+${formatINRCompact(compare.unlocked)} unlocked`}
              tone="var(--blue)"
            />
            <Stat
              label="Double charges"
              value={String(r.safety.doubleCharges)}
              sub={`${r.safety.reconciliationsPreventingDoubleCharge} prevented via reconcile`}
              tone={r.safety.doubleCharges === 0 ? "var(--emerald)" : "var(--red)"}
            />
            <Stat
              label="Escalated / stopped"
              value={`${r.escalated} / ${r.stopped}`}
              sub={`avg ${r.avgHoursToRecovery.toFixed(0)}h to recover`}
              tone="var(--violet)"
            />
          </div>

          {/* Main: board + trace */}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-12">
            {/* Case board */}
            <Panel
              title="Case board"
              className="lg:col-span-7"
              right={
                <div className="flex gap-1">
                  {(["all", "recovered", "escalated", "stopped", "inflight"] as const).map((f) => {
                    const count = f === "all" ? data.cases.length : buckets[f].length;
                    const active = filter === f;
                    return (
                      <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className="rounded-md px-2 py-1 text-[11px] capitalize transition"
                        style={{
                          background: active ? "var(--panel-2)" : "transparent",
                          color: active ? "var(--text)" : "var(--muted)",
                          border: `1px solid ${active ? "var(--border-2)" : "transparent"}`,
                        }}
                      >
                        {f} <span className="mono text-[var(--faint)]">{count}</span>
                      </button>
                    );
                  })}
                </div>
              }
            >
              <div className="grid max-h-[460px] grid-cols-2 gap-2 overflow-y-auto p-3 sm:grid-cols-3 xl:grid-cols-4">
                {visibleCases.map((c) => {
                  const bk = bucketOf(c);
                  const active = selected === c.id;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setSelected(c.id)}
                      className="card-2 flex flex-col gap-1 p-2.5 text-left transition"
                      style={{ borderColor: active ? BUCKET_COLOR[bk] : undefined }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="mono text-[11px] text-[var(--muted)]">{shortId(c.id)}</span>
                        <span className="rounded bg-[var(--bg-2)] px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-[var(--muted)]">
                          {TYPE_LABEL[c.type]}
                        </span>
                      </div>
                      <div className="mono text-sm font-semibold">{formatINRCompact(c.amount)}</div>
                      <div className="flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: BUCKET_COLOR[bk] }} />
                        <span className="truncate text-[10px] text-[var(--faint)]">
                          {c.diagnosis?.rootCause ?? c.status}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </Panel>

            {/* Ledger trace */}
            <Panel
              title="Audit trail"
              className="lg:col-span-5"
              right={<span className="mono text-[11px] text-[var(--faint)]">{selected ? shortId(selected) : ""}</span>}
            >
              {selected && caseById.get(selected) ? (
                <TraceView c={caseById.get(selected)!} trace={trace} />
              ) : (
                <div className="grid h-full place-items-center p-6 text-sm text-[var(--muted)]">
                  Select a case to replay its full decision trail.
                </div>
              )}
            </Panel>
          </div>

          {/* Bottom: baseline + safety + causes */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel title="Agent vs naive baseline">
              <div className="flex flex-col gap-3 p-4">
                <div className="text-[11px] text-[var(--muted)]">
                  Like-for-like — payments &amp; subscriptions only (all a naive retry can touch)
                </div>
                <CompareRow label="Recoup" value={compare.payGross} max={compare.payGross} color="var(--emerald)" />
                <CompareRow label="Baseline" value={bl.grossRecoveredPaise} max={compare.payGross} color="var(--muted)" />
                <div className="grad-line h-px" />
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-[var(--muted)]">Unlocked beyond baseline</span>
                  <span className="mono font-semibold text-[var(--blue)]">
                    +{formatINR(compare.unlocked)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-[var(--muted)]">Double charges</span>
                  <span className="mono">
                    <span className="text-[var(--emerald)]">{r.safety.doubleCharges}</span>
                    <span className="text-[var(--faint)]"> vs </span>
                    <span className="text-[var(--red)]">{bl.doubleCharges}</span>
                  </span>
                </div>
              </div>
            </Panel>

            <Panel title="Safety — bounded &amp; gated">
              <div className="flex flex-col divide-y divide-[var(--border)] p-1">
                <SafetyRow label="Double charges" value={r.safety.doubleCharges} good={r.safety.doubleCharges === 0} />
                <SafetyRow
                  label="Lost-confirms reconciled"
                  value={r.safety.reconciliationsPreventingDoubleCharge}
                  good
                  note="double-charges prevented"
                />
                <SafetyRow label="Contacts after opt-out" value={r.safety.postOptOutContacts} good={r.safety.postOptOutContacts === 0} />
                <SafetyRow label="Quiet-hours contacts" value={r.safety.quietHoursContacts} good={r.safety.quietHoursContacts === 0} />
                <SafetyRow label="Overspend blocked" value={r.safety.overspendBlocked} good note="budget guard held" />
              </div>
            </Panel>

            <Panel title="Recovery by root cause">
              <div className="flex max-h-[240px] flex-col gap-2 overflow-y-auto p-3">
                {r.byCause.map((c) => (
                  <div key={c.cause} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="text-[var(--text)]">
                        {c.cause}
                        {ESCALATED_BY_DESIGN.has(c.cause) && c.recovered === 0 && (
                          <span className="ml-1.5 text-[10px] text-[var(--violet)]">escalated by design</span>
                        )}
                      </span>
                      <span className="mono text-[var(--muted)]">
                        {c.recovered}/{c.total} · {formatINRCompact(c.grossRecovered)}
                      </span>
                    </div>
                    <Bar value={c.recovered} max={c.total} color="var(--emerald)" />
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          <footer className="pb-2 text-center text-[11px] text-[var(--faint)]">
            Deterministic &amp; reproducible · seed {data.seed} · {data.n} cases ·{" "}
            {data.ledger.length} audit events · every money action bounded, gated, idempotent, replayable
          </footer>
        </>
      )}
    </div>
  );
}

// ---------- trace view ----------

function TraceView({ c, trace }: { c: AtRiskCase; trace: LedgerEvent[] }) {
  const bk = bucketOf(c);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">{c.customer.name}</div>
          <div className="mono text-sm font-semibold" style={{ color: BUCKET_COLOR[bk] }}>
            {formatINR(c.amount)}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--muted)]">
          <span className="rounded bg-[var(--bg-2)] px-1.5 py-0.5">{c.type}</span>
          {c.diagnosis && (
            <span>
              → {c.diagnosis.rootCause}{" "}
              <span className="text-[var(--faint)]">({c.diagnosis.source})</span>
            </span>
          )}
          <span className="capitalize" style={{ color: BUCKET_COLOR[bk] }}>
            → {bk}
          </span>
          <span className="text-[var(--faint)]">· {c.customer.locale}</span>
        </div>
      </div>
      <ol className="max-h-[430px] flex-1 overflow-y-auto p-4">
        {trace.map((e, i) => (
          <li key={e.seq} className="relative flex gap-3 pb-3.5 last:pb-0">
            <div className="flex flex-col items-center">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: EVENT_COLOR[e.type] }} />
              {i < trace.length - 1 && <span className="mt-0.5 w-px flex-1 bg-[var(--border)]" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: EVENT_COLOR[e.type] }}>
                  {e.type.replace(/_/g, " ")}
                </span>
                <span className="mono shrink-0 text-[10px] text-[var(--faint)]">{fmtT(e.at)}</span>
              </div>
              <p className="mt-0.5 text-[12px] leading-snug text-[var(--muted)]">{e.summary}</p>
            </div>
          </li>
        ))}
      </ol>
      <LiveLinkPanel key={c.id} c={c} />
    </div>
  );
}

interface LinkView {
  id: string;
  shortUrl: string;
  status: string;
  amount: number;
  amountPaid: number;
}
type LinkApi =
  | { ok: true; view?: LinkView; idempotentReuse?: boolean; link?: LinkView | null }
  | { ok: false; reason: string; message: string };

function LiveLinkPanel({ c }: { c: AtRiskCase }) {
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<LinkApi | null>(null);

  const create = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/razorpay/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          referenceId: `${c.id}-live`,
          amountPaise: c.amount,
          name: c.customer.name,
          email: c.customer.contact.email,
          contact: c.customer.contact.phone,
          description: `Recoup — ${c.diagnosis?.rootCause ?? c.type} recovery for ${c.customer.name}`,
          notes: { caseId: c.id, rootCause: c.diagnosis?.rootCause ?? "" },
        }),
      });
      setRes(await r.json());
    } catch (e) {
      setRes({ ok: false, reason: "network", message: String(e) });
    } finally {
      setLoading(false);
    }
  };

  const reconcile = async (id: string) => {
    setLoading(true);
    try {
      const r = await fetch("/api/razorpay/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reconcile", id }),
      });
      const j = (await r.json()) as LinkApi;
      setRes((prev) => (prev && prev.ok ? { ...prev, link: (j as { link?: LinkView }).link } : j));
    } finally {
      setLoading(false);
    }
  };

  const status = res && res.ok ? res.link?.status ?? res.view?.status : undefined;
  const statusColor =
    status === "paid" ? "var(--emerald)" : status === "created" ? "var(--amber)" : "var(--muted)";

  return (
    <div className="border-t border-[var(--border)] p-3">
      {!res && (
        <button
          onClick={create}
          disabled={loading}
          className="w-full rounded-lg border px-3 py-2 text-[12px] font-medium transition disabled:opacity-60"
          style={{ borderColor: "var(--border-2)", color: "var(--cyan)" }}
        >
          {loading ? "Calling Razorpay…" : "◈ Create real Razorpay recovery link (test mode)"}
        </button>
      )}

      {res && !res.ok && (
        <div className="text-[11px] leading-snug text-[var(--muted)]">
          <span className="text-[var(--amber)]">Razorpay:</span> {res.message}
        </div>
      )}

      {res && res.ok && res.view && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <a
              href={res.view.shortUrl}
              target="_blank"
              rel="noreferrer"
              className="truncate text-[12px] underline"
              style={{ color: "var(--cyan)" }}
            >
              {res.view.shortUrl || "link created"}
            </a>
            <span
              className="mono shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase"
              style={{ background: "var(--bg-2)", color: statusColor }}
            >
              {status}
            </span>
          </div>
          {res.idempotentReuse && (
            <div className="text-[10px] text-[var(--faint)]">
              idempotent reuse — same reference_id returned the same link, no double-charge
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => reconcile(res.view!.id)}
              disabled={loading}
              className="rounded-md border px-2.5 py-1 text-[11px] transition disabled:opacity-60"
              style={{ borderColor: "var(--border-2)", color: "var(--text)" }}
            >
              {loading ? "…" : "Reconcile status"}
            </button>
            <button
              onClick={create}
              disabled={loading}
              className="rounded-md border px-2.5 py-1 text-[11px] text-[var(--muted)] transition disabled:opacity-60"
              style={{ borderColor: "var(--border)" }}
            >
              Recreate (idempotent)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CompareRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-[var(--text)]">{label}</span>
        <span className="mono text-[var(--muted)]">{formatINR(value)}</span>
      </div>
      <Bar value={value} max={max} color={color} />
    </div>
  );
}

function SafetyRow({ label, value, good, note }: { label: string; value: number; good: boolean; note?: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className="grid h-4 w-4 place-items-center rounded-full text-[10px] font-bold"
          style={{
            background: good ? "color-mix(in srgb, var(--emerald) 18%, transparent)" : "color-mix(in srgb, var(--red) 18%, transparent)",
            color: good ? "var(--emerald)" : "var(--red)",
          }}
        >
          {good ? "✓" : "!"}
        </span>
        <span className="text-[12px] text-[var(--text)]">{label}</span>
      </div>
      <div className="text-right">
        <span className="mono text-sm font-semibold" style={{ color: good ? "var(--emerald)" : "var(--red)" }}>
          {value}
        </span>
        {note && <div className="text-[10px] text-[var(--faint)]">{note}</div>}
      </div>
    </div>
  );
}
