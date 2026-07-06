// PATCH /api/claims/[claimId]/events/[eventId] — update event status (accept/edit/reject).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/server-auth";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";
import { EVENT_TYPE_VALUES, EventTypeEnum } from "@/lib/laytime/types";

const UpdateEventSchema = z.object({
  status: z.enum(["accepted", "edited", "rejected"]).optional(),
  occurredAt: z.string().optional(),
  eventType: z.enum(EVENT_TYPE_VALUES as [EventTypeEnum, ...EventTypeEnum[]]).optional(),
  rawText: z.string().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; eventId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId, eventId } = await params;
    const claim = await db.claim.findUnique({ where: { id: claimId } });
    if (!claim || claim.companyId !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    const event = await db.sofEvent.findUnique({ where: { id: eventId } });
    if (!event || event.claimId !== claimId) {
      return NextResponse.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
    }
    const body = await req.json();
    const parsed = UpdateEventSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const data: any = {};
    if (parsed.data.status) data.status = parsed.data.status;
    if (parsed.data.occurredAt) {
      data.occurredAt = new Date(parsed.data.occurredAt);
      // Editing timestamp means user-edited.
      data.source = "user";
      if (data.status === undefined) data.status = "edited";
    }
    if (parsed.data.eventType) {
      data.eventType = parsed.data.eventType;
      data.source = "user";
      if (data.status === undefined) data.status = "edited";
    }
    if (parsed.data.rawText !== undefined) data.rawText = parsed.data.rawText;

    const updated = await db.sofEvent.update({ where: { id: eventId }, data });

    // Trigger recompute on accept/edit/reject.
    let calc;
    try {
      calc = await recomputeLaytimeServerFn(claimId);
    } catch {
      // ignore — no NOR
    }

    return NextResponse.json({ event: updated, calc });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
