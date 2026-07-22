// Publishing bridge: the gate every draft passes before it can leave the
// building as formal correspondence (a PDF, or an email to the counterparty).
//
// The important part is that grounding is re-verified HERE, against a freshly
// assembled context — not read off the drafts row. The stored verdict records
// whether the letter was true *when it was generated*; a claim is a living
// record, and accepting a proposal or recomputing the calculation can leave a
// week-old letter quoting a figure the claim no longer says. Publishing is
// the moment that matters, so it is the moment we check. Re-verification is a
// pure function over data already loaded — it costs nothing to be right.
//
// If the fresh verdict differs from the stored one, the row is corrected:
// otherwise the workspace would keep showing "VERIFICATION PASSED" for a
// letter we just refused to render.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { assembleDraftContext, type DraftContext } from "./context";
import { verifyDraftGrounding, type GroundingResult } from "./grounding";
import { renderDemandLetterPdf } from "./pdf";

// Carries the specific violations with the refusal, so the operator is told
// which figure drifted rather than just "not grounded". The message is the
// sentinel apiError maps to 422.
export class DraftNotGroundedError extends Error {
  constructor(public readonly grounding: GroundingResult) {
    super("DRAFT_NOT_GROUNDED");
    this.name = "DraftNotGroundedError";
  }
}

export interface DraftRow {
  id: string;
  claim_id: string;
  kind: string;
  tone: string;
  subject: string;
  content_md: string;
  grounding: unknown;
  created_at: string;
}

export interface PreparedLetter {
  draft: DraftRow;
  ctx: DraftContext;
  grounding: GroundingResult;
  pdfBytes: Uint8Array;
  filename: string;
}

// Loads a draft, re-verifies it, and renders the PDF. Throws sentinels the
// routes map to statuses:
//   CLAIM_NOT_FOUND / DRAFT_NOT_FOUND — 404
//   NO_CALCULATION      — 409: a demand letter without a calculation has no claim to make
//   DRAFT_NOT_GROUNDED  — 422: figures/citations no longer match the record
export async function prepareGroundedLetter(opts: {
  claimId: string;
  draftId: string;
  companyId: string;
  client?: SupabaseClient;
}): Promise<PreparedLetter> {
  const supabase = opts.client ?? (await createClient());

  const { data: claim } = await supabase
    .from("claims")
    .select("id, company_id, companies(name)")
    .eq("id", opts.claimId)
    .maybeSingle();
  if (!claim || claim.company_id !== opts.companyId) throw new Error("CLAIM_NOT_FOUND");

  const { data: draft } = await supabase
    .from("drafts")
    .select("id, claim_id, kind, tone, subject, content_md, grounding, created_at")
    .eq("id", opts.draftId)
    .maybeSingle();
  // Bind the draft to the claim in the path: a draft id alone must never be
  // enough to pull correspondence from another claim.
  if (!draft || draft.claim_id !== opts.claimId) throw new Error("DRAFT_NOT_FOUND");

  const ctx = await assembleDraftContext(opts.claimId, supabase);
  if (draft.kind === "demand_letter" && !ctx.totals) throw new Error("NO_CALCULATION");

  const grounding = verifyDraftGrounding(draft.content_md, ctx);

  // Keep the stored verdict honest about the claim as it stands now.
  const stored = draft.grounding as GroundingResult | null;
  if (!stored || stored.verified !== grounding.verified) {
    await supabase.from("drafts").update({ grounding }).eq("id", draft.id);
  }

  if (!grounding.verified) throw new DraftNotGroundedError(grounding);

  const companyName =
    (claim as unknown as { companies?: { name?: string } }).companies?.name ?? "";

  const pdfBytes = await renderDemandLetterPdf({
    subject: draft.subject,
    contentMd: draft.content_md,
    kind: draft.kind,
    ctx,
    companyName,
    draftId: draft.id,
    generatedAt: new Date(),
    groundingSummary: {
      amountsChecked: grounding.amountsChecked,
      clausesChecked: grounding.clausesChecked,
    },
  });

  const slug = `${ctx.claim.vessel}-${ctx.claim.voyageRef}`
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 60);
  return {
    draft: draft as DraftRow,
    ctx,
    grounding,
    pdfBytes,
    filename: `${draft.kind}-${slug}.pdf`,
  };
}

// The refusal body both publishing routes return, so a drifted letter reads
// the same whether you tried to print it or send it.
export function groundingFailureBody(e: DraftNotGroundedError) {
  return {
    error: "DRAFT_NOT_GROUNDED",
    message:
      "This letter quotes figures or clause citations that no longer match the claim record — the claim has changed since it was drafted. Regenerate the draft before issuing it.",
    issues: e.grounding.issues,
  };
}
