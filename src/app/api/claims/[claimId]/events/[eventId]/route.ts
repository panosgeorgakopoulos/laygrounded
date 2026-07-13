import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
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
    const supabase = await createClient();
    
    const { data: claim } = await supabase
      .from("claims")
      .select("company_id")
      .eq("id", claimId)
      .single();
      
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    
    const { data: event } = await supabase
      .from("sof_events")
      .select("claim_id, locked, locked_reason")
      .eq("id", eventId)
      .single();

    if (!event || event.claim_id !== claimId) {
      return NextResponse.json({ error: "EVENT_NOT_FOUND" }, { status: 404 });
    }

    // Charter-chain verified facts are immutable at every tier — the lock
    // would be meaningless if the claim owner could edit around it here.
    if (event.locked) {
      return NextResponse.json(
        { error: "EVENT_LOCKED", reason: event.locked_reason ?? null },
        { status: 409 }
      );
    }
    
    const body = await req.json();
    const parsed = UpdateEventSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const data: any = { updated_at: new Date().toISOString() };
    if (parsed.data.status) data.status = parsed.data.status;
    if (parsed.data.occurredAt) {
      data.occurred_at = new Date(parsed.data.occurredAt).toISOString();
      data.source = "user";
      if (!data.status) data.status = "edited";
    }
    if (parsed.data.eventType) {
      data.event_type = parsed.data.eventType;
      data.source = "user";
      if (!data.status) data.status = "edited";
    }
    if (parsed.data.rawText !== undefined) data.raw_text = parsed.data.rawText;

    const { data: updated, error } = await supabase
      .from("sof_events")
      .update(data)
      .eq("id", eventId)
      .select()
      .single();
      
    if (error) throw error;

    let calc;
    let calcError: string | null = null;
    try {
      calc = await recomputeLaytimeServerFn(claimId);
    } catch (e) {
      calcError = (e as Error).message;
      console.error("[events/PATCH] recompute failed:", e);
    }

    return NextResponse.json({ 
      event: {
        ...updated,
        claimId: updated.claim_id,
        documentId: updated.document_id,
        occurredAt: updated.occurred_at,
        eventType: updated.event_type,
        rawText: updated.raw_text,
        aiReasoning: updated.ai_reasoning,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      }, 
      calc,
      calcError
    });
  } catch (e) {
    const isAuth = e instanceof Error && (e.message === "UNAUTHORIZED" || e.message === "NO_COMPANY");
    console.error(e);
    return NextResponse.json({ error: isAuth ? (e as Error).message : "INTERNAL_ERROR" }, { status: isAuth ? 401 : 500 });
  }
}
