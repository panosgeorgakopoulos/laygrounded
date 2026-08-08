import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { assertCapability, requireAuth } from "@/lib/server-auth";
import { CRITERION_LABELS, loadEligibility } from "@/lib/settlement/clearinghouse";
import { apiError } from "@/lib/api-errors";

// Marks a claim agreed — the transition that emits `claim.settlement_ready`.
//
// Gated on the SAME eligibility test the clearinghouse uses (voyage complete,
// evidence corroborated, no pending proposals, not already settled). Agreement
// is the moment the numbers stop being negotiable, so it must not be a free-text
// flag a user can set over an open dispute.
//
// The write pins `agreed_calculation_id`: a later recompute changes the numbers,
// and settling against a snapshot nobody agreed is the failure this prevents.
// `escrow-server.ts` blocks the payload when the two diverge.
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
      .select("id, company_id, agreed_at")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    // Agreement is the moment the numbers stop being negotiable and the
    // settlement payload becomes generatable — a finance-manager act, not part
    // of day-to-day laytime work. Checked after ownership so a 403 cannot
    // confirm a stranger's claim id.
    await assertCapability(auth, "claim.agree", {
      req,
      resourceType: "claim",
      resourceId: claimId,
    });

    // Idempotent: agreeing twice is not an error, and must NOT re-stamp
    // `agreed_at` — the trigger fires on NULL → NOT NULL, so a re-stamp would
    // be silent either way, but the original agreement time is the record.
    if (claim.agreed_at) {
      return NextResponse.json({ alreadyAgreed: true, agreedAt: claim.agreed_at });
    }

    const { result: eligibility, calculationId } = await loadEligibility(supabase, claimId);
    if (!eligibility.eligible) {
      return NextResponse.json(
        {
          error: "NOT_AGREEABLE",
          message: "the claim does not yet meet the agreement criteria",
          failures: eligibility.failures,
          criteria: eligibility.criteria,
        },
        { status: 409 }
      );
    }

    // Service-role for the write: the UPDATE fires a SECURITY DEFINER trigger
    // that inserts into the outbox, and the agreement must land with its event
    // in the same transaction.
    const service = createServiceRoleClient();
    const agreedAt = new Date().toISOString();
    const { error } = await service
      .from("claims")
      .update({
        agreed_at: agreedAt,
        agreed_by: auth.userId,
        agreed_calculation_id: calculationId,
        updated_at: agreedAt,
      })
      .eq("id", claimId)
      // Decides the race: two concurrent agreements, one transition, one event.
      .is("agreed_at", null);
    if (error) throw new Error(`AGREE_FAILED: ${error.message}`);

    return NextResponse.json({
      agreed: true,
      agreedAt,
      agreedCalculationId: calculationId,
      amount: eligibility.amount,
      currency: eligibility.currency,
      direction: eligibility.direction,
    });
  } catch (e) {
    return apiError(e, "claims/agree/POST", { NOT_AGREEABLE: 409 });
  }
}

/**
 * Everything the settlement panel needs, in one round trip: which rule set
 * computed the claim, whether it is agreed, why it cannot be, and the payload
 * generated from the agreement if the consumer has run.
 *
 * The payload is READ, never generated here. Generation belongs to the outbox
 * consumer so that exactly one document exists per agreed calculation; a GET
 * that generated on demand would mint a second one with a different `issuedAt`
 * every time somebody opened the panel.
 */
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
      .select("id, company_id, engine_version, agreed_at, agreed_calculation_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const [{ result: eligibility }, { data: payloadRow }] = await Promise.all([
      loadEligibility(supabase, claimId),
      supabase
        .from("settlement_payloads")
        .select("settlement_ref, digest, ready, blockers, payload, created_at")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const payload = payloadRow?.payload as Record<string, unknown> | undefined;

    return NextResponse.json({
      engineVersion: claim.engine_version ?? 1,
      agreedAt: claim.agreed_at,
      agreedCalculationId: claim.agreed_calculation_id,
      eligibility: {
        eligible: eligibility.eligible,
        failures: eligibility.failures,
        // Flattened into a labelled checklist here rather than in the component:
        // `criteria` is a boolean record and the labels belong beside the rules
        // they describe, not in a UI file that would drift from them.
        criteria: (
          Object.keys(eligibility.criteria) as Array<keyof typeof eligibility.criteria>
        ).map((key) => ({
          key,
          label: CRITERION_LABELS[key],
          ok: eligibility.criteria[key],
        })),
        amount: eligibility.amount,
        currency: eligibility.currency,
        direction: eligibility.direction,
      },
      settlement: payloadRow
        ? {
            settlementRef: payloadRow.settlement_ref,
            digest: payloadRow.digest,
            ready: payloadRow.ready,
            blockers: payloadRow.blockers ?? [],
            createdAt: payloadRow.created_at,
            memos: payload?.memos ?? [],
            legs: payload?.legs ?? [],
            components: payload?.components ?? [],
            missingForBank: payload?.missingForBank ?? [],
            missingForChain: payload?.missingForChain ?? [],
            hasEip712: Boolean(payload?.eip712),
            hasIso20022: Boolean(payload?.iso20022),
          }
        : null,
    });
  } catch (e) {
    return apiError(e, "claims/agree/GET");
  }
}
