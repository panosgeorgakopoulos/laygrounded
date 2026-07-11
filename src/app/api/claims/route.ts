import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";

const CreateClaimSchema = z.object({
  vessel: z.string().min(1),
  voyageRef: z.string().min(1),
  port: z.string().min(1),
  cargo: z.string().min(1),
  cpForm: z.string().default("GENCON94"),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
    const offset = (Math.max(1, page) - 1) * limit;

    const { data: claims, count, error } = await supabase
      .from("claims")
      .select(`
        *,
        sof_events (id),
        documents (id)
      `, { count: "exact" })
      .eq("company_id", auth.companyId)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);
      
    if (error) throw error;

    const claimIds = claims.map((c: any) => c.id);
    let calculationsMap: Record<string, any> = {};
    
    if (claimIds.length > 0) {
      const { data: calculations } = await supabase
        .from("laytime_calculations")
        .select("claim_id, demurrage_amount, despatch_amount, currency, used_hours, allowed_hours, computed_at")
        .in("claim_id", claimIds)
        .order("computed_at", { ascending: false });
        
      if (calculations) {
        for (const calc of calculations) {
          if (!calculationsMap[calc.claim_id]) {
            calculationsMap[calc.claim_id] = calc;
          }
        }
      }
    }

    const withExposure = claims.map((c: any) => {
      const calc = calculationsMap[c.id];
      return {
        id: c.id,
        vessel: c.vessel,
        voyageRef: c.voyage_ref,
        port: c.port,
        cargo: c.cargo,
        status: c.status,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        eventCount: c.sof_events?.length || 0,
        documentCount: c.documents?.length || 0,
        exposure: calc
          ? {
              demurrageAmount: calc.demurrage_amount,
              despatchAmount: calc.despatch_amount,
              currency: calc.currency,
              usedHours: calc.used_hours,
              allowedHours: calc.allowed_hours,
            }
          : null,
      };
    });
    return NextResponse.json({ 
      claims: withExposure,
      pagination: {
        page,
        limit,
        total: count || 0
      }
    });
  } catch (e) {
    const isAuth = e instanceof Error && (e.message === "UNAUTHORIZED" || e.message === "NO_COMPANY");
    console.error(e);
    return NextResponse.json({ error: isAuth ? (e as Error).message : "INTERNAL_ERROR" }, { status: isAuth ? 401 : 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    const body = await req.json();
    const parsed = CreateClaimSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { data: claim, error } = await supabase
      .from("claims")
      .insert({
        company_id: auth.companyId,
        vessel: parsed.data.vessel,
        voyage_ref: parsed.data.voyageRef,
        port: parsed.data.port,
        cargo: parsed.data.cargo,
        cp_form: parsed.data.cpForm,
        cp_terms: DEFAULT_CP_TERMS,
        created_by: auth.userId,
        status: "draft",
      })
      .select()
      .single();

    if (error) throw error;
    
    return NextResponse.json({ 
      claim: {
        id: claim.id,
        companyId: claim.company_id,
        vessel: claim.vessel,
        voyageRef: claim.voyage_ref,
        port: claim.port,
        cargo: claim.cargo,
        cpForm: claim.cp_form,
        cpTerms: claim.cp_terms,
        createdBy: claim.created_by,
        status: claim.status,
        createdAt: claim.created_at,
        updatedAt: claim.updated_at
      }
    });
  } catch (e) {
    const isAuth = e instanceof Error && (e.message === "UNAUTHORIZED" || e.message === "NO_COMPANY");
    console.error(e);
    return NextResponse.json({ error: isAuth ? (e as Error).message : "INTERNAL_ERROR" }, { status: isAuth ? 401 : 500 });
  }
}
