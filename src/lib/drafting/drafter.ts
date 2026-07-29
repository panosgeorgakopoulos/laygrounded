// The agentic legal drafter: structured claim data in, grounded legal
// correspondence out.
//
// Two-step prompt chain, both on the Gemini drafting model:
//   1. Position analysis — structured JSON (strongest points, weaknesses,
//      recommended ask) so argumentation is deliberate, not improvised.
//   2. Letter generation — the analysis + full claim context become a
//      professional demand letter / counter-argument / settlement proposal.
// Every draft then passes grounding verification (grounding.ts); a failed
// draft gets exactly one repair round with the specific violations quoted,
// and the final grounding verdict is stored with the draft either way.

import { type GenerateContentResponse } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assembleDraftContext, DraftContext } from "./context";
import { verifyDraftGrounding, GroundingResult } from "./grounding";
import { generateWithFallback, geminiModelChain, GEMINI_FALLBACK_MODEL } from "@/lib/ai/gemini";

export const DRAFTER_MODEL_ID =
  process.env.DRAFTER_MODEL_ID || process.env.GEMINI_MODEL || "gemini-2.5-pro";

// If a drafter-specific model is pinned, still fall back to the cheap model on
// quota; otherwise use the shared primary→fallback chain.
const DRAFTER_MODELS = process.env.DRAFTER_MODEL_ID
  ? [...new Set([process.env.DRAFTER_MODEL_ID, GEMINI_FALLBACK_MODEL])]
  : geminiModelChain();

export type DraftKind =
  | "demand_letter"
  | "counter_argument"
  | "settlement_proposal"
  | "letter_of_protest"
  | "protective_notice"
  | "sof_chase";

/**
 * Kinds that may be drafted before a calculation exists.
 *
 * Every other kind quantifies a claim and therefore needs one. These three are
 * the opposite: each exists precisely because the claim is not yet computable —
 * a protest records disputed facts mid-voyage, a protective notice preserves a
 * claim whose pack is incomplete, and a chase asks for the milestones that are
 * blocking the calculation. Requiring totals would disable them exactly when
 * they are needed.
 */
export const PRE_CALCULATION_KINDS: ReadonlySet<DraftKind> = new Set([
  "letter_of_protest",
  "protective_notice",
  "sof_chase",
]);
export type DraftTone = "firm" | "neutral" | "conciliatory";

export interface PositionAnalysis {
  strongest_points: string[];
  weaknesses: string[];
  counterparty_position: string;
  recommended_ask: string;
  clauses_to_cite: string[];
  evidence_to_cite: string[];
}

export interface GeneratedDraft {
  subject: string;
  contentMd: string;
  positionAnalysis: PositionAnalysis;
  grounding: GroundingResult & { repaired: boolean };
  model: string;
}

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    strongest_points: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    counterparty_position: { type: "string" },
    recommended_ask: { type: "string" },
    clauses_to_cite: { type: "array", items: { type: "string" } },
    evidence_to_cite: { type: "array", items: { type: "string" } },
  },
  required: [
    "strongest_points",
    "weaknesses",
    "counterparty_position",
    "recommended_ask",
    "clauses_to_cite",
    "evidence_to_cite",
  ],
  additionalProperties: false,
} as const;

const KIND_BRIEFS: Record<DraftKind, string> = {
  demand_letter:
    "A formal demurrage demand letter to the counterparty: state the claim, the clause-by-clause basis, the amount due, and require payment within 14 days of the date of this letter. Note the contractual time bar where relevant.",
  counter_argument:
    "A point-by-point rebuttal of the counterparty's position (see their pending/rejected proposals and notes in the claim data), defending the calculation with clause citations and independent evidence.",
  settlement_proposal:
    "A commercially pragmatic settlement proposal: restate the claim's strength briefly, then propose settlement. Any settlement figure must be one of the amounts provided in the claim data — typically the computed demurrage amount; do not invent a compromise figure.",
  letter_of_protest:
    "A Letter of Protest for immediate service on the terminal/shippers by the Master or port agent, protesting a stoppage of cargo operations attributed to bad weather that independent evidence contradicts (see the evidence verdicts in the claim data — cite the contradicted weather checks explicitly, including the archive findings quoted in their summaries). Record the disputed window(s), state that the alleged weather conditions are not borne out by independent archive data, reserve all owners' rights to count the period as laytime or time on demurrage, and request the recipient note and countersign the protest. Do NOT demand payment — a protest preserves rights; it does not quantify a claim.",
  protective_notice:
    "A protective notice of demurrage claim, served on the charterers BEFORE the contractual time bar expires, to preserve the claim while supporting documents are still being assembled. State that owners hereby give notice of a claim for demurrage arising at the named port under the charterparty, identify the vessel, voyage and cargo operation, and cite the time-bar deadline given in the claim data. Where the claim data lists outstanding claim-pack items, state plainly that the full supporting documentation will follow and identify what is awaited. Reserve owners' rights fully. Do NOT state a final claim amount unless the claim data contains a computed demurrage figure — if it does not, say expressly that the quantum will be advised once the calculation is complete. Never imply the claim is already quantified when it is not.",
  sof_chase:
    "A short, courteous operational request to the port agent for the missing Statement of Facts milestones listed in the claim data. Identify the vessel, voyage and port, list each missing item as a numbered request in plain operational language, and ask for the signed SoF where it is outstanding. State briefly that the laytime calculation cannot be finalised without them. This is routine correspondence between operators, NOT legal correspondence: make no allegation, assert no breach, reserve no rights, cite no charterparty clause, and quote NO monetary amount whatsoever.",
};

const TONE_BRIEFS: Record<DraftTone, string> = {
  firm: "Firm and assertive; confident of the legal position; no hedging, no apology.",
  neutral: "Professional and matter-of-fact; assertive on facts, neutral in tone.",
  conciliatory: "Cooperative and relationship-preserving while protecting the legal position.",
};

function systemPrompt(ctx: DraftContext, kind: DraftKind, tone: DraftTone): string {
  const form = ctx.claim.cpForm === "ASBATANKVOY" ? "ASBATANKVOY" : "GENCON 94";

  // A chase is an operator emailing a port agent for a timestamp. Framing it as
  // counsel drafting in a "dispute" produces a legal letter with reservations
  // of rights, which is both wrong for the recipient and a good way to sour the
  // relationship the product depends on for its input data.
  if (kind === "sof_chase") {
    return `You are a vessel operator writing a short routine email to the port agent for a call under ${form}.

NON-NEGOTIABLE RULES:
- Use ONLY the facts in the CLAIM DATA. Ask only for the items listed in its sofGaps.
- Quote NO monetary amount of any kind. Cite NO charterparty clause.
- Make no allegation, assert no breach, reserve no rights, threaten nothing.
- All times are UTC. Do not invent names, addresses or letterheads; sign as "Operations".

TASK: ${KIND_BRIEFS[kind]}
TONE: Courteous, brief and practical — a colleague asking a colleague.

OUTPUT FORMAT:
- First line exactly: SUBJECT: <one-line subject referencing vessel and voyage>
- Then a short email: greeting, one sentence of context, a numbered list of the items requested, a closing line offering to help.`;
  }

  return `You are senior claims counsel for a vessel owner/operator, drafting ${kind.replace(/_/g, " ")} correspondence in a laytime and demurrage dispute under ${form}.

NON-NEGOTIABLE GROUNDING RULES:
- Use ONLY the facts, figures, dates, clause references, and evidence in the CLAIM DATA. If the data does not support a point, omit the point.
- Quote monetary amounts EXACTLY as given, with their currency code (e.g. "USD 14,583.33"). Never invent, estimate, or round an amount.
- Cite charterparty clauses exactly as they appear in the data (e.g. GENCON94-8, ASBA-II-6) and only those that appear there.
- All times are UTC. Do not invent names, addresses, letterheads, or dates not present in the data; sign as "Claims Department".

TASK: ${KIND_BRIEFS[kind]}
TONE: ${TONE_BRIEFS[tone]}

OUTPUT FORMAT:
- First line exactly: SUBJECT: <one-line subject referencing vessel and voyage>
- Then the letter body in clean Markdown: salutation, numbered argument paragraphs, a clear demand or proposal, closing.
- Where verified weather or AIS evidence supports a point, reference it explicitly (e.g. "independent weather archive data corroborates/contradicts...").`;
}

function contextBlock(ctx: DraftContext, analysis?: PositionAnalysis): string {
  const parts = [`CLAIM DATA (the only permissible source of facts):\n${JSON.stringify(ctx, null, 2)}`];
  if (analysis) {
    parts.push(`POSITION ANALYSIS (your own prior assessment — follow it):\n${JSON.stringify(analysis, null, 2)}`);
  }
  return parts.join("\n\n");
}

function firstText(response: GenerateContentResponse): string {
  const text = response.text;
  if (!text || !text.trim()) throw new Error("DRAFTING_FAILED: model returned no text");
  return text;
}

export async function generateDraft(
  claimId: string,
  kind: DraftKind,
  tone: DraftTone,
  client?: SupabaseClient
): Promise<GeneratedDraft> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("DRAFTING_UNAVAILABLE");
  }
  const ctx = await assembleDraftContext(claimId, client);
  if (!ctx.totals && !PRE_CALCULATION_KINDS.has(kind)) throw new Error("NO_CALCULATION");

  // --- Step 1: position analysis (structured) ---
  const analysisResponse = await generateWithFallback({
    models: DRAFTER_MODELS,
    contents: `${contextBlock(ctx)}\n\nProduce the position analysis for a ${kind.replace(/_/g, " ")}.`,
    config: {
      systemInstruction:
        "You are senior maritime claims counsel. Analyze the dispute position strictly from the provided claim data; cite only clauses and evidence present in it. Be candid about weaknesses — the letter drafted from this analysis must not overreach.",
      // Budget covers Gemini 2.5 Pro's thinking tokens plus the JSON payload.
      maxOutputTokens: 32000,
      responseMimeType: "application/json",
      responseJsonSchema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
    },
  });
  const analysis: PositionAnalysis = JSON.parse(firstText(analysisResponse));

  // --- Step 2: letter generation ---
  const letterResponse = await generateWithFallback({
    models: DRAFTER_MODELS,
    contents: `${contextBlock(ctx, analysis)}\n\nDraft the ${kind.replace(/_/g, " ")} now.`,
    config: {
      systemInstruction: systemPrompt(ctx, kind, tone),
      maxOutputTokens: 32000,
    },
  });
  let letter = firstText(letterResponse);

  // --- Step 3: grounding verification (+ one repair round) ---
  // A chase is operational traffic to a port agent, not a claim — no figure
  // belongs in it, so the check is absolute rather than "must match the claim".
  const groundingOpts = { forbidAmounts: kind === "sof_chase" };
  let grounding = verifyDraftGrounding(letter, ctx, groundingOpts);
  let repaired = false;
  if (!grounding.verified) {
    repaired = true;
    // Gemini uses the "model" role for prior assistant turns.
    const repairResponse = await generateWithFallback({
      models: DRAFTER_MODELS,
      contents: [
        {
          role: "user",
          parts: [{ text: `${contextBlock(ctx, analysis)}\n\nDraft the ${kind.replace(/_/g, " ")} now.` }],
        },
        { role: "model", parts: [{ text: letter }] },
        {
          role: "user",
          parts: [
            {
              text:
                `Automated grounding verification found the following violations in your draft:\n` +
                grounding.issues.map((i) => `- ${i.message}`).join("\n") +
                `\n\nRewrite the letter correcting ONLY these violations. Every amount and clause citation must come verbatim from the CLAIM DATA. Keep the same structure and produce the full letter again, starting with the SUBJECT line.`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: systemPrompt(ctx, kind, tone),
        maxOutputTokens: 32000,
      },
    });
    letter = firstText(repairResponse);
    grounding = verifyDraftGrounding(letter, ctx, groundingOpts);
  }

  // --- Parse subject ---
  const subjectMatch = letter.match(/^\s*SUBJECT:\s*(.+)$/m);
  const subject = subjectMatch?.[1]?.trim() ?? `${ctx.claim.vessel} / ${ctx.claim.voyageRef} — demurrage`;
  const contentMd = subjectMatch
    ? letter.slice(letter.indexOf(subjectMatch[0]) + subjectMatch[0].length).trim()
    : letter.trim();

  return {
    subject,
    contentMd,
    positionAnalysis: analysis,
    grounding: { ...grounding, repaired },
    model: DRAFTER_MODEL_ID,
  };
}
