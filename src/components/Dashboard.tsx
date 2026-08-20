"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ScenarioResult } from "@/lib/engine/run";
import type { AtRiskCase } from "@/lib/domain/types";
import type { LedgerEvent, LedgerEventType } from "@/lib/ledger/ledger";
import { formatINR, formatINRCompact } from "@/lib/core/money";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

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
  planned: "var(--muted-foreground)",
  gate_blocked: "var(--amber)",
  action_executed: "var(--muted-foreground)",
  action_retried: "var(--amber)",
  action_result: "var(--muted-foreground)",
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
const sliderVal = (v: number | readonly number[]) => (typeof v === "number" ? v : v[0]);

// ---------- small components ----------

function Stat({
  label,
  value,
  sub,
  tone = "var(--foreground)",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <Card className="gap-0 py-0">
      <div className="px-4 py-3.5">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mono mt-1 text-2xl font-semibold leading-tight" style={{ color: tone }}>
          {value}
        </div>
        {sub && <div className="mono mt-0.5 text-xs text-faint">{sub}</div>}
      </div>
    </Card>
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
    <Card className={`gap-0 overflow-hidden py-0 ${className}`}>
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-[13px] font-semibold tracking-wide">{title}</h2>
        {right}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </Card>
  );
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
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
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-[13px] font-bold text-primary-foreground">
              ₹
            </span>
            <h1 className="text-lg font-semibold tracking-tight">Recoup</h1>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Razorpay · Track 03
            </Badge>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Bounded revenue-recovery agent — recovers more than naive retries, and{" "}
            <span className="text-foreground">can&apos;t misbehave with money</span>.
          </p>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Seed
            <Input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value))}
              className="mono h-9 w-20"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Cases
            <Input
              type="number"
              value={n}
              min={10}
              max={300}
              onChange={(e) => setN(Number(e.target.value))}
              className="mono h-9 w-20"
            />
          </label>
          <div className="flex w-40 flex-col gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>Lost-confirm {Math.round(lostP * 100)}%</span>
            <Slider min={0} max={50} step={1} value={[Math.round(lostP * 100)]} onValueChange={(v) => setLostP(sliderVal(v) / 100)} />
          </div>
          <div className="flex w-40 flex-col gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>API-error {Math.round(apiP * 100)}%</span>
            <Slider min={0} max={50} step={1} value={[Math.round(apiP * 100)]} onValueChange={(v) => setApiP(sliderVal(v) / 100)} />
          </div>
          <Button onClick={run} disabled={loading} className="font-semibold">
            {loading ? "Running…" : "▶ Run batch"}
          </Button>
        </div>
      </header>

      {!data || !r || !bl || !compare ? (
        <div className="grid flex-1 place-items-center text-muted-foreground">Running recovery batch…</div>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Net recovered" value={formatINRCompact(r.netRecoveredPaise)} sub={`of ${formatINRCompact(r.totalAtRiskPaise)} at risk`} tone="var(--emerald)" />
            <Stat label="Recovery rate" value={`${(r.recoveryRate * 100).toFixed(1)}%`} sub={`${r.recovered}/${r.totalCases} cases`} />
            <Stat label="vs naive baseline" value={`${compare.mult.toFixed(1)}×`} sub={`+${formatINRCompact(compare.unlocked)} unlocked`} tone="var(--blue)" />
            <Stat label="Double charges" value={String(r.safety.doubleCharges)} sub={`${r.safety.reconciliationsPreventingDoubleCharge} prevented via reconcile`} tone={r.safety.doubleCharges === 0 ? "var(--emerald)" : "var(--red)"} />
            <Stat label="Escalated / stopped" value={`${r.escalated} / ${r.stopped}`} sub={`avg ${r.avgHoursToRecovery.toFixed(0)}h to recover`} tone="var(--violet)" />
          </div>

          {/* Main: board + trace */}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-12">
            <Panel
              title="Case board"
              className="lg:col-span-7"
              right={
                <div className="flex flex-wrap gap-1" role="group" aria-label="Filter cases">
                  {(["all", "recovered", "escalated", "stopped", "inflight"] as const).map((f) => {
                    const count = f === "all" ? data.cases.length : buckets[f].length;
                    const active = filter === f;
                    return (
                      <Button
                        key={f}
                        type="button"
                        variant={active ? "secondary" : "ghost"}
                        size="sm"
                        aria-pressed={active}
                        onClick={() => setFilter(f)}
                        className="h-7 px-2 text-[11px] capitalize"
                      >
                        {f} <span className="mono ml-1 text-faint">{count}</span>
                      </Button>
                    );
                  })}
                </div>
              }
            >
              <ScrollArea className="max-h-[460px]">
                <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 xl:grid-cols-4">
                  {visibleCases.map((c) => {
                    const bk = bucketOf(c);
                    const active = selected === c.id;
                    return (
                      <button
                        key={c.id}
                        onClick={() => setSelected(c.id)}
                        className="flex flex-col gap-1 rounded-md border bg-muted/30 p-2.5 text-left transition hover:bg-muted"
                        style={{ borderColor: active ? BUCKET_COLOR[bk] : undefined }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="mono text-[11px] text-muted-foreground">{shortId(c.id)}</span>
                          <Badge variant="secondary" className="px-1.5 py-0 text-[9px] font-semibold tracking-wider">
                            {TYPE_LABEL[c.type]}
                          </Badge>
                        </div>
                        <div className="mono text-sm font-semibold">{formatINRCompact(c.amount)}</div>
                        <div className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: BUCKET_COLOR[bk] }} />
                          <span className="truncate text-[10px] text-faint">{c.diagnosis?.rootCause ?? c.status}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </Panel>

            <Panel
              title="Audit trail"
              className="lg:col-span-5"
              right={<span className="mono text-[11px] text-faint">{selected ? shortId(selected) : ""}</span>}
            >
              {selected && caseById.get(selected) ? (
                <TraceView c={caseById.get(selected)!} trace={trace} />
              ) : (
                <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
                  Select a case to replay its full decision trail.
                </div>
              )}
            </Panel>
          </div>

          {/* Bottom: baseline + safety + causes */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Panel title="Agent vs naive baseline">
              <div className="flex flex-col gap-3 p-4">
                <div className="text-[11px] text-muted-foreground">
                  Like-for-like — payments &amp; subscriptions only (all a naive retry can touch)
                </div>
                <CompareRow label="Recoup" value={compare.payGross} max={compare.payGross} color="var(--emerald)" />
                <CompareRow label="Baseline" value={bl.grossRecoveredPaise} max={compare.payGross} color="var(--muted-foreground)" />
                <Separator />
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground">Unlocked beyond baseline</span>
                  <span className="mono font-semibold text-blue">+{formatINR(compare.unlocked)}</span>
                </div>
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-muted-foreground">Double charges</span>
                  <span className="mono">
                    <span className="text-emerald">{r.safety.doubleCharges}</span>
                    <span className="text-faint"> vs </span>
                    <span className="text-red">{bl.doubleCharges}</span>
                  </span>
                </div>
              </div>
            </Panel>

            <Panel title="Safety — bounded & gated">
              <div className="flex flex-col divide-y divide-border p-1">
                <SafetyRow label="Double charges" value={r.safety.doubleCharges} good={r.safety.doubleCharges === 0} />
                <SafetyRow label="Lost-confirms reconciled" value={r.safety.reconciliationsPreventingDoubleCharge} good note="double-charges prevented" />
                <SafetyRow label="Contacts after opt-out" value={r.safety.postOptOutContacts} good={r.safety.postOptOutContacts === 0} />
                <SafetyRow label="Quiet-hours contacts" value={r.safety.quietHoursContacts} good={r.safety.quietHoursContacts === 0} />
                <SafetyRow label="Overspend blocked" value={r.safety.overspendBlocked} good note="budget guard held" />
              </div>
            </Panel>

            <Panel title="Recovery by root cause">
              <ScrollArea className="max-h-[240px]">
                <div className="flex flex-col gap-2 p-3">
                  {r.byCause.map((c) => (
                    <div key={c.cause} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-foreground">
                          {c.cause}
                          {ESCALATED_BY_DESIGN.has(c.cause) && c.recovered === 0 && (
                            <span className="ml-1.5 text-[10px] text-violet">escalated by design</span>
                          )}
                        </span>
                        <span className="mono text-muted-foreground">
                          {c.recovered}/{c.total} · {formatINRCompact(c.grossRecovered)}
                        </span>
                      </div>
                      <Bar value={c.recovered} max={c.total} color="var(--emerald)" />
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </Panel>
          </div>

          <footer className="pb-2 text-center text-[11px] text-faint">
            Deterministic &amp; reproducible · seed {data.seed} · {data.n} cases · {data.ledger.length} audit events · every money action bounded, gated, idempotent, replayable
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
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">{c.customer.name}</div>
          <div className="mono text-sm font-semibold" style={{ color: BUCKET_COLOR[bk] }}>
            {formatINR(c.amount)}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{c.type}</Badge>
          {c.diagnosis && (
            <span>
              → {c.diagnosis.rootCause} <span className="text-faint">({c.diagnosis.source})</span>
            </span>
          )}
          <span className="capitalize" style={{ color: BUCKET_COLOR[bk] }}>→ {bk}</span>
          <span className="text-faint">· {c.customer.locale}</span>
        </div>
      </div>
      <ScrollArea className="max-h-[360px]">
        <ol className="p-4">
          {trace.map((e, i) => (
            <li key={e.seq} className="relative flex gap-3 pb-3.5 last:pb-0">
              <div className="flex flex-col items-center">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: EVENT_COLOR[e.type] }} />
                {i < trace.length - 1 && <span className="mt-0.5 w-px flex-1 bg-border" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: EVENT_COLOR[e.type] }}>
                    {e.type.replace(/_/g, " ")}
                  </span>
                  <span className="mono shrink-0 text-[10px] text-faint">{fmtT(e.at)}</span>
                </div>
                <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{e.summary}</p>
              </div>
            </li>
          ))}
        </ol>
      </ScrollArea>
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
  const statusColor = status === "paid" ? "var(--emerald)" : status === "created" ? "var(--amber)" : "var(--muted-foreground)";

  return (
    <div className="border-t p-3">
      {!res && (
        <Button variant="outline" onClick={create} disabled={loading} className="w-full text-[12px]" style={{ color: "var(--cyan)" }}>
          {loading ? "Calling Razorpay…" : "◈ Create real Razorpay recovery link (test mode)"}
        </Button>
      )}

      {res && !res.ok && (
        <div className="text-[11px] leading-snug text-muted-foreground">
          <span className="text-amber">Razorpay:</span> {res.message}
        </div>
      )}

      {res && res.ok && res.view && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <a href={res.view.shortUrl} target="_blank" rel="noreferrer" className="truncate text-[12px] text-cyan underline">
              {res.view.shortUrl || "link created"}
            </a>
            <Badge variant="outline" className="mono text-[10px] uppercase" style={{ color: statusColor }}>
              {status}
            </Badge>
          </div>
          {res.idempotentReuse && (
            <div className="text-[10px] text-faint">
              idempotent reuse — same reference_id returned the same link, no double-charge
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => reconcile(res.view!.id)} disabled={loading} className="text-[11px]">
              {loading ? "…" : "Reconcile status"}
            </Button>
            <Button variant="ghost" size="sm" onClick={create} disabled={loading} className="text-[11px] text-muted-foreground">
              Recreate (idempotent)
            </Button>
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
        <span className="text-foreground">{label}</span>
        <span className="mono text-muted-foreground">{formatINR(value)}</span>
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
        <span className="text-[12px] text-foreground">{label}</span>
      </div>
      <div className="text-right">
        <span className="mono text-sm font-semibold" style={{ color: good ? "var(--emerald)" : "var(--red)" }}>
          {value}
        </span>
        {note && <div className="text-[10px] text-faint">{note}</div>}
      </div>
    </div>
  );
}
