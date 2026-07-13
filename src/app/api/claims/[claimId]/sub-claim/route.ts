import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { createSubClaim, loadChain } from "@/lib/chain/ripple";
import { apiError } from "@/lib/api-errors";

const SubClaimSchema = z.object({
  counterpartyName: z.string().max(200).optional(),
  chainRole: z.enum(["head_charterer", "sub_charterer", "receiver"]).default("sub_charterer"),
  cpTerms: z
    .object({
      demurrage_rate: z.number().positive().optional(),
      despatch_rate: z.number().nonnegative().optional(),
      laytime_allowed_hours: z.number().positive().optional(),
      turn_time_hours: z.number().nonnegative().optional(),
    })
    .optional(),
});

// Ripple a claim one tier down the charter chain: clone the confirmed event
// record (verified facts locked) into a new linked claim against the next
// counterparty. Creation runs on the service client after the ownership
// check — cloning writes documents + events + a calculation in one sweep.
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
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const parsed = SubClaimSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const service = createServiceRoleClient();
    const result = await createSubClaim(service, claimId, auth.companyId, {
      counterpartyName: parsed.data.counterpartyName ?? null,
      chainRole: parsed.data.chainRole,
      cpTermsOverrides: parsed.data.cpTerms,
      createdBy: auth.userId,
    });

    return NextResponse.json({ subClaim: result }, { status: 201 });
  } catch (e) {
    return apiError(e, "sub-claim/POST", {
      CHAIN_TOO_DEEP: 400,
      NO_CONFIRMED_EVENTS: 400,
    });
  }
}

// The chain as visible to this tenant (RLS hides other tenants' tiers).
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
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const chain = await loadChain(supabase, claimId);
    return NextResponse.json({ chain });
  } catch (e) {
    return apiError(e, "sub-claim/GET");
  }
}
