// Verify your LLM key in one command:  npm run llm:smoke
// Runs the two things the engine actually asks the LLM to do.

import { loadEnv } from "@/lib/core/env";
loadEnv();

import { getLlm, llmLabel } from "@/lib/ai/llm";

async function main() {
  console.log(`LLM: ${llmLabel()}`);
  const llm = getLlm();
  if (!llm) {
    console.log("No LLM key configured. Add GEMINI_API_KEY to .env.local to enable Gemini.");
    return;
  }

  console.log("\n[classify] ambiguous overdue invoice…");
  const dx = await llm.classifyRootCause({
    type: "invoice_overdue",
    amountRupees: 84_000,
    signalDescription:
      "Buyer says the goods arrived damaged and is withholding payment pending a credit note.",
  });
  console.log("  →", dx);

  console.log("\n[compose] Hinglish method-switch message…");
  const msg = await llm.composeMessage({
    customerName: "Rohan Mehta",
    locale: "hi-IN",
    intent: "switch_method",
    amountRupees: 2_499,
    payLink: "https://rzp.io/i/demo",
  });
  console.log("  →", msg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
