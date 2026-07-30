import { NextRequest, NextResponse } from "next/server";
import { resolveCaller, callerRateLimitHeaders } from "@/lib/api/caller";
import { apiAuthFailure } from "@/lib/api/respond";
import { computeStoredPnl } from "@/lib/pnl/pnl-server";

// Voyage P&L snapshot: freight or hire, commissions, engine-fed demurrage,
// costs, and the TCE — the figure a chartering desk and a trade-finance
// counterparty both actually compare on.
//
// Recomputed on read rather than served from the last stored snapshot, for the
// same reason the UI does: a linked claim's calculation can move after a
// snapshot was taken, and an API that returns yesterday's TCE beside today's
// claims is worse than one that returns nothing.
//
// `warnings` is part of the contract, not decoration. It names linked claims
// with no calculation and lines excluded for being in another currency. An
// integrator that ignores it can book an incomplete result as final, so it
// ships in the response body rather than being left to the UI.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ pnlId: string }> }
) {
  let caller;
  try {
    caller = await resolveCaller(req, "pnl:read");
  } catch (e) {
    return apiAuthFailure(e, "v1/voyages/[id]/pnl:auth");
  }

  try {
    const { pnlId } = await params;
    const headers = callerRateLimitHeaders(caller);

    const { data: row } = await caller.client
      .from("voyage_pnl")
      .select("id, company_id")
      .eq("id", pnlId)
      .maybeSingle();
    if (!row || row.company_id !== caller.companyId) {
      return NextResponse.json({ error: "PNL_NOT_FOUND" }, { status: 404, headers });
    }

    const { pnl, claimIds, result } = await computeStoredPnl(pnlId, caller.client);

    return NextResponse.json(
      {
        pnlId,
        vessel: pnl.vessel,
        voyageRef: pnl.voyage_ref,
        charterType: pnl.charter_type,
        perspective: pnl.perspective,
        status: pnl.status,
        currency: result.currency,
        claimIds,
        totals: {
          grossRevenue: result.grossRevenue,
          revenueDeductions: result.revenueDeductions,
          voyageExpenses: result.voyageExpenses,
          transfers: result.transfers,
          netResult: result.netResult,
        },
        tce: { perDay: result.tcePerDay, voyageDays: result.voyageDays },
        lines: result.lines,
        warnings: result.warnings,
      },
      { headers }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const known: Record<string, number> = {
      PNL_NOT_FOUND: 404,
      INVALID_PNL_TERMS: 422,
      INVALID_PNL_COSTS: 422,
    };
    if (message in known) {
      return NextResponse.json({ error: message }, { status: known[message] });
    }
    return apiAuthFailure(e, "v1/voyages/[id]/pnl");
  }
}
