"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScenarioResult, HumanGate } from "@/lib/engine/run";
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

const HOUR_MS = 3_600_000;
const fmtT = (at: number) => `t+${Math.round(at / HOUR_MS)}h`;
const fmtDay = (at: number) => `day ${Math.floor(at / (24 * HOUR_MS)) + 1}, ${String(Math.floor((at / HOUR_MS) % 24)).padStart(2, "0")}:00`;
const shortId = (id: string) => `#${id.replace(/[^0-9]/g, "").replace(/^0+/, "")}`;
const sliderVal = (v: number | readonly number[]) => (typeof v === "number" ? v : v[0]);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

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

function firstInterestingCase(sc: ScenarioResult): string | null {
  // Open on a reconciliation — the money-critical failure handled well.
  const rec = sc.ledger.find(
    (e) => e.type === "reconciliation" && (e.data as { result?: string })?.result === "success",
  );
  return rec?.caseId ?? sc.cases[0]?.id ?? null;
}

export default function Dashboard({ initial }: { initial: ScenarioResult }) {
  const [data, setData] = useState<ScenarioResult>(initial);
  const [loading, setLoading] = useState(false);
  const [seed, setSeed] = useState(42);
  const [n, setN] = useState(120);
  const [lostP, setLostP] = useState(0.14);
  const [apiP, setApiP] = useState(0.1);
  const [gate, setGate] = useState<HumanGate>("auto");
  const [approvals, setApprovals] = useState<string[]>([]);
  const [filter, setFilter] = useState<Bucket | "all">("all");
  const [selected, setSelected] = useState<string | null>(() => firstInterestingCase(initial));

  // replay
  const [replayT, setReplayT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  const run = useCallback(
    async (opts?: { gate?: HumanGate; approvals?: string[] }) => {
      setLoading(true);
      setPlaying(false);
      setReplayT(null);
      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            seed,
            n,
            chaos: { lostConfirmationP: lostP, apiErrorP: apiP },
            humanGate: opts?.gate ?? gate,
            approvedCaseIds: opts?.approvals ?? approvals,
          }),
        });
        const json: ScenarioResult = await res.json();
        setData(json);
        setSelected(firstInterestingCase(json));
      } finally {
        setLoading(false);
      }
    },
    [seed, n, lostP, apiP, gate, approvals],
  );

  const caseById = useMemo(() => {
    const m = new Map<string, AtRiskCase>();
    data?.cases.forEach((c) => m.set(c.id, c));
    return m;
  }, [data]);

  const trace = useMemo<LedgerEvent[]>(() => {
    if (!data || !selected) return [];
    return data.ledger.filter((e) => e.caseId === selected).sort((a, b) => a.seq - b.seq);
  }, [data, selected]);

  // ---- replay derivation ----
  const span = useMemo(() => {
    if (!data?.ledger.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of data.ledger) {
      if (e.at < lo) lo = e.at;
      if (e.at > hi) hi = e.at;
    }
    return { lo, hi };
  }, [data]);

  const replay = useMemo(() => {
    if (!data || replayT === null) return null;
    const stateAt = new Map<string, Bucket | "pending">();
    let recovered = 0;
    let money = 0;
    const feed: LedgerEvent[] = [];
    for (const e of data.ledger) {
      if (e.at > replayT) continue;
      if (e.type === "case_detected") stateAt.set(e.caseId, "inflight");
      else if (e.type === "recovered") {
        if (stateAt.get(e.caseId) !== "recovered") {
          recovered++;
          money += Number((e.data as { gross?: number } | undefined)?.gross ?? 0);
        }
        stateAt.set(e.caseId, "recovered");
      } else if (e.type === "exception") {
        stateAt.set(e.caseId, /escalated/.test(e.summary) ? "escalated" : "stopped");
      }
      feed.push(e);
    }
    return { stateAt, recovered, money, feed: feed.slice(-6).reverse() };
  }, [data, replayT]);

  // playback loop
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !span) return;
    const step = Math.max(1, (span.hi - span.lo) / 220);
    const id = window.setInterval(() => {
      setReplayT((t) => {
        const next = (t ?? span.lo) + step;
        if (next >= span.hi) {
          setPlaying(false);
          return span.hi;
        }
        return next;
      });
    }, 45);
    return () => window.clearInterval(id);
  }, [playing, span]);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

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

  const parked = useMemo(
    () => (data?.cases ?? []).filter((c) => (c.exceptionReason ?? "").includes("awaiting_human")),
    [data],
  );

  const r = data?.report;
  const bl = data?.baseline;

  const compare = useMemo(() => {
    if (!r || !bl) return null;
    const seg = r.paymentsSegment;
    const mult = bl.grossRecoveredPaise > 0 ? seg.grossRecoveredPaise / bl.grossRecoveredPaise : 0;
    return { seg, mult, unlocked: r.grossRecoveredPaise - seg.grossRecoveredPaise };
  }, [r, bl]);

  const approveAll = () => {
    const ids = parked.map((c) => c.id);
    setApprovals(ids);
    run({ approvals: ids });
  };

  const setGateAndRun = (g: HumanGate) => {
    setGate(g);
    setApprovals([]);
    run({ gate: g, approvals: [] });
  };

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
          <Button onClick={() => run()} disabled={loading} className="h-10 px-4 font-semibold">
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
            <Card className={`${CARD} relative flex flex-col gap-5 p-6 lg:col-span-8`}>
              <div className="absolute inset-x-0 top-0 h-px" style={{ background: "linear-gradient(90deg, transparent, var(--emerald), transparent)", opacity: 0.6 }} />
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Net recovered</Label>
                  <div className="mono text-[46px] font-semibold leading-none tracking-tight" style={{ color: "var(--emerald)" }}>
                    {formatINRCompact(replay ? replay.money : r.netRecoveredPaise)}
                  </div>
                  <span className="text-[12.5px] text-muted-foreground">
                    {replay
                      ? `${replay.recovered} recovered so far · replaying ${fmtDay(replayT!)}`
                      : `${formatINR(r.grossRecoveredPaise)} recovered of ${formatINR(r.totalAtRiskPaise)} at risk`}
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

              <Track value={replay ? replay.money : r.grossRecoveredPaise} max={r.totalAtRiskPaise} color="var(--emerald)" className="h-2" />

              <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
                <MiniStat label="Recovery rate" value={pct(r.recoveryRate)} />
                <MiniStat label="Recovered" value={`${r.recovered} / ${r.totalCases}`} />
                <MiniStat label="Unlocked vs baseline" value={`+${formatINRCompact(compare.unlocked)}`} accent="var(--blue)" />
                <MiniStat label="Avg time to recover" value={`${r.avgHoursToRecovery.toFixed(0)}h`} />
              </div>
            </Card>

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

          {/* Evidence strip: diagnosis accuracy · AI usage · human gate */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {r.diagnosis && (
              <Card className={`${CARD} flex flex-col gap-3 p-5`}>
                <div className="flex items-center justify-between">
                  <Label>Diagnosis accuracy</Label>
                  <span className="text-[10px] text-faint">vs hidden ground truth</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="mono text-[26px] font-semibold leading-none tracking-tight">{pct(r.diagnosis.accuracy)}</span>
                  <span className="text-[12px] text-muted-foreground">{r.diagnosis.correct}/{r.diagnosis.total} correct</span>
                </div>
                <div className="flex flex-col gap-2">
                  {r.diagnosis.byPath.map((p) => (
                    <div key={p.path} className="flex flex-col gap-1">
                      <div className="flex justify-between text-[11.5px]">
                        <span className="text-muted-foreground">{p.path === "rules" ? "rules (error codes)" : "text path (LLM/heuristic)"}</span>
                        <span className="mono">{pct(p.accuracy)}</span>
                      </div>
                      <Track value={p.correct} max={p.total} color={p.path === "rules" ? "var(--emerald)" : "var(--blue)"} />
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card className={`${CARD} flex flex-col gap-3 p-5`}>
              <div className="flex items-center justify-between">
                <Label>AI usage</Label>
                <span className="text-[10px] text-faint">right tool, right place</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="mono text-[26px] font-semibold leading-none tracking-tight">{pct(r.ai.rulesOnly / r.totalCases)}</span>
                <span className="text-[12px] text-muted-foreground">answered with no model at all</span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                {r.ai.llmEligible} of {r.totalCases} cases carry no error code — those are the only ones a model sees.
                The LLM never decides or authorises a money action.
              </p>
              <Separator />
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-muted-foreground">Model calls · cost</span>
                <span className="mono">{r.ai.llmCalls} · {formatINR(r.ai.llmCostPaise)}</span>
              </div>
            </Card>

            <Card className={`${CARD} flex flex-col gap-3 p-5`}>
              <div className="flex items-center justify-between">
                <Label>Human gate</Label>
                <div className="flex gap-1">
                  {(["auto", "manual"] as const).map((g) => (
                    <Button
                      key={g}
                      size="sm"
                      variant={gate === g ? "secondary" : "ghost"}
                      aria-pressed={gate === g}
                      onClick={() => setGateAndRun(g)}
                      disabled={loading}
                      className="h-6 px-2 text-[10.5px] capitalize"
                    >
                      {g}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="mono text-[26px] font-semibold leading-none tracking-tight" style={{ color: parked.length ? "var(--amber)" : undefined }}>
                  {parked.length}
                </span>
                <span className="text-[12px] text-muted-foreground">awaiting approval</span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                Money actions on cases ≥ {formatINRCompact(2_500_000)} need a human. In <span className="text-foreground">manual</span> mode the
                agent parks them instead of acting.
              </p>
              {parked.length > 0 && (
                <Button size="sm" onClick={approveAll} disabled={loading} className="h-8 text-[12px]">
                  Approve {parked.length} &amp; re-run
                </Button>
              )}
              {gate === "manual" && parked.length === 0 && approvals.length > 0 && (
                <span className="text-[11px]" style={{ color: "var(--emerald)" }}>
                  ✓ {approvals.length} approved — actions proceeded
                </span>
              )}
            </Card>
          </div>

          {/* Approvals queue */}
          {parked.length > 0 && (
            <Panel
              title="Approvals queue — high-value money actions held for a human"
              right={
                <Button size="sm" onClick={approveAll} disabled={loading} className="h-7 text-[11px]">
                  Approve all &amp; re-run
                </Button>
              }
              bodyClass="px-5 pb-5"
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {parked.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border bg-card/40 p-3">
                    <div className="min-w-0">
                      <div className="mono text-[14px] font-semibold" style={{ color: "var(--amber)" }}>{formatINR(c.amount)}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {c.customer.name} · {c.diagnosis?.rootCause}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 text-[11px]"
                      disabled={loading}
                      onClick={() => {
                        const ids = [...new Set([...approvals, c.id])];
                        setApprovals(ids);
                        run({ approvals: ids });
                      }}
                    >
                      Approve
                    </Button>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* Replay bar */}
          {span && (
            <Card className={`${CARD} flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-5`}>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant={playing ? "secondary" : "outline"}
                  className="h-8 w-20 text-[12px]"
                  onClick={() => {
                    if (replayT === null || replayT >= span.hi) setReplayT(span.lo);
                    setPlaying((p) => !p);
                  }}
                >
                  {playing ? "❚❚ Pause" : "▶ Replay"}
                </Button>
                <div className="flex flex-col">
                  <Label>Replay the batch</Label>
                  <span className="mono text-[11px] text-muted-foreground">
                    {replayT === null ? "showing final state" : fmtDay(replayT)}
                  </span>
                </div>
              </div>
              <div className="flex-1">
                <Slider
                  min={span.lo}
                  max={span.hi}
                  step={Math.max(1, (span.hi - span.lo) / 400)}
                  value={[replayT ?? span.hi]}
                  onValueChange={(v) => {
                    setPlaying(false);
                    setReplayT(sliderVal(v));
                  }}
                />
              </div>
              <div className="flex items-center gap-3">
                {replay && (
                  <span className="mono text-[11px] text-muted-foreground">
                    <span style={{ color: "var(--emerald)" }}>{replay.recovered}</span> recovered · {formatINRCompact(replay.money)}
                  </span>
                )}
                {replayT !== null && (
                  <Button size="sm" variant="ghost" className="h-8 text-[11px] text-muted-foreground" onClick={() => { setPlaying(false); setReplayT(null); }}>
                    Reset
                  </Button>
                )}
              </div>
            </Card>
          )}

          {/* Live event feed during replay */}
          {replay && replay.feed.length > 0 && (
            <Card className={`${CARD} flex flex-col gap-1.5 px-5 py-3`}>
              {replay.feed.map((e) => (
                <div key={e.seq} className="flex items-baseline gap-2 text-[11.5px]">
                  <span className="mono w-14 shrink-0 text-faint">{fmtT(e.at)}</span>
                  <span className="w-24 shrink-0 font-semibold uppercase tracking-wide" style={{ color: EVENT_COLOR[e.type], fontSize: 10 }}>
                    {e.type.replace(/_/g, " ")}
                  </span>
                  <span className="truncate text-muted-foreground">{e.summary}</span>
                </div>
              ))}
            </Card>
          )}

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
                    <CaseCard
                      key={c.id}
                      c={c}
                      active={selected === c.id}
                      replayState={replay?.stateAt.get(c.id)}
                      onClick={() => setSelected(c.id)}
                    />
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
                <TraceView c={caseById.get(selected)!} trace={trace} seed={data.seed} />
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
                <CompareRow label="Recoup" sub={`${compare.seg.recovered} recovered`} value={compare.seg.grossRecoveredPaise} max={compare.seg.grossRecoveredPaise} color="var(--emerald)" />
                <CompareRow label="Naive baseline" sub={`${bl.recovered} recovered`} value={bl.grossRecoveredPaise} max={compare.seg.grossRecoveredPaise} color="var(--faint)" />
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

function CaseCard({
  c,
  active,
  replayState,
  onClick,
}: {
  c: AtRiskCase;
  active: boolean;
  replayState?: Bucket | "pending";
  onClick: () => void;
}) {
  const bk = bucketOf(c);
  const shown = replayState ?? bk;
  const pending = shown === "pending";
  const color = pending ? "var(--faint)" : BUCKET_COLOR[shown as Bucket];
  return (
    <button
      onClick={onClick}
      className="group flex items-stretch gap-3 rounded-lg border bg-card/40 p-3 text-left transition-all hover:border-foreground/20 hover:bg-card"
      style={{
        ...(active ? { borderColor: color } : undefined),
        opacity: replayState === undefined ? 1 : pending ? 0.35 : 1,
      }}
    >
      <span className="w-0.5 shrink-0 rounded-full transition-colors" style={{ background: color, opacity: active ? 1 : 0.6 }} />
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

function TraceView({ c, trace, seed }: { c: AtRiskCase; trace: LedgerEvent[]; seed: number }) {
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
      <LiveLinkPanel key={`${seed}:${c.id}`} c={c} seed={seed} />
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

function LiveLinkPanel({ c, seed }: { c: AtRiskCase; seed: number }) {
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
          // Seed-scoped: case ids repeat across seeds with different customers
          // and amounts, so without this a re-run at another seed would reuse
          // the previous seed's link and report it as an idempotent match.
          referenceId: `s${seed}-${c.id}-live`,
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
