import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { parseFixtureRecap } from "@/lib/api/plg";
import { computeRoiSnapshot, type RoiClaimInput } from "@/lib/analytics/predictive";

const OnboardSchema = z.object({
  recap_text: z.string().min(20).max(20_000),
});

const COMPLETION_EVENTS = ["COMPLETED_DISCHARGE", "COMPLETED_LOADING"];

// PLG self-serve onboarding: paste a fixture recap, get a working claim
// workspace plus an instant ROI map of the tenant's existing book. The recap
// parser is deterministic (no AI, no cost, reproducible); everything it
// couldn't extract is reported back with the defaults it fell back to.
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = OnboardSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const recap = parseFixtureRecap(parsed.data.recap_text);
    const supabase = await createClient();

    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .insert({
        company_id: auth.companyId,
        vessel: recap.claim.vessel ?? "TBN",
        voyage_ref: recap.claim.voyageRef ?? `ONB-${Date.now()}`,
        port: recap.claim.port ?? "TBC",
        cargo: recap.claim.cargo ?? "TBC",
        cp_form: recap.cpTerms.cp_form ?? "GENCON94",
        cp_terms: recap.cpTerms,
        counterparty_name: recap.claim.counterpartyName,
        status: "draft",
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (claimErr || !claim) throw new Error(`PERSIST_FAILED: ${claimErr?.message}`);

    // Instant ROI over whatever book already exists (RLS scopes to the
    // company). A fresh tenant gets the onboarding narrative, not zeros.
    const [{ data: claims }, { data: calcs }, { data: completions }] = await Promise.all([
      supabase
        .from("claims")
        .select("id, settled_amount, settled_at, time_bar_days")
        .limit(500),
      supabase
        .from("laytime_calculations")
        .select("claim_id, demurrage_amount, computed_at")
        .order("computed_at", { ascending: false })
        .limit(1000),
      supabase
        .from("sof_events")
        .select("claim_id, occurred_at")
        .in("event_type", COMPLETION_EVENTS)
        .in("status", ["accepted", "edited"])
        .limit(2000),
    ]);

    const latestCalc = new Map<string, number | null>();
    for (const c of calcs ?? []) {
      if (!latestCalc.has(c.claim_id)) latestCalc.set(c.claim_id, c.demurrage_amount);
    }
    const latestCompletion = new Map<string, string>();
    for (const e of completions ?? []) {
      const prev = latestCompletion.get(e.claim_id);
      if (!prev || e.occurred_at > prev) latestCompletion.set(e.claim_id, e.occurred_at);
    }

    const roiInputs: RoiClaimInput[] = (claims ?? []).map((c) => ({
      id: c.id,
      demurrageAmount: latestCalc.get(c.id) ?? null,
      settledAmount: c.settled_amount ?? null,
      settledAt: c.settled_at ?? null,
      completionAt: latestCompletion.get(c.id) ?? null,
      timeBarDays: c.time_bar_days ?? 90,
      hasCalculation: latestCalc.has(c.id),
    }));

    return NextResponse.json(
      {
        claimId: claim.id,
        parsed: {
          claim: recap.claim,
          cpTerms: recap.cpTerms,
          matched: recap.matched,
          missing: recap.missing,
          warnings: recap.warnings,
        },
        roi: computeRoiSnapshot(roiInputs, new Date()),
        nextSteps: [
          "Upload the Statement of Facts PDF to extract the event timeline.",
          "Review the parsed CP terms in the claim workspace — defaults are flagged in warnings.",
        ],
      },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "v1/onboard/POST", { RECAP_UNPARSEABLE: 422 });
  }
}
