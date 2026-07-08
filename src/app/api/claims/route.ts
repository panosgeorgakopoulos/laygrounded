import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";

const CreateClaimSchema = z.object({
  vessel: z.string().min(1),
  voyageRef: z.string().min(1),
  port: z.string().min(1),
  cargo: z.string().min(1),
  cpForm: z.string().default("GENCON94"),
});

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = createServiceRoleClient();

    const { data: claims, error } = await supabase
      .from("claims")
      .select(`
        *,
        sof_events (id),
        documents (id)
      `)
      .eq("company_id", auth.companyId)
      .order("updated_at", { ascending: false });
      
    if (error) throw error;

    const withExposure = await Promise.all(
      claims.map(async (c: any) => {
        const { data: calc } = await supabase
          .from("laytime_calculations")
          .select("demurrage_amount, despatch_amount, currency, used_hours, allowed_hours")
          .eq("claim_id", c.id)
          .order("computed_at", { ascending: false })
          .limit(1)
          .maybeSingle();

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
      })
    );
    return NextResponse.json({ claims: withExposure });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = createServiceRoleClient();
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
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
