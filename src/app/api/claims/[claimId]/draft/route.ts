import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { generateDraft } from "@/lib/drafting/drafter";
import { apiError } from "@/lib/api-errors";

const DraftRequestSchema = z.object({
  kind: z.enum(["demand_letter", "counter_argument", "settlement_proposal"]).default("demand_letter"),
  tone: z.enum(["firm", "neutral", "conciliatory"]).default("firm"),
});

function serialize(d: any) {
  return {
    id: d.id,
    kind: d.kind,
    tone: d.tone,
    subject: d.subject,
    contentMd: d.content_md,
    grounding: d.grounding,
    model: d.model,
    createdAt: d.created_at,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const { data: drafts } = await supabase
      .from("drafts")
      .select("id, kind, tone, subject, content_md, grounding, model, created_at")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false })
      .limit(10);

    return NextResponse.json({ drafts: (drafts ?? []).map(serialize) });
  } catch (e) {
    return apiError(e, "draft/GET");
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const parsed = DraftRequestSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const draft = await generateDraft(claimId, parsed.data.kind, parsed.data.tone, supabase);

    const { data: saved, error } = await supabase
      .from("drafts")
      .insert({
        claim_id: claimId,
        kind: parsed.data.kind,
        tone: parsed.data.tone,
        subject: draft.subject,
        content_md: draft.contentMd,
        position_analysis: draft.positionAnalysis,
        grounding: draft.grounding,
        model: draft.model,
        created_by: auth.userId,
      })
      .select("id, kind, tone, subject, content_md, grounding, model, created_at")
      .single();
    if (error || !saved) throw new Error(`PERSIST_FAILED: ${error?.message}`);

    return NextResponse.json({ draft: serialize(saved) }, { status: 201 });
  } catch (e) {
    return apiError(e, "draft/POST", {
      NO_CALCULATION: 400,
      DRAFTING_UNAVAILABLE: 503,
    });
  }
}
