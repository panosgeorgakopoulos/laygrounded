import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";

const CpTermsSchema = z.object({
  laytime_allowed_hours: z.number().min(0),
  load_rate: z.number().min(0).optional(),
  discharge_rate: z.number().min(0).optional(),
  turn_time_hours: z.number().min(0),
  nor_variant: z.enum(["WIBON", "WIPON", "WICCON", "WIFPON"]),
  days_basis: z.enum(["SHINC", "SHEX", "SHEX-UU", "WWDSHEX-EIU", "SSHEX", "SSHEX-UU", "WWDSSHEX-EIU"]),
  demurrage_rate: z.number().min(0),
  despatch_rate: z.number().min(0),
  currency: z.string().length(3),
  port_timezone: z.string().optional()
});

const UpdateClaimSchema = z.object({
  vessel: z.string().min(1).optional(),
  voyageRef: z.string().min(1).optional(),
  port: z.string().min(1).optional(),
  cargo: z.string().min(1).optional(),
  cpTerms: CpTermsSchema.optional(),
  status: z.enum(["draft", "processing", "completed", "failed"]).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    const { data: claim, error } = await supabase
      .from("claims")
      .select(`
        *,
        documents (*),
        sof_events (*),
        laytime_calculations (*),
        companies (*)
      `)
      .eq("id", claimId)
      .single();

    if (error || !claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    claim.documents?.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    claim.sof_events?.sort((a: any, b: any) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
    claim.laytime_calculations?.sort((a: any, b: any) => new Date(b.computed_at).getTime() - new Date(a.computed_at).getTime());

    const eventIds = claim.sof_events?.map((e: any) => e.id) || [];
    let clauseFlags: any[] = [];
    if (eventIds.length > 0) {
      const { data: flags } = await supabase
        .from("clause_flags")
        .select("*")
        .in("event_id", eventIds);
      clauseFlags = flags || [];
    }

    const formattedClaim = {
      ...claim,
      companyId: claim.company_id,
      voyageRef: claim.voyage_ref,
      cpForm: claim.cp_form,
      cpTerms: claim.cp_terms,
      createdBy: claim.created_by,
      createdAt: claim.created_at,
      updatedAt: claim.updated_at,
      company: claim.companies,
      documents: claim.documents?.map((d: any) => ({
        ...d,
        claimId: d.claim_id,
        storagePath: d.storage_path,
        mimeType: d.mime,
        pageCount: d.page_count,
        extractionStatus: d.extraction_status,
        createdAt: d.created_at,
        originalFilename: d.originalFilename || d.storage_path, 
      })),
      sofEvents: claim.sof_events?.map((e: any) => ({
        ...e,
        claimId: e.claim_id,
        documentId: e.document_id,
        occurredAt: e.occurred_at,
        eventType: e.event_type,
        rawText: e.raw_text,
        aiReasoning: e.ai_reasoning,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })),
      calculations: claim.laytime_calculations?.slice(0, 1).map((c: any) => ({
        ...c,
        claimId: c.claim_id,
        usedHours: c.used_hours,
        allowedHours: c.allowed_hours,
        demurrageAmount: c.demurrage_amount,
        despatchAmount: c.despatch_amount,
        computedAt: c.computed_at,
      })),
    };

    return NextResponse.json({ 
      claim: formattedClaim, 
      clauseFlags: clauseFlags.map((f: any) => ({
        ...f,
        eventId: f.event_id,
        clauseRef: f.clause_ref,
        createdAt: f.created_at
      })) 
    });
  } catch (e) {
    const isAuth = e instanceof Error && (e.message === "UNAUTHORIZED" || e.message === "NO_COMPANY");
    console.error(e);
    return NextResponse.json({ error: isAuth ? (e as Error).message : "INTERNAL_ERROR" }, { status: isAuth ? 401 : 500 });
  }
}

export async function PATCH(
  req: NextRequest,
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
      .single();

    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const body = await req.json();
    const parsed = UpdateClaimSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const data: any = { updated_at: new Date().toISOString() };
    if (parsed.data.vessel) data.vessel = parsed.data.vessel;
    if (parsed.data.voyageRef) data.voyage_ref = parsed.data.voyageRef;
    if (parsed.data.port) data.port = parsed.data.port;
    if (parsed.data.cargo) data.cargo = parsed.data.cargo;
    if (parsed.data.status) data.status = parsed.data.status;
    if (parsed.data.cpTerms) data.cp_terms = parsed.data.cpTerms;

    const { data: updated, error } = await supabase
      .from("claims")
      .update(data)
      .eq("id", claimId)
      .select()
      .single();

    if (error) throw error;
    
    return NextResponse.json({ claim: {
      ...updated,
      companyId: updated.company_id,
      voyageRef: updated.voyage_ref,
      cpForm: updated.cp_form,
      cpTerms: updated.cp_terms,
      createdBy: updated.created_by,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at
    } });
  } catch (e) {
    const isAuth = e instanceof Error && (e.message === "UNAUTHORIZED" || e.message === "NO_COMPANY");
    console.error(e);
    return NextResponse.json({ error: isAuth ? (e as Error).message : "INTERNAL_ERROR" }, { status: isAuth ? 401 : 500 });
  }
}
