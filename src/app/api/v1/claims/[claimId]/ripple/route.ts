import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { createSubClaim, loadChain, MAX_CHAIN_DEPTH, type SubClaimResult } from "@/lib/chain/ripple";

const TierSchema = z.object({
  counterpartyName: z.string().min(1).max(200).optional(),
  chainRole: z.enum(["head_charterer", "sub_charterer", "receiver"]).optional(),
  cpTermsOverrides: z
    .object({
      demurrage_rate: z.number().positive().optional(),
      despatch_rate: z.number().min(0).optional(),
      laytime_allowed_hours: z.number().positive().optional(),
      turn_time_hours: z.number().min(0).optional(),
    })
    .optional(),
});

const RippleSchema = z.object({
  // Multi-tier: each entry clones one tier further down the chain, so a
  // verified owner's calculation can cascade Owner → Head → Sub → Receiver
  // in one call. Evidence-corroborated events clone LOCKED at every tier.
  tiers: z.array(TierSchema).min(1).max(MAX_CHAIN_DEPTH).default([{}]),
});

// Multi-tier ripple: clones the claim's verified record down the charter
// chain via the existing chain engine (locks propagate; sub-claims never
// share document rows with their parent).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();

    const parsed = RippleSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Defense-in-depth ownership check on the RLS client before any
    // service-role work (createSubClaim re-checks internally as well).
    const supabase = await createClient();
    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const service = createServiceRoleClient();
    const results: SubClaimResult[] = [];
    let parentId = claimId;
    for (const tier of parsed.data.tiers) {
      const result = await createSubClaim(service, parentId, auth.companyId, {
        counterpartyName: tier.counterpartyName ?? null,
        chainRole: tier.chainRole,
        cpTermsOverrides: tier.cpTermsOverrides,
        createdBy: auth.userId,
      });
      results.push(result);
      parentId = result.subClaimId;
    }

    return NextResponse.json({ tiers: results }, { status: 201 });
  } catch (e) {
    return apiError(e, "v1/claims/ripple/POST", {
      CHAIN_TOO_DEEP: 409,
      NO_CONFIRMED_EVENTS: 409,
    });
  }
}

// The chain as visible to the caller (RLS hides tiers owned by other tenants).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    return NextResponse.json({ chain: await loadChain(supabase, claimId) });
  } catch (e) {
    return apiError(e, "v1/claims/ripple/GET");
  }
}
