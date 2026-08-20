// Resolve which LLM to use, provider-agnostically, from environment.
//
// Priority:
//   1. LLM_MODEL="provider/model" + AI_GATEWAY_API_KEY → any provider via the
//      Vercel AI Gateway (openai/…, anthropic/…, google/…).
//   2. GEMINI_API_KEY | GOOGLE_GENERATIVE_AI_API_KEY → Gemini directly (default).
//   3. AI_GATEWAY_API_KEY only → gateway with a default Gemini model.
//   4. none → null → the engine falls back to its offline heuristic.
//
// Swapping the whole app to a different model is a one-line env change; no code
// changes. The money logic never depends on any of this.

import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export interface ResolvedModel {
  model: LanguageModel;
  label: string;
}

export function resolveModel(): ResolvedModel | null {
  const name = process.env.LLM_MODEL?.trim();
  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
  const geminiKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim();

  // 1. Any-provider gateway path.
  if (name && name.includes("/") && gatewayKey) {
    return { model: name as unknown as LanguageModel, label: `gateway:${name}` };
  }

  // 2. Direct Gemini (the default).
  if (geminiKey) {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
    }
    const id =
      name && !name.includes("/") ? name : name?.replace("google/", "") || "gemini-2.5-flash";
    return { model: google(id), label: `gemini:${id}` };
  }

  // 3. Gateway with a default model, when only a gateway key exists.
  if (gatewayKey) {
    const id = name || "google/gemini-2.5-flash";
    return { model: id as unknown as LanguageModel, label: `gateway:${id}` };
  }

  return null;
}
