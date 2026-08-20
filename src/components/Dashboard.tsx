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

// ---------- constants ----------

const CARD = "gap-0 overflow-hidden rounded-xl border bg-card py-0 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]";

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

// ---------- primitives ----------

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
      {children}
    </span>
  );
}

function Panel({
  title,
  right,
  children,
  className = "",
  bodyClass = "",
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <Card className={`${CARD} flex flex-col ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-2 px-5 pt-4 pb-3">
          <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
          {right}
        </header>
      )}
      <div className={`flex min-h-0 flex-1 flex-col ${bodyClass}`}>{children}</div>
    </Card>
  );
}

function Track({ value, max, color, className = "h-1.5" }: { value: number; max: number; color: string; className?: string }) {
  const w = max > 0 ? Math.min(100, Math.max(1.5, (value / max) * 100)) : 0;
  return (
    <div className={`w-full overflow-hidden rounded-full bg-muted/60 ${className}`}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: ReactNode; accent?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <span className="mono text-[15px] font-medium tracking-tight" style={accent ? { color: accent } : undefined}>
        {value}
      </span>
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
    const payTotal = r.byType
      .filter((t) => t.type === "payment_failed" || t.type === "subscription_failed")
      .reduce((s, t) => s + t.recovered, 0);
    const mult = bl.grossRecoveredPaise > 0 ? payGross / bl.grossRecoveredPaise : 0;
    const unlocked = r.grossRecoveredPaise - payGross;
    return { payGross, payTotal, mult, unlocked };
  }, [r, bl]);

  return (
    <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-5 px-5 py-6 lg:px-8">
      {/* Header */}
      <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <span
            className="grid h-9 w-9 place-items-center rounded-xl text-base font-bold text-black shadow-[inset_0_1px_0_0_rgba(255,255,255,0.3)]"
            style={{ background: "var(--emerald)" }}
          >
            ₹
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-[17px] font-semibold tracking-tight">Recoup</h1>
              <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground">
                Razorpay · Track 03
              </Badge>
            </div>
            <p className="text-[12.5px] text-muted-foreground">
              Bounded revenue-recovery agent — recovers more, and{" "}
              <span className="text-foreground">can&apos;t misbehave with money</span>.
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5">
              <Label>Seed</Label>
              <Input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} className="mono h-9 w-16" />
            </label>
            <label className="flex items-center gap-1.5">
              <Label>Cases</Label>
              <Input type="number" value={n} min={10} max={300} onChange={(e) => setN(Number(e.target.value))} className="mono h-9 w-16" />
            </label>
          </div>
          <div className="flex items-center gap-4 rounded-xl border bg-card/60 px-3.5 py-2">
            <Label>Inject chaos</Label>
            <div className="flex w-28 flex-col gap-1.5">
              <span className="mono text-[10px] text-muted-foreground">lost-confirm {Math.round(lostP * 100)}%</span>
              <Slider min={0} max={50} step={1} value={[Math.round(lostP * 100)]} onValueChange={(v) => setLostP(sliderVal(v) / 100)} />
            </div>
            <div className="flex w-28 flex-col gap-1.5">
              <span className="mono text-[10px] text-muted-foreground">api-error {Math.round(apiP * 100)}%</span>
              <Slider min={0} max={50} step={1} value={[Math.round(apiP * 100)]} onValueChange={(v) => setApiP(sliderVal(v) / 100)} />
            </div>
          </div>
          <Button onClick={run} disabled={loading} className="h-10 px-4 font-semibold">
            {loading ? "Running…" : "Run batch"}
          </Button>
        </div>
      </header>

      {!data || !r || !bl || !compare ? (
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
          <div className="animate-pulse">Running recovery batch…</div>
        </div>
      ) : (
        <>
          {/* Hero: money + safety */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            {/* Recovered hero */}
            <Card className={`${CARD} relative flex flex-col gap-5 p-6 lg:col-span-8`}>
              <div className="absolute inset-x-0 top-0 h-px" style={{ background: "linear-gradient(90deg, transparent, var(--emerald), transparent)", opacity: 0.6 }} />
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Net recovered</Label>
                  <div className="mono text-[46px] font-semibold leading-none tracking-tight" style={{ color: "var(--emerald)" }}>
                    {formatINRCompact(r.netRecoveredPaise)}
                  </div>
                  <span className="text-[12.5px] text-muted-foreground">
                    {formatINR(r.grossRecoveredPaise)} recovered of {formatINR(r.totalAtRiskPaise)} at risk
                  </span>
                </div>
                <Badge
                  variant="outline"
                  className="mono h-7 gap-1 rounded-lg border-[color-mix(in_oklch,var(--emerald)_40%,transparent)] px-2.5 text-[12px]"
                  style={{ color: "var(--emerald)" }}
                >
                  {compare.mult.toFixed(1)}× vs baseline
                </Badge>
              </div>

              <Track value={r.grossRecoveredPaise} max={r.totalAtRiskPaise} color="var(--emerald)" className="h-2" />

              <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
                <MiniStat label="Recovery rate" value={`${(r.recoveryRate * 100).toFixed(1)}%`} />
                <MiniStat label="Recovered" value={`${r.recovered} / ${r.totalCases}`} />
                <MiniStat label="Unlocked vs baseline" value={`+${formatINRCompact(compare.unlocked)}`} accent="var(--blue)" />
                <MiniStat label="Avg time to recover" value={`${r.avgHoursToRecovery.toFixed(0)}h`} />
              </div>
            </Card>

            {/* Safety hero */}
            <Card className={`${CARD} flex flex-col gap-4 p-6 lg:col-span-4`}>
              <div className="flex items-center justify-between">
                <Label>Safety — bounded &amp; gated</Label>
                <span className="grid h-6 w-6 place-items-center rounded-full text-[12px]" style={{ background: "color-mix(in oklch, var(--emerald) 16%, transparent)", color: "var(--emerald)" }}>
                  ✓
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="mono text-[40px] font-semibold leading-none tracking-tight" style={{ color: r.safety.doubleCharges === 0 ? "var(--emerald)" : "var(--red)" }}>
                  {r.safety.doubleCharges}
                </span>
                <span className="text-[13px] text-muted-foreground">double charges</span>
              </div>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                <span className="mono text-foreground">{r.safety.reconciliationsPreventingDoubleCharge}</span> lost confirmations reconciled — that many double-charges prevented.
              </p>
              <Separator />
              <div className="flex flex-col gap-2.5">
                <SafetyCheck label="Contacts after opt-out" value={r.safety.postOptOutContacts} />
                <SafetyCheck label="Quiet-hours contacts" value={r.safety.quietHoursContacts} />
                <SafetyCheck label="Overspend blocked" value={r.safety.overspendBlocked} okAnyValue note="budget guard held" />
              </div>
            </Card>
          </div>

          {/* Main: board + trace */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
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
                        className="h-7 px-2.5 text-[11px] capitalize"
                      >
                        {f} <span className="mono ml-1 text-faint">{count}</span>
                      </Button>
                    );
                  })}
                </div>
              }
            >
              <ScrollArea className="max-h-[512px]">
                <div className="grid grid-cols-1 gap-2.5 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-3">
                  {visibleCases.map((c) => (
                    <CaseCard key={c.id} c={c} active={selected === c.id} onClick={() => setSelected(c.id)} />
                  ))}
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
                <div className="grid h-full place-items-center p-8 text-sm text-muted-foreground">
                  Select a case to replay its full decision trail.
                </div>
              )}
            </Panel>
          </div>

          {/* Bottom: baseline + causes */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            <Panel title="Agent vs naive baseline" className="lg:col-span-5" bodyClass="px-5 pb-5">
              <p className="mb-4 text-[12px] leading-relaxed text-muted-foreground">
                Like-for-like — payments &amp; subscriptions only, the cases a naive retry can even touch.
              </p>
              <div className="flex flex-col gap-3">
                <CompareRow label="Recoup" sub={`${compare.payTotal} recovered`} value={compare.payGross} max={compare.payGross} color="var(--emerald)" />
                <CompareRow label="Naive baseline" sub={`${bl.recovered} recovered`} value={bl.grossRecoveredPaise} max={compare.payGross} color="var(--faint)" />
              </div>
              <Separator className="my-4" />
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-muted-foreground">Unlocked beyond baseline</span>
                <span className="mono font-medium" style={{ color: "var(--blue)" }}>+{formatINR(compare.unlocked)}</span>
              </div>
              <div className="mt-2.5 flex items-center justify-between text-[13px]">
                <span className="text-muted-foreground">Double charges</span>
                <span className="mono">
                  <span style={{ color: "var(--emerald)" }}>{r.safety.doubleCharges}</span>
                  <span className="text-faint"> vs </span>
                  <span style={{ color: "var(--red)" }}>{bl.doubleCharges}</span>
                </span>
              </div>
            </Panel>

            <Panel title="Recovery by root cause" className="lg:col-span-7">
              <ScrollArea className="max-h-[288px]">
                <div className="flex flex-col gap-3 px-5 pb-5">
                  {r.byCause.map((c) => (
                    <CauseRow key={c.cause} cause={c.cause} recovered={c.recovered} total={c.total} gross={c.grossRecovered} />
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

// ---------- pieces ----------

function SafetyCheck({ label, value, okAnyValue, note }: { label: string; value: number; okAnyValue?: boolean; note?: string }) {
  const ok = okAnyValue || value === 0;
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span
          className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold"
          style={{
            background: ok ? "color-mix(in oklch, var(--emerald) 16%, transparent)" : "color-mix(in oklch, var(--red) 16%, transparent)",
            color: ok ? "var(--emerald)" : "var(--red)",
          }}
        >
          {ok ? "✓" : "!"}
        </span>
        <span className="text-[12.5px] text-foreground">{label}</span>
      </div>
      <span className="mono text-[12.5px]" style={{ color: ok ? "var(--emerald)" : "var(--red)" }}>
        {note ?? value}
      </span>
    </div>
  );
}

function CaseCard({ c, active, onClick }: { c: AtRiskCase; active: boolean; onClick: () => void }) {
  const bk = bucketOf(c);
  const color = BUCKET_COLOR[bk];
  return (
    <button
      onClick={onClick}
      className="group flex items-stretch gap-3 rounded-lg border bg-card/40 p-3 text-left transition-colors hover:border-foreground/20 hover:bg-card"
      style={active ? { borderColor: color, background: "color-mix(in oklch, var(--card) 92%, transparent)" } : undefined}
    >
      <span className="w-0.5 shrink-0 rounded-full" style={{ background: color, opacity: active ? 1 : 0.6 }} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="mono text-[15px] font-semibold tracking-tight">{formatINRCompact(c.amount)}</span>
          <span className="text-[9px] font-medium uppercase tracking-wider text-faint">{TYPE_LABEL[c.type]}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[11px] text-muted-foreground">{c.diagnosis?.rootCause ?? c.status}</span>
          <span className="mono ml-auto text-[10px] text-faint">{shortId(c.id)}</span>
        </div>
      </div>
    </button>
  );
}

function TraceView({ c, trace }: { c: AtRiskCase; trace: LedgerEvent[] }) {
  const bk = bucketOf(c);
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pb-4">
        <div className="flex items-center justify-between">
          <div className="text-[15px] font-semibold tracking-tight">{c.customer.name}</div>
          <div className="mono text-[15px] font-semibold" style={{ color: BUCKET_COLOR[bk] }}>
            {formatINR(c.amount)}
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <Badge variant="secondary" className="h-5 rounded px-1.5 text-[10px]">{c.type}</Badge>
          {c.diagnosis && (
            <span>
              → {c.diagnosis.rootCause} <span className="text-faint">({c.diagnosis.source})</span>
            </span>
          )}
          <span className="capitalize" style={{ color: BUCKET_COLOR[bk] }}>→ {bk}</span>
          <span className="text-faint">· {c.customer.locale}</span>
        </div>
      </div>
      <Separator />
      <ScrollArea className="max-h-[352px]">
        <ol className="px-5 py-4">
          {trace.map((e, i) => {
            const emphasize = e.type === "recovered" || e.type === "reconciliation";
            return (
              <li key={e.seq} className="relative flex gap-3 pb-4 last:pb-0">
                <div className="flex flex-col items-center pt-1">
                  <span className="h-2 w-2 shrink-0 rounded-full ring-2 ring-background" style={{ background: EVENT_COLOR[e.type] }} />
                  {i < trace.length - 1 && <span className="mt-1 w-px flex-1" style={{ background: "var(--border)" }} />}
                </div>
                <div className={`min-w-0 flex-1 ${emphasize ? "-mx-2 rounded-md px-2 py-1" : ""}`} style={emphasize ? { background: `color-mix(in oklch, ${EVENT_COLOR[e.type]} 8%, transparent)` } : undefined}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: EVENT_COLOR[e.type] }}>
                      {e.type.replace(/_/g, " ")}
                    </span>
                    <span className="mono shrink-0 text-[10px] text-faint">{fmtT(e.at)}</span>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{e.summary}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </ScrollArea>
      <Separator />
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
    <div className="px-5 py-4">
      {!res && (
        <Button variant="outline" onClick={create} disabled={loading} className="h-9 w-full text-[12px]" style={{ color: "var(--cyan)" }}>
          {loading ? "Calling Razorpay…" : "◈ Create real Razorpay recovery link (test mode)"}
        </Button>
      )}

      {res && !res.ok && (
        <div className="text-[11px] leading-relaxed text-muted-foreground">
          <span style={{ color: "var(--amber)" }}>Razorpay:</span> {res.message}
        </div>
      )}

      {res && res.ok && res.view && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <a href={res.view.shortUrl} target="_blank" rel="noreferrer" className="truncate text-[12px] underline" style={{ color: "var(--cyan)" }}>
              {res.view.shortUrl || "link created"}
            </a>
            <Badge variant="outline" className="mono text-[10px] uppercase" style={{ color: statusColor }}>{status}</Badge>
          </div>
          {res.idempotentReuse && (
            <div className="text-[10px] text-faint">idempotent reuse — same reference_id returned the same link, no double-charge</div>
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

function CompareRow({ label, sub, value, max, color }: { label: string; sub: string; value: number; max: number; color: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="text-foreground">
          {label} <span className="text-faint">· {sub}</span>
        </span>
        <span className="mono font-medium text-muted-foreground">{formatINR(value)}</span>
      </div>
      <Track value={value} max={max} color={color} className="h-2" />
    </div>
  );
}

function CauseRow({ cause, recovered, total, gross }: { cause: string; recovered: number; total: number; gross: number }) {
  const escalated = ESCALATED_BY_DESIGN.has(cause) && recovered === 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[12.5px]">
        <span className="text-foreground">
          {cause}
          {escalated && <span className="ml-2 text-[10px]" style={{ color: "var(--violet)" }}>escalated by design</span>}
        </span>
        <span className="mono text-muted-foreground">
          {recovered}/{total} · {formatINRCompact(gross)}
        </span>
      </div>
      <Track value={recovered} max={total} color={escalated ? "var(--violet)" : "var(--emerald)"} />
    </div>
  );
}
