import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import {
  PnlTermsSchema,
  PnlCostsSchema,
  linkClaims,
  recomputeAndStorePnl,
} from "@/lib/pnl/pnl-server";
import { apiError } from "@/lib/api-errors";

const CreateSchema = z.object({
  vessel: z.string().min(1).max(200),
  voyageRef: z.string().min(1).max(100),
  charterType: z.enum(["voyage", "time"]),
  perspective: z.enum(["owner", "charterer"]).default("owner"),
  currency: z.string().length(3).default("USD"),
  voyageStart: z.string().datetime({ offset: true }).nullable().optional(),
  voyageEnd: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(["estimate", "actual", "closed"]).default("estimate"),
  terms: PnlTermsSchema,
  costs: PnlCostsSchema.optional(),
  /** Port calls whose demurrage flows into this voyage. */
  claimIds: z.array(z.string().uuid()).default([]),
  notes: z.string().max(2000).optional(),
});

// Voyage P&L: the demurrage claim as one line in a complete voyage result.
//
//   GET  → the company's voyages, newest first
//   POST → create a voyage, link its port calls, compute and snapshot
export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("voyage_pnl")
      .select("id, vessel, voyage_ref, charter_type, currency, status, voyage_start, voyage_end, updated_at")
      .eq("company_id", auth.companyId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(`PNL_QUERY_FAILED: ${error.message}`);

    return NextResponse.json({ voyages: data ?? [] });
  } catch (e) {
    return apiError(e, "voyage-pnl/GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const body = parsed.data;
    const supabase = await createClient();

    const { data: created, error } = await supabase
      .from("voyage_pnl")
      .insert({
        company_id: auth.companyId,
        vessel: body.vessel,
        voyage_ref: body.voyageRef,
        charter_type: body.charterType,
        perspective: body.perspective,
        currency: body.currency,
        terms: body.terms,
        costs: body.costs ?? {},
        voyage_start: body.voyageStart ?? null,
        voyage_end: body.voyageEnd ?? null,
        status: body.status,
        notes: body.notes ?? null,
        created_by: auth.userId,
      })
      .select("id")
      .single();
    if (error || !created) throw new Error(`PNL_CREATE_FAILED: ${error?.message}`);

    // Claims are ownership-checked in linkClaims — RLS on the join table is
    // gated on the P&L's company, not the claim's, so it would not catch this.
    const { rejected } = await linkClaims(created.id, auth.companyId, body.claimIds, supabase);

    const loaded = await recomputeAndStorePnl(created.id, supabase);

    return NextResponse.json(
      {
        id: created.id,
        result: loaded.result,
        claimIds: loaded.claimIds,
        rejectedClaimIds: rejected,
      },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "voyage-pnl/POST", {
      INVALID_PNL_TERMS: 400,
      INVALID_PNL_COSTS: 400,
    });
  }
}
