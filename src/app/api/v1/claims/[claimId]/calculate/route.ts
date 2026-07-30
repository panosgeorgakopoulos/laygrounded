import { NextRequest, NextResponse } from "next/server";
import { resolveCaller, callerRateLimitHeaders } from "@/lib/api/caller";
import { apiAuthFailure } from "@/lib/api/respond";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";
import { computeTimeBar } from "@/lib/time-bar";

// Trigger a laytime recalculation and return the result.
//
// The most-asked-for B2B verb: an ERP that has just pushed or confirmed events
// wants the number now, not on the next poll. Dual-authenticated — the web app
// calls it over a session, an integrator over a key with `calculations:write`.
//
// It recomputes from CONFIRMED events only, exactly as every other caller of
// the engine does. Pushed events land as `suggested` and do not count until a
// human confirms them, so an integrator that pushes and immediately calculates
// will correctly see no change: the alternative — letting an API push move a
// legally-operative figure without review — is the thing the whole confirmation
// step exists to prevent.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  let caller;
  try {
    caller = await resolveCaller(req, "calculations:write");
  } catch (e) {
    return apiAuthFailure(e, "v1/claims/[id]/calculate:auth");
  }

  try {
    const { claimId } = await params;
    const headers = callerRateLimitHeaders(caller);

    // Tenancy is proven before the engine runs. An API key holds no Supabase
    // session, so its client is service-role and RLS cannot do this for us.
    const { data: claim } = await caller.client
      .from("claims")
      .select("id, company_id, time_bar_days")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== caller.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404, headers });
    }

    const result = await recomputeLaytimeServerFn(claimId, caller.client);

    const { data: events } = await caller.client
      .from("sof_events")
      .select("event_type, occurred_at")
      .eq("claim_id", claimId)
      .in("status", ["accepted", "edited"]);

    const timeBar = computeTimeBar({
      timeBarDays: claim.time_bar_days ?? 90,
      events: events ?? [],
      hasSofDocument: true,
      hasValidCpTerms: true,
      hasCalculation: true,
    });

    return NextResponse.json(
      {
        claimId,
        totals: result.totals,
        breakdown: result.breakdown,
        timeBar: {
          deadline: timeBar.deadline,
          daysRemaining: timeBar.daysRemaining,
          state: timeBar.state,
        },
      },
      { headers }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The engine's own refusals are the caller's problem to fix, so they are
    // named rather than flattened into a 500.
    const known: Record<string, number> = {
      CLAIM_NOT_FOUND: 404,
      INVALID_CP_TERMS: 422,
      NO_NOR: 422,
      MULTIPLE_NOR: 422,
    };
    if (message in known) {
      return NextResponse.json({ error: message }, { status: known[message] });
    }
    if (message.startsWith("CALCULATION_TIMEOUT")) {
      return NextResponse.json({ error: "CALCULATION_TIMEOUT" }, { status: 422 });
    }
    return apiAuthFailure(e, "v1/claims/[id]/calculate");
  }
}
