import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";
import { EVENT_TYPE_VALUES, EventTypeEnum } from "@/lib/laytime/types";

const CreateEventSchema = z.object({
  occurredAt: z.string(),
  eventType: z.enum(EVENT_TYPE_VALUES as [EventTypeEnum, ...EventTypeEnum[]]),
  rawText: z.string().default(""),
  page: z.number().int().default(1),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = createServiceRoleClient();
    
    const { data: claim } = await supabase
      .from("claims")
      .select("company_id")
      .eq("id", claimId)
      .single();
      
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    
    const { data: events } = await supabase
      .from("sof_events")
      .select(`
        *,
        clause_flags (*)
      `)
      .eq("claim_id", claimId)
      .order("occurred_at", { ascending: true });

    return NextResponse.json({ 
      events: (events || []).map((e: any) => ({
        ...e,
        claimId: e.claim_id,
        documentId: e.document_id,
        occurredAt: e.occurred_at,
        eventType: e.event_type,
        rawText: e.raw_text,
        aiReasoning: e.ai_reasoning,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
        clauseFlags: e.clause_flags?.map((f: any) => ({
          ...f,
          eventId: f.event_id,
          clauseRef: f.clause_ref,
          createdAt: f.created_at
        }))
      }))
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = createServiceRoleClient();
    
    const { data: claim } = await supabase
      .from("claims")
      .select("company_id")
      .eq("id", claimId)
      .single();
      
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    const body = await req.json();
    const parsed = CreateEventSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    let { data: doc } = await supabase
      .from("documents")
      .select("id")
      .eq("claim_id", claimId)
      .limit(1)
      .single();
      
    if (!doc) {
      const res = await supabase
        .from("documents")
        .insert({
          claim_id: claimId,
          storage_path: `manual/${claimId}`,
          mime: "manual",
          extraction_status: "extracted",
        })
        .select("id")
        .single();
      doc = res.data!;
    }

    if (!doc) throw new Error("Failed to get or create document");

    const { data: event, error } = await supabase
      .from("sof_events")
      .insert({
        claim_id: claimId,
        document_id: doc.id,
        occurred_at: new Date(parsed.data.occurredAt).toISOString(),
        event_type: parsed.data.eventType,
        raw_text: parsed.data.rawText,
        page: parsed.data.page,
        bbox: { x: 0, y: 0, width: 0, height: 0 },
        confidence: 1.0,
        source: "user",
        status: "accepted",
      })
      .select()
      .single();
      
    if (error) throw error;

    let calc;
    try {
      calc = await recomputeLaytimeServerFn(claimId);
    } catch (e) {}

    return NextResponse.json({ 
      event: {
        ...event,
        claimId: event.claim_id,
        documentId: event.document_id,
        occurredAt: event.occurred_at,
        eventType: event.event_type,
        rawText: event.raw_text,
        aiReasoning: event.ai_reasoning,
        createdAt: event.created_at,
        updatedAt: event.updated_at,
      }, 
      calc 
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
