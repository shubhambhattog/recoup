// Measure Razorpay's read-after-write lag on the payment-link list endpoint.
//
//   npm run measure:lag            # 5 samples
//   LAG_SAMPLES=10 npm run measure:lag
//
// Why this exists: `createPaymentLink` falls back to looking a link up by
// reference_id when create reports a duplicate, and Razorpay's list endpoint is
// eventually consistent — the link may not be visible yet. The retry ladder that
// covers that gap was originally sized by guesswork. This script measures the
// actual lag instead: create a link, poll `paymentLink.all({reference_id})`
// until it appears, record how long that took.
//
// It cleans up after itself — every link it creates is cancelled before exit,
// and notifications are off, so nothing is ever delivered to anyone.

import { loadEnv } from "@/lib/core/env";
loadEnv();

import fs from "node:fs";
import path from "node:path";
import {
  razorpayConfigured,
  isLiveKey,
  createPaymentLink,
  findLinkByReference,
  cancelPaymentLink,
} from "@/lib/razorpay/client";

const SAMPLES = Math.max(1, Math.min(20, Number(process.env.LAG_SAMPLES ?? 5)));
const POLL_MS = 250;
const GIVE_UP_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Sample {
  referenceId: string;
  linkId: string;
  visibleAfterMs: number | null; // null = never appeared within GIVE_UP_MS
  polls: number;
}

async function main() {
  if (!razorpayConfigured()) {
    console.log("\n  Razorpay keys not configured — add them to .env.local.\n");
    return;
  }
  if (isLiveKey()) {
    console.error("\n  ✗ Refusing to run against a LIVE key.\n");
    process.exit(1);
  }

  console.log(`\n  READ-AFTER-WRITE LAG — Razorpay payment-link list endpoint`);
  console.log(`  samples=${SAMPLES}  poll interval=${POLL_MS}ms  give up after=${GIVE_UP_MS / 1000}s`);
  console.log(`  ${"─".repeat(66)}\n`);

  const samples: Sample[] = [];
  const toCancel: string[] = [];

  try {
    for (let i = 0; i < SAMPLES; i++) {
      // A reference unique to this measurement run — never collides with a demo.
      const referenceId = `lag-${Date.now().toString(36)}-${i}`;
      const { view } = await createPaymentLink({
        amountPaise: 100,
        referenceId,
        description: "Recoup — read-after-write lag measurement (no delivery)",
        customer: { name: "Lag Probe" },
      });
      toCancel.push(view.id);

      const started = Date.now();
      let polls = 0;
      let visibleAfterMs: number | null = null;

      for (;;) {
        polls++;
        const found = await findLinkByReference(referenceId).catch(() => null);
        if (found) {
          visibleAfterMs = Date.now() - started;
          break;
        }
        if (Date.now() - started > GIVE_UP_MS) break;
        await sleep(POLL_MS);
      }

      samples.push({ referenceId, linkId: view.id, visibleAfterMs, polls });
      console.log(
        `  sample ${String(i + 1).padStart(2)}  ${view.id}  ` +
          (visibleAfterMs === null
            ? `NOT VISIBLE within ${GIVE_UP_MS / 1000}s (${polls} polls)`
            : `visible after ${visibleAfterMs}ms (${polls} polls)`),
      );

      await sleep(800); // stay well under Razorpay's rate limit
    }
  } finally {
    // Never leave probe links open.
    let cancelled = 0;
    for (const id of toCancel) {
      try {
        await cancelPaymentLink(id);
        cancelled++;
      } catch {
        // already cancelled / not cancellable — fine
      }
      await sleep(300);
    }
    console.log(`\n  cleaned up ${cancelled}/${toCancel.length} probe links`);
  }

  const observed = samples.map((s) => s.visibleAfterMs).filter((v): v is number => v !== null);
  const misses = samples.length - observed.length;

  if (observed.length) {
    const sorted = [...observed].sort((a, b) => a - b);
    const mean = Math.round(observed.reduce((a, b) => a + b, 0) / observed.length);
    const max = sorted[sorted.length - 1];
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];

    console.log(`\n  RESULT over ${observed.length} samples`);
    console.log(`    mean ${mean}ms · p50 ${p50}ms · p90 ${p90}ms · max ${max}ms`);
    if (misses) console.log(`    ${misses} sample(s) never appeared within ${GIVE_UP_MS / 1000}s`);
    console.log(
      `\n  → A retry ladder must comfortably exceed ${max}ms (observed worst case).` +
        `\n    Current ladder in client.ts totals ~6s of waiting.`,
    );
  } else {
    console.log(`\n  RESULT: no sample became visible within ${GIVE_UP_MS / 1000}s.`);
    console.log(`  → The list endpoint cannot be relied on as the primary idempotency`);
    console.log(`    source; the reference→id store is doing the real work.`);
  }

  const outDir = path.join(process.cwd(), "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "lag-measurement.json"),
    JSON.stringify({ measuredAt: new Date().toISOString(), pollMs: POLL_MS, giveUpMs: GIVE_UP_MS, samples }, null, 2),
  );
  console.log(`\n  wrote artifacts/lag-measurement.json\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
