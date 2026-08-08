import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertCapability, requireAuth } from "@/lib/server-auth";
import { loadClaimComputationInputs } from "@/lib/laytime/recompute-server";
import { diffScenarios, ProposalInput, ScenarioDiff } from "@/lib/laytime/diff";
import { apiError } from "@/lib/api-errors";
import { z } from "zod";
import { EVENT_TYPE_VALUES } from "@/lib/laytime/types";

function serializeProposal(p: any) {
  return {
    id: p.id,
    shareId: p.share_id,
    action: p.action,
    eventId: p.event_id,
    proposedOccurredAt: p.proposed_occurred_at,
    proposedEventType: p.proposed_event_type,
    note: p.note,
    proposedByLabel: p.proposed_by_label,
    status: p.status,
    createdAt: p.created_at,
    decidedAt: p.decided_at,
  };
}

// Owner-side view of the negotiation: every proposal on the claim plus the
// redline diff (baseline vs all-pending-applied).
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
      .select("company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const { data: proposals } = await supabase
      .from("event_proposals")
      .select("*")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: true });

    let diff: ScenarioDiff | null = null;
    try {
      const { cpTerms, sofInputs } = await loadClaimComputationInputs(claimId, supabase);
      const pending: ProposalInput[] = (proposals || [])
        .filter((p) => p.status === "pending")
        .map((p) => ({
          id: p.id,
          action: p.action,
          event_id: p.event_id,
          proposed_occurred_at: p.proposed_occurred_at,
          proposed_event_type: p.proposed_event_type,
        }));
      diff = diffScenarios(sofInputs, cpTerms, pending);
    } catch {
      // Claims without valid CP terms have no diff to show; the proposal
      // list is still useful on its own.
    }

    return NextResponse.json({
      proposals: (proposals || []).map(serializeProposal),
      diff,
    });
  } catch (e) {
    return apiError(e, "proposals/GET");
  }
}

const CreateProposalSchema = z.object({
  action: z.enum(["amend", "add", "remove"]),
  /** Required for amend/remove; must be absent for add. */
  eventId: z.string().uuid().nullish(),
  proposedOccurredAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid datetime")
    .nullish(),
  proposedEventType: z.enum(EVENT_TYPE_VALUES as [string, ...string[]]).nullish(),
  note: z.string().min(1).max(2000),
});

/**
 * Raise a dispute from the OWNER's side.
 *
 * The guest twin is `POST /api/rooms/[token]/proposals`; both write the same
 * `event_proposals` rows and both are reviewed through the same PATCH. The only
 * difference is provenance: a guest proposal carries `share_id`, an owner's
 * carries NULL. That distinction is worth keeping — "the charterer disputes
 * this" and "we expect the charterer to dispute this" are different facts, and
 * the audit trail should not flatten them.
 *
 * Raising a dispute OPENS the negotiation phase if it is not already open. The
 * alternative — requiring a separate click first — would let the two disagree,
 * and a claim with live disputes that claims not to be negotiating is a lie the
 * settlement gate would then act on.
 */
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
      .select("id, company_id, agreed_at, negotiation_opened_at")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    await assertCapability(auth, "claim.write", {
      req,
      resourceType: "claim",
      resourceId: claimId,
    });

    // Agreement is the moment the numbers stop being negotiable. A dispute
    // raised afterwards would sit pending against figures both sides signed
    // off, and `escrow-server.ts` would keep generating payloads from them.
    if (claim.agreed_at) {
      return NextResponse.json(
        {
          error: "CLAIM_ALREADY_AGREED",
          detail:
            "this claim is agreed — its figures are final. Reopen the agreement before disputing an event.",
        },
        { status: 409 }
      );
    }

    const parsed = CreateProposalSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const input = parsed.data;

    if (input.action !== "add" && !input.eventId) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", detail: "eventId is required to amend or remove an event" },
        { status: 400 }
      );
    }
    if (input.action === "amend" && !input.proposedOccurredAt && !input.proposedEventType) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          detail: "an amendment must propose a new time or a new event type",
        },
        { status: 400 }
      );
    }

    // The event must belong to THIS claim. Without this a valid claim id plus a
    // borrowed event id would attach a proposal across tenants.
    if (input.eventId) {
      const { data: ev } = await supabase
        .from("sof_events")
        .select("id")
        .eq("id", input.eventId)
        .eq("claim_id", claimId)
        .maybeSingle();
      if (!ev) {
        return NextResponse.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
      }
    }

    const { data: company } = await supabase
      .from("companies")
      .select("name")
      .eq("id", auth.companyId)
      .maybeSingle();

    const { data: created, error } = await supabase
      .from("event_proposals")
      .insert({
        claim_id: claimId,
        // NULL: raised internally, not through a claim room.
        share_id: null,
        event_id: input.eventId ?? null,
        action: input.action,
        proposed_occurred_at: input.proposedOccurredAt ?? null,
        proposed_event_type: input.proposedEventType ?? null,
        note: input.note,
        proposed_by_label: company?.name ?? auth.email ?? "Owner",
        status: "pending",
      })
      .select("*")
      .single();
    if (error) throw new Error(`PERSIST_FAILED: ${error.message}`);

    let negotiationOpenedAt = claim.negotiation_opened_at as string | null;
    if (!negotiationOpenedAt) {
      const now = new Date().toISOString();
      const { error: openErr } = await supabase
        .from("claims")
        .update({
          negotiation_opened_at: now,
          negotiation_opened_by: auth.userId,
          updated_at: now,
        })
        .eq("id", claimId)
        // Decides the race: two concurrent first disputes, one opening.
        .is("negotiation_opened_at", null);
      if (openErr) throw new Error(`PERSIST_FAILED: ${openErr.message}`);
      negotiationOpenedAt = now;
    }

    return NextResponse.json({
      proposal: serializeProposal(created),
      negotiationOpenedAt,
    });
  } catch (e) {
    return apiError(e, "proposals/POST", { EVENT_NOT_FOUND: 404, CLAIM_ALREADY_AGREED: 409 });
  }
}
