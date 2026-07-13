import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { MAX_PENDING_PROPOSALS_PER_SHARE, resolveShare } from "@/lib/rooms";
import { EVENT_TYPE_VALUES, EventTypeEnum } from "@/lib/laytime/types";
import { apiError } from "@/lib/api-errors";

const eventTypeEnum = z.enum(EVENT_TYPE_VALUES as [EventTypeEnum, ...EventTypeEnum[]]);

const CreateProposalSchema = z
  .object({
    action: z.enum(["amend", "add", "remove"]),
    eventId: z.string().uuid().optional(),
    proposedOccurredAt: z
      .string()
      .refine((s) => !isNaN(new Date(s).getTime()), "Invalid datetime")
      .optional(),
    proposedEventType: eventTypeEnum.optional(),
    note: z.string().max(2000).default(""),
    proposedByLabel: z.string().max(120).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "remove" && !v.eventId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "remove requires eventId" });
    }
    if (v.action === "amend" && (!v.eventId || !v.proposedOccurredAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "amend requires eventId and proposedOccurredAt" });
    }
    if (v.action === "add" && (!v.proposedOccurredAt || !v.proposedEventType)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "add requires proposedOccurredAt and proposedEventType" });
    }
  });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const supabase = createServiceRoleClient();
    const resolved = await resolveShare(token, supabase);
    if (!resolved) {
      return NextResponse.json({ error: "ROOM_NOT_FOUND" }, { status: 404 });
    }
    const { share, claim } = resolved;

    const body = await req.json().catch(() => ({}));
    const parsed = CreateProposalSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const input = parsed.data;

    // A referenced event must belong to this claim — a foreign event id is
    // either a stale link or a probe; both get the same rejection. Locked
    // events are the charter chain's verified backbone: no amendment or
    // removal may even be proposed against them.
    if (input.eventId) {
      const { data: event } = await supabase
        .from("sof_events")
        .select("id, locked, locked_reason")
        .eq("id", input.eventId)
        .eq("claim_id", claim.id)
        .maybeSingle();
      if (!event) {
        return NextResponse.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
      }
      if (event.locked) {
        return NextResponse.json(
          { error: "EVENT_LOCKED", reason: event.locked_reason ?? null },
          { status: 409 }
        );
      }
    }

    const { count } = await supabase
      .from("event_proposals")
      .select("id", { count: "exact", head: true })
      .eq("share_id", share.id)
      .eq("status", "pending");
    if ((count ?? 0) >= MAX_PENDING_PROPOSALS_PER_SHARE) {
      return NextResponse.json({ error: "TOO_MANY_PENDING_PROPOSALS" }, { status: 429 });
    }

    const { data: proposal, error } = await supabase
      .from("event_proposals")
      .insert({
        claim_id: claim.id,
        share_id: share.id,
        event_id: input.eventId ?? null,
        action: input.action,
        proposed_occurred_at: input.proposedOccurredAt
          ? new Date(input.proposedOccurredAt).toISOString()
          : null,
        proposed_event_type: input.proposedEventType ?? null,
        note: input.note,
        proposed_by_label:
          input.proposedByLabel?.trim() || share.counterparty_label || "Counterparty",
      })
      .select("*")
      .single();

    if (error || !proposal) throw new Error(`PERSIST_FAILED: ${error?.message}`);

    return NextResponse.json(
      {
        proposal: {
          id: proposal.id,
          action: proposal.action,
          eventId: proposal.event_id,
          proposedOccurredAt: proposal.proposed_occurred_at,
          proposedEventType: proposal.proposed_event_type,
          note: proposal.note,
          proposedByLabel: proposal.proposed_by_label,
          status: proposal.status,
          createdAt: proposal.created_at,
        },
      },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "rooms/proposals/POST", { ROOM_NOT_FOUND: 404 });
  }
}
