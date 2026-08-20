// The concrete LLM, built on the Vercel AI SDK so it is provider-agnostic.
//
// It implements exactly the two narrow capabilities the Llm interface allows —
// classify an ambiguous root cause, and compose a customer message — using
// structured output for the classification so the model can't return anything
// off-schema. It is never asked to choose or authorize a money action.

import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { Llm, ClassifyInput, ClassifyResult, ComposeInput } from "@/lib/ai/types";
import { resolveModel, type ResolvedModel } from "@/lib/ai/model";

const rootCause = z.enum([
  "insufficient_funds",
  "bank_downtime",
  "gateway_error",
  "card_expired",
  "risk_declined",
  "authentication_failed",
  "limit_exceeded",
  "mandate_inactive",
  "network_glitch",
  "buyer_price_sensitive",
  "buyer_distracted",
  "b2b_cashflow",
  "b2b_dispute",
  "unrecoverable",
  "unknown",
]);

const classifySchema = z.object({
  rootCause,
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(240),
});

export class AiSdkLlm implements Llm {
  constructor(private rm: ResolvedModel) {}

  get label(): string {
    return this.rm.label;
  }

  async classifyRootCause(input: ClassifyInput): Promise<ClassifyResult> {
    const { object } = await generateObject({
      model: this.rm.model,
      schema: classifySchema,
      system:
        "You are a payments revenue-recovery analyst for an Indian merchant on Razorpay. " +
        "Classify the single most likely ROOT CAUSE of a revenue-at-risk case. " +
        "Only classify — do NOT recommend or take any action.",
      prompt:
        `Case type: ${input.type}\n` +
        `Amount: ₹${input.amountRupees}\n` +
        `Razorpay reason: ${input.reason ?? "n/a"}\n` +
        `Razorpay code: ${input.code ?? "n/a"}\n` +
        `Context: ${input.signalDescription ?? "n/a"}\n\n` +
        "Pick the best rootCause from the allowed set and give a one-line rationale.",
    });
    return object;
  }

  async composeMessage(input: ComposeInput): Promise<string> {
    const lang =
      input.locale === "hi-IN"
        ? "Hinglish (conversational Hindi written in Latin script)"
        : "clear, warm Indian English";
    const { text } = await generateText({
      model: this.rm.model,
      system:
        `You write short payment-recovery messages for an Indian merchant's customers. ` +
        `One or two sentences, respectful, never pushy or threatening, with a clear call to action. ` +
        `Write in ${lang}.`,
      prompt:
        `Intent: ${input.intent}\n` +
        `Customer first name: ${input.customerName.split(" ")[0]}\n` +
        `Amount: ₹${input.amountRupees}` +
        (input.incentiveRupees ? `\nIncentive: ₹${input.incentiveRupees} off` : "") +
        (input.payLink ? `\nInclude this link verbatim: ${input.payLink}` : ""),
    });
    return text.trim();
  }
}

let cached: Llm | null | undefined;

/** The configured LLM, or undefined if no key is set (→ offline heuristic). */
export function getLlm(): Llm | undefined {
  if (cached === undefined) {
    const rm = resolveModel();
    cached = rm ? new AiSdkLlm(rm) : null;
  }
  return cached ?? undefined;
}

export function llmLabel(): string {
  const rm = resolveModel();
  return rm ? rm.label : "offline-heuristic";
}
