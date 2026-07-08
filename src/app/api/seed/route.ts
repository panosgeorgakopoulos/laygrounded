import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { seedScenarios } from "@/lib/seed-data";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";

export async function POST() {
  try {
    const auth = await requireAuth();
    const supabase = createServiceRoleClient();
    const created: string[] = [];
    
    for (const scenario of seedScenarios) {
      const { data: claim } = await supabase
        .from("claims")
        .insert({
          company_id: auth.companyId,
          vessel: scenario.vessel,
          voyage_ref: scenario.voyageRef,
          port: scenario.port,
          cargo: scenario.cargo,
          cp_form: "GENCON94",
          cp_terms: scenario.cpTerms,
          created_by: auth.userId,
          status: "draft",
        })
        .select("id")
        .single();
        
      if (!claim) continue;

      const { data: doc } = await supabase
        .from("documents")
        .insert({
          claim_id: claim.id,
          storage_path: `seed/${claim.id}`,
          mime: "application/pdf",
          extraction_status: "extracted",
          page_count: 1,
        })
        .select("id")
        .single();
        
      if (!doc) continue;

      for (const ev of scenario.events) {
        await supabase.from("sof_events").insert({
          claim_id: claim.id,
          document_id: doc.id,
          occurred_at: new Date(ev.occurred_at).toISOString(),
          event_type: ev.event_type,
          raw_text: ev.verbatim,
          page: ev.page,
          bbox: ev.bbox,
          confidence: ev.confidence,
          source: "ai",
          status: "accepted",
          ai_reasoning: ev.reasoning,
        });
      }

      try {
        await recomputeLaytimeServerFn(claim.id);
      } catch (e) {
        // ignore
      }
      created.push(claim.id);
    }
    return NextResponse.json({ seeded: created.length, claimIds: created });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
