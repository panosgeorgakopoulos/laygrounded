import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { prepareArrestPreFiling } from "@/lib/legal/prosecution";

const ArrestSchema = z.object({
  // When the demand letter was actually served; falls back to the completion
  // event as the unpaid-period anchor.
  demandServedAt: z.string().datetime({ offset: true }).optional(),
  unpaidGraceDays: z.number().int().min(1).max(365).optional(),
});

const COMPLETION_EVENTS = ["COMPLETED_DISCHARGE", "COMPLETED_LOADING"];

// Arrest / freezing-injunction pre-filing: assesses the claim's enforcement
// posture and, when eligible, files a deterministic template dossier into
// drafts (kind 'arrest_dossier') gated behind pending_human_reviews. Nothing
// here is legal advice and nothing is served or filed — the dossier exists
// so admiralty counsel starts from an organized record instead of a shoebox.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();

    const parsed = ArrestSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const { data: claim } = await supabase
      .from("claims")
      .select(
        "id, company_id, vessel, vessel_imo, port, counterparty_name, settled_at, time_bar_days"
      )
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const [{ data: calc }, { data: completions }, { count: contradicted }, { data: related }] =
      await Promise.all([
        supabase
          .from("laytime_calculations")
          .select("demurrage_amount, currency")
          .eq("claim_id", claimId)
          .order("computed_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("sof_events")
          .select("occurred_at")
          .eq("claim_id", claimId)
          .in("event_type", COMPLETION_EVENTS)
          .in("status", ["accepted", "edited"])
          .order("occurred_at", { ascending: false })
          .limit(1),
        supabase
          .from("evidence_checks")
          .select("id", { count: "exact", head: true })
          .eq("claim_id", claimId)
          .eq("verdict", "contradicted"),
        claim.counterparty_name
          ? supabase
              .from("claims")
              .select("vessel, vessel_imo, counterparty_name, status")
              .eq("company_id", auth.companyId)
              .eq("counterparty_name", claim.counterparty_name)
              .neq("id", claimId)
              .limit(25)
          : Promise.resolve({ data: [] as never[] }),
      ]);

    const assessment = prepareArrestPreFiling({
      claim: {
        id: claim.id,
        vessel: claim.vessel,
        vesselImo: claim.vessel_imo ?? null,
        port: claim.port,
        counterpartyName: claim.counterparty_name ?? null,
        currency: calc?.currency ?? "USD",
        demurrageAmount: calc?.demurrage_amount ?? null,
        settledAt: claim.settled_at ?? null,
        completionAt: completions?.[0]?.occurred_at ?? null,
        timeBarDays: claim.time_bar_days ?? 90,
        demandServedAt: parsed.data.demandServedAt ?? null,
      },
      relatedClaims: (related ?? []).map((r) => ({
        vessel: r.vessel,
        vesselImo: r.vessel_imo ?? null,
        counterpartyName: r.counterparty_name ?? null,
        status: r.status,
      })),
      contradictedEvidenceCount: contradicted ?? 0,
      asOf: new Date().toISOString(),
      unpaidGraceDays: parsed.data.unpaidGraceDays,
    });

    // Ineligible: return the blockers, persist nothing.
    if (!assessment.eligible) {
      return NextResponse.json({ assessment, draftId: null, review: null });
    }

    const { data: draft, error: draftErr } = await supabase
      .from("drafts")
      .insert({
        claim_id: claimId,
        kind: "arrest_dossier",
        tone: "firm",
        subject: `Arrest pre-filing dossier — ${claim.vessel} (${claim.counterparty_name ?? "counterparty"})`,
        content_md: assessment.draftParticulars,
        model: "deterministic-template",
        grounding: { mode: "template", human_review_required: true },
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (draftErr || !draft) throw new Error(`PERSIST_FAILED: ${draftErr?.message}`);

    // HITL gate: one live review per claim per subject; a duplicate insert
    // means a dossier is already awaiting counsel.
    let review = "queued";
    const { error: reviewErr } = await supabase.from("pending_human_reviews").insert({
      claim_id: claimId,
      subject_type: "arrest_dossier",
      subject_id: draft.id,
      summary: `Arrest pre-filing dossier for ${claim.vessel}: ${assessment.currency} ${assessment.claimAmount.toLocaleString("en-US")} unpaid ${assessment.unpaidDays} day(s). Requires admiralty counsel review before ANY filing.`,
      payload: {
        blockers: assessment.blockers,
        cautions: assessment.cautions,
        candidate_assets: assessment.candidateAssets,
        bad_faith_indicators: assessment.badFaithIndicators,
      },
      requested_by: auth.email,
    });
    if (reviewErr) {
      if (reviewErr.code === "23505") review = "already_pending";
      else throw new Error(`PERSIST_FAILED: ${reviewErr.message}`);
    }

    return NextResponse.json({ assessment, draftId: draft.id, review }, { status: 201 });
  } catch (e) {
    return apiError(e, "v1/claims/arrest-prefiling/POST");
  }
}
