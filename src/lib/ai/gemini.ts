// One place that knows how to call Gemini. Every AI feature goes through
// generateWithFallback(), so they all share the same retry + model-fallback
// behaviour and a new feature can call it without re-deriving any of this.
//
// Model chain: the strong primary (GEMINI_MODEL, default gemini-2.5-pro) with
// an automatic fall to a cheaper model (GEMINI_FALLBACK_MODEL, default
// gemini-2.0-flash) when the primary is over quota or unavailable. This is
// deliberate: gemini-2.5-pro has no free-tier quota, so on an un-billed key
// the fallback keeps extraction and drafting working (at lower quality)
// instead of failing outright.

import {
  GoogleGenAI,
  type GenerateContentConfig,
  type GenerateContentResponse,
} from "@google/genai";

export const GEMINI_PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";
export const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.0-flash";

// Primary first, then fallback — deduped, so pointing GEMINI_MODEL at the
// fallback model doesn't call the same model twice.
export function geminiModelChain(): string[] {
  return [...new Set([GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL].filter(Boolean))];
}

let cachedClient: GoogleGenAI | null = null;
export function getGeminiClient(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_UNAVAILABLE");
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return cachedClient;
}

function statusOf(e: any): number | undefined {
  return e?.status ?? e?.cause?.status;
}

// Transient on the SAME model — network blips and 5xx — worth a short backoff.
function retriableSameModel(e: any): boolean {
  const s = statusOf(e);
  return s === undefined || s >= 500;
}

// Worth trying the NEXT model: quota (429), a gated/absent model (404), or the
// primary simply not answering. Auth / bad-request (400/401/403) are not — the
// fallback shares the key and the request, so it would fail identically, and
// falling back would just burn a second call.
function worthFallback(e: any): boolean {
  const s = statusOf(e);
  return s === 429 || s === 404 || s === 503 || s === undefined || s >= 500;
}

export interface GeminiRequest {
  contents: unknown;
  config?: GenerateContentConfig;
  // Override the default primary→fallback chain (e.g. a feature that pins a
  // specific model). Still tried in order, still deduped by the caller.
  models?: string[];
  retriesPerModel?: number;
}

/**
 * Calls Gemini across the model chain: each model gets a few jittered-backoff
 * retries for transient errors, and the call falls to the next model on quota
 * or unavailability. Throws the last error if every model is exhausted.
 */
export async function generateWithFallback(
  req: GeminiRequest
): Promise<GenerateContentResponse> {
  const ai = getGeminiClient();
  const models = req.models && req.models.length ? [...new Set(req.models)] : geminiModelChain();
  const retries = req.retriesPerModel ?? 3;
  let lastErr: unknown;

  for (let m = 0; m < models.length; m++) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await ai.models.generateContent({
          model: models[m],
          contents: req.contents as never,
          config: req.config,
        });
      } catch (e) {
        lastErr = e;
        // Same-model transient → back off and retry this model.
        if (retriableSameModel(e) && attempt < retries - 1) {
          const base = 800;
          await new Promise((r) => setTimeout(r, base * 2 ** attempt + Math.random() * base));
          continue;
        }
        // This model is exhausted. Fall to the next one only if the error
        // warrants it; otherwise surface it now.
        const moreModels = m < models.length - 1;
        if (moreModels && worthFallback(e)) break;
        throw e;
      }
    }
  }
  throw lastErr;
}
