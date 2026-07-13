import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { runVoyageShield } from "@/lib/voyage-shield/monitor";
import { apiError } from "@/lib/api-errors";

const RunSchema = z.object({
  claimId: z.string().uuid().optional(),
});

// Legal Shield worker trigger. Two callers (same contract as run-sync):
//   * an external scheduler with the CRON_SECRET header — sweeps the whole
//     book with the service-role client;
//   * an authenticated user — sweeps their own company (or one claim).
// Idempotency lives in the voyage_alerts unique index, so overlapping runs
// cannot double-protest the same stoppage.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const service = createServiceRoleClient();
    const report = await runVoyageShield(service);
    return NextResponse.json({ mode: "cron", report });
  }

  try {
    const auth = await requireAuth();
    const parsed = RunSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // The sweep runs with the service client (evidence verification writes
    // cached port coordinates; drafting reads across intelligence tables), so
    // ownership is pinned here: either the explicit claim or the company scope.
    const service = createServiceRoleClient();
    if (parsed.data.claimId) {
      const supabase = await createClient();
      const { data: claim } = await supabase
        .from("claims")
        .select("id, company_id")
        .eq("id", parsed.data.claimId)
        .maybeSingle();
      if (!claim || claim.company_id !== auth.companyId) {
        return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
      }
      const report = await runVoyageShield(service, { claimId: claim.id });
      return NextResponse.json({ mode: "manual", report });
    }

    const report = await runVoyageShield(service, { companyId: auth.companyId });
    return NextResponse.json({ mode: "manual", report });
  } catch (e) {
    return apiError(e, "voyage-shield/run/POST");
  }
}

// Recent alerts for the caller's company — the "flagged protests" inbox.
export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: alerts } = await supabase
      .from("voyage_alerts")
      .select(
        "id, claim_id, event_id, draft_id, alert_type, status, detail, created_at, claims!inner(company_id, vessel, voyage_ref, port)"
      )
      .eq("claims.company_id", auth.companyId)
      .order("created_at", { ascending: false })
      .limit(50);

    return NextResponse.json({
      alerts: (alerts ?? []).map((a: any) => ({
        id: a.id,
        claimId: a.claim_id,
        eventId: a.event_id,
        draftId: a.draft_id,
        alertType: a.alert_type,
        status: a.status,
        detail: a.detail,
        createdAt: a.created_at,
        vessel: a.claims?.vessel,
        voyageRef: a.claims?.voyage_ref,
        port: a.claims?.port,
      })),
    });
  } catch (e) {
    return apiError(e, "voyage-shield/run/GET");
  }
}
