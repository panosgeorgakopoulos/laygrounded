// The negotiation phase of a claim.
//
// THE PHASE IS NOT A `claims.status` VALUE, and that is deliberate. `status` is
// derived — `recompute-server.ts` overwrites it on every calculation — so a
// workflow value parked there would survive until the next recompute and then
// vanish with no error anywhere. Agreement had the same problem and was solved
// the same way in Phase 7: a column, not a status.
//
// The phase a claim is in is therefore DERIVED from facts rather than stored as
// a label that could disagree with them:
//
//   agreed      — `agreed_at` is set. Figures final, settlement payload unlocked.
//   negotiating — negotiation opened, or any proposal is still pending.
//   open        — neither. Nobody has disputed anything.
//
// A claim with live disputes always reads as negotiating even if nobody clicked
// "open", because the alternative is a claim that says it is settled while
// somebody is arguing about it.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";

export type NegotiationPhase = "open" | "negotiating" | "agreed";

const ActionSchema = z.object({
  action: z.enum(["open", "close"]),
});

interface ClaimRow {
  agreed_at: string | null;
  negotiation_opened_at: string | null;
}

export function derivePhase(claim: ClaimRow, pendingProposals: number): NegotiationPhase {
  if (claim.agreed_at) return "agreed";
  if (claim.negotiation_opened_at || pendingProposals > 0) return "negotiating";
  return "open";
}

async function loadState(supabase: Awaited<ReturnType<typeof createClient>>, claimId: string) {
  const [{ data: claim }, { count: pending }, { count: resolved }] = await Promise.all([
    supabase
      .from("claims")
      .select("id, company_id, agreed_at, negotiation_opened_at, negotiation_opened_by")
      .eq("id", claimId)
      .maybeSingle(),
    supabase
      .from("event_proposals")
      .select("id", { count: "exact", head: true })
      .eq("claim_id", claimId)
      .eq("status", "pending"),
    supabase
      .from("event_proposals")
      .select("id", { count: "exact", head: true })
      .eq("claim_id", claimId)
      .neq("status", "pending"),
  ]);
  return { claim, pending: pending ?? 0, resolved: resolved ?? 0 };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    const { claim, pending, resolved } = await loadState(supabase, claimId);
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    return NextResponse.json({
      phase: derivePhase(claim, pending),
      negotiationOpenedAt: claim.negotiation_opened_at,
      agreedAt: claim.agreed_at,
      counts: { pending, resolved },
      // Why the phase cannot be left, stated rather than left to the UI to
      // infer — the two would drift.
      blockedFromAgreement:
        pending > 0
          ? `${pending} dispute${pending === 1 ? " is" : "s are"} still open. Every proposal must be accepted or rejected before the figures can be agreed.`
          : null,
    });
  } catch (e) {
    return apiError(e, "claims/negotiation/GET");
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

    const parsed = ActionSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { claim, pending } = await loadState(supabase, claimId);
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    if (claim.agreed_at) {
      return NextResponse.json(
        {
          error: "CLAIM_ALREADY_AGREED",
          detail: "an agreed claim's figures are final; its negotiation phase cannot be changed",
        },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();

    if (parsed.data.action === "open") {
      if (!claim.negotiation_opened_at) {
        const { error } = await supabase
          .from("claims")
          .update({
            negotiation_opened_at: now,
            negotiation_opened_by: auth.userId,
            updated_at: now,
          })
          .eq("id", claimId)
          .is("negotiation_opened_at", null);
        if (error) throw new Error(`PERSIST_FAILED: ${error.message}`);
      }
    } else {
      // Closing with disputes still pending would leave the claim reading
      // "open" while somebody is arguing about it — and `derivePhase` would
      // immediately contradict the stored state anyway.
      if (pending > 0) {
        return NextResponse.json(
          {
            error: "DISPUTES_PENDING",
            detail: `${pending} dispute${pending === 1 ? "" : "s"} still open — resolve them before closing negotiation`,
          },
          { status: 409 }
        );
      }
      const { error } = await supabase
        .from("claims")
        .update({ negotiation_opened_at: null, negotiation_opened_by: null, updated_at: now })
        .eq("id", claimId);
      if (error) throw new Error(`PERSIST_FAILED: ${error.message}`);
    }

    const after = await loadState(supabase, claimId);
    return NextResponse.json({
      phase: derivePhase(after.claim!, after.pending),
      negotiationOpenedAt: after.claim!.negotiation_opened_at,
    });
  } catch (e) {
    return apiError(e, "claims/negotiation/POST", {
      CLAIM_ALREADY_AGREED: 409,
      DISPUTES_PENDING: 409,
    });
  }
}
