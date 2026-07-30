import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import {
  PnlTermsSchema,
  PnlCostsSchema,
  linkClaims,
  computeStoredPnl,
  recomputeAndStorePnl,
} from "@/lib/pnl/pnl-server";
import { apiError } from "@/lib/api-errors";

const PatchSchema = z.object({
  terms: PnlTermsSchema.optional(),
  costs: PnlCostsSchema.optional(),
  voyageStart: z.string().datetime({ offset: true }).nullable().optional(),
  voyageEnd: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(["estimate", "actual", "closed"]).optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(2000).optional(),
  /** Additional port calls to link. Existing links are never removed here. */
  addClaimIds: z.array(z.string().uuid()).optional(),
});

/** Ownership is checked explicitly as well as by RLS, per the route convention. */
async function assertOwned(pnlId: string, companyId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("voyage_pnl")
    .select("id, company_id")
    .eq("id", pnlId)
    .maybeSingle();
  if (!data || data.company_id !== companyId) throw new Error("PNL_NOT_FOUND");
  return supabase;
}

// The computed sheet. Recomputed on read rather than served from the last
// snapshot: a linked claim's laytime calculation can change after the snapshot
// was taken, and a P&L quietly showing yesterday's demurrage is exactly the
// failure this module exists to prevent.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ pnlId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { pnlId } = await params;
    const supabase = await assertOwned(pnlId, auth.companyId);

    const loaded = await computeStoredPnl(pnlId, supabase);
    return NextResponse.json({
      pnl: loaded.pnl,
      claimIds: loaded.claimIds,
      result: loaded.result,
    });
  } catch (e) {
    return apiError(e, "voyage-pnl/[pnlId]/GET", {
      PNL_NOT_FOUND: 404,
      INVALID_PNL_TERMS: 400,
      INVALID_PNL_COSTS: 400,
    });
  }
}

// Amend the voyage and re-snapshot. Used to move an estimate to actual as real
// figures arrive.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ pnlId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { pnlId } = await params;
    const supabase = await assertOwned(pnlId, auth.companyId);

    const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const body = parsed.data;

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.terms) patch.terms = body.terms;
    if (body.costs) patch.costs = body.costs;
    if (body.voyageStart !== undefined) patch.voyage_start = body.voyageStart;
    if (body.voyageEnd !== undefined) patch.voyage_end = body.voyageEnd;
    if (body.status) patch.status = body.status;
    if (body.currency) patch.currency = body.currency;
    if (body.notes !== undefined) patch.notes = body.notes;

    const { error } = await supabase.from("voyage_pnl").update(patch).eq("id", pnlId);
    if (error) throw new Error(`PNL_UPDATE_FAILED: ${error.message}`);

    let rejected: string[] = [];
    if (body.addClaimIds?.length) {
      ({ rejected } = await linkClaims(pnlId, auth.companyId, body.addClaimIds, supabase));
    }

    const loaded = await recomputeAndStorePnl(pnlId, supabase);
    return NextResponse.json({
      result: loaded.result,
      claimIds: loaded.claimIds,
      rejectedClaimIds: rejected,
    });
  } catch (e) {
    return apiError(e, "voyage-pnl/[pnlId]/PATCH", {
      PNL_NOT_FOUND: 404,
      INVALID_PNL_TERMS: 400,
      INVALID_PNL_COSTS: 400,
    });
  }
}
