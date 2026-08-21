// POST /api/run — run a recovery scenario and return the full result
// (report, baseline, final case states, and the complete audit ledger).
// Deterministic and fast; the dashboard calls this on every "Run".

import { runScenario, type HumanGate } from "@/lib/engine/run";
import { DEFAULT_WORLD_CONFIG } from "@/lib/sim/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  seed?: number;
  n?: number;
  chaos?: { lostConfirmationP?: number; apiErrorP?: number; baseOptOutP?: number };
  humanGate?: HumanGate;
  approvedCaseIds?: string[];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Body;
  const seed = Number.isFinite(body.seed) ? Math.floor(body.seed as number) : 42;
  const n = clamp(Number.isFinite(body.n) ? Math.floor(body.n as number) : 120, 10, 300);

  const worldConfig = {
    lostConfirmationP: clamp(body.chaos?.lostConfirmationP ?? DEFAULT_WORLD_CONFIG.lostConfirmationP, 0, 0.6),
    apiErrorP: clamp(body.chaos?.apiErrorP ?? DEFAULT_WORLD_CONFIG.apiErrorP, 0, 0.6),
    baseOptOutP: clamp(body.chaos?.baseOptOutP ?? DEFAULT_WORLD_CONFIG.baseOptOutP, 0, 0.4),
  };

  const result = await runScenario({
    seed,
    n,
    worldConfig,
    humanGate: body.humanGate === "manual" ? "manual" : "auto",
    approvedCaseIds: Array.isArray(body.approvedCaseIds) ? body.approvedCaseIds.slice(0, 300) : [],
  });
  return Response.json(result);
}

export async function GET(): Promise<Response> {
  const result = await runScenario();
  return Response.json(result);
}
