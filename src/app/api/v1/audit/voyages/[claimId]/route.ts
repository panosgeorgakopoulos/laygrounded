import { NextRequest } from "next/server";
import { authenticateApiRequest } from "@/lib/api/authenticate";
import { apiAuthFailure, apiFail, apiOk } from "@/lib/api/respond";
import { computeTimeBar } from "@/lib/time-bar";

// GET /api/v1/audit/voyages/{claimId} — the live state of one voyage:
// laytime calculation, dispute status, and time-bar countdown.
//
// Requires calculations:read. Dispute detail additionally requires
// disputes:read — a TMS pulling numbers for an invoice has no business
// reading the counterparty's negotiating position, so the two are separable
// and the response says which it withheld rather than omitting it silently.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  let caller;
  try {
    caller = await authenticateApiRequest(req, "calculations:read");
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/voyages/[id]/GET:auth");
  }

  try {
    const { claimId } = await params;

    // Tenancy is enforced here, not by RLS: an API caller has no Supabase
    // session, so this read runs on the service role. The company filter is
    // the whole boundary — same defence-in-depth rule as every claim route.
    const { data: claim } = await caller.client
      .from("claims")
      .select(
        "id, company_id, vessel, vessel_imo, voyage_ref, port, cargo, status, external_ref, time_bar_days, settled_amount, settled_at, cp_terms"
      )
      .eq("id", claimId)
      .eq("company_id", caller.companyId)
      .maybeSingle();
    // Wrong-tenant and non-existent are the same 404: the API must not
    // confirm that another company's claim id exists.
    if (!claim) return apiFail(404, "VOYAGE_NOT_FOUND", "No voyage with that id for this API key.");

    const [{ data: calc }, { data: events }, { data: docs }] = await Promise.all([
      caller.client
        .from("laytime_calculations")
        .select("allowed_hours, used_hours, demurrage_amount, despatch_amount, currency, computed_at")
        .eq("claim_id", claimId)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      caller.client
        .from("sof_events")
        .select("event_type, occurred_at, status")
        .eq("claim_id", claimId)
        .in("status", ["accepted", "edited"])
        .order("occurred_at", { ascending: true }),
      caller.client.from("documents").select("id").eq("claim_id", claimId).limit(1),
    ]);

    const confirmed = events ?? [];
    const timeBar = computeTimeBar({
      timeBarDays: claim.time_bar_days ?? 90,
      events: confirmed,
      hasSofDocument: (docs?.length ?? 0) > 0,
      hasValidCpTerms: Boolean(claim.cp_terms),
      hasCalculation: Boolean(calc),
    });

    const canReadDisputes = caller.scopes.includes("disputes:read");
    let disputes: unknown = { withheld: true, reason: "This API key lacks the \"disputes:read\" scope." };
    if (canReadDisputes) {
      const [{ data: proposals }, { data: flags }] = await Promise.all([
        caller.client
          .from("event_proposals")
          .select("id, action, status, note, proposed_by_label, proposed_occurred_at, proposed_event_type, created_at")
          .eq("claim_id", claimId)
          .order("created_at", { ascending: false }),
        caller.client
          .from("clause_flags")
          .select("clause_ref, severity, note, event_id")
          .in("event_id", confirmed.length ? (await eventIds(caller.client, claimId)) : []),
      ]);
      const rows = proposals ?? [];
      disputes = {
        withheld: false,
        pending: rows.filter((p) => p.status === "pending").length,
        accepted: rows.filter((p) => p.status === "accepted").length,
        rejected: rows.filter((p) => p.status === "rejected").length,
        // "contested" is a fact about the record, not a judgement: it means a
        // counterparty amendment is awaiting the owner's decision.
        contested: rows.some((p) => p.status === "pending"),
        proposals: rows.map((p) => ({
          id: p.id,
          action: p.action,
          status: p.status,
          note: p.note,
          proposedBy: p.proposed_by_label,
          proposedOccurredAt: p.proposed_occurred_at,
          proposedEventType: p.proposed_event_type,
          createdAt: p.created_at,
        })),
        clauseFlags: (flags ?? []).map((f) => ({
          clauseRef: f.clause_ref,
          severity: f.severity,
          note: f.note,
        })),
      };
    }

    return apiOk(
      {
        claimId: claim.id,
        externalRef: claim.external_ref,
        vessel: claim.vessel,
        vesselImo: claim.vessel_imo,
        voyageRef: claim.voyage_ref,
        port: claim.port,
        cargo: claim.cargo,
        status: claim.status,
        // Null until the events are confirmed and a calculation is stored —
        // never a zero, which would read as "no demurrage due".
        calculation: calc
          ? {
              allowedHours: calc.allowed_hours,
              usedHours: calc.used_hours,
              demurrageAmount: calc.demurrage_amount,
              despatchAmount: calc.despatch_amount,
              currency: calc.currency,
              computedAt: calc.computed_at,
            }
          : null,
        calculationNotice: calc
          ? null
          : "No calculation yet: this voyage has no confirmed events or has not been computed.",
        settlement:
          claim.settled_at != null
            ? { settledAmount: claim.settled_amount, settledAt: claim.settled_at }
            : null,
        timeBar: {
          deadline: timeBar.deadline,
          daysRemaining: timeBar.daysRemaining,
          state: timeBar.state,
          packComplete: timeBar.complete,
        },
        disputes,
        confirmedEventCount: confirmed.length,
      },
      caller
    );
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/voyages/[id]/GET");
  }
}

async function eventIds(
  client: Awaited<ReturnType<typeof authenticateApiRequest>>["client"],
  claimId: string
): Promise<string[]> {
  const { data } = await client.from("sof_events").select("id").eq("claim_id", claimId);
  return (data ?? []).map((e) => e.id as string);
}
