import { NextResponse } from "next/server";
import { ensureDemoUser } from "@/lib/auth-helpers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { seedScenarios } from "@/lib/seed-data";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";

export async function POST(req: Request) {
  const secret = req.headers.get("x-init-secret");
  if (secret !== process.env.INIT_DEMO_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = createServiceRoleClient();
  const user = await ensureDemoUser();
  const { data: membership } = await supabase
    .from("company_members")
    .select("company_id")
    .eq("user_id", user.id)
    .single();

  if (!membership) {
    return NextResponse.json({ ok: false, reason: "no membership" });
  }

  const { count } = await supabase
    .from("claims")
    .select("id", { count: "exact" })
    .eq("company_id", membership.company_id);

  if (count && count > 0) {
    return NextResponse.json({ ok: true, alreadySeeded: true, demoEmail: user.email });
  }

  for (const scenario of seedScenarios) {
    const { data: claim } = await supabase
      .from("claims")
      .insert({
        company_id: membership.company_id,
        vessel: scenario.vessel,
        voyage_ref: scenario.voyageRef,
        port: scenario.port,
        cargo: scenario.cargo,
        cp_form: "GENCON94",
        cp_terms: scenario.cpTerms,
        created_by: user.id,
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
    } catch {}
  }
  return NextResponse.json({
    ok: true,
    seeded: seedScenarios.length,
    demoEmail: user.email,
  });
}
