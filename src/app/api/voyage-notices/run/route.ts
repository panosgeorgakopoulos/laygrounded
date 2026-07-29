import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { runNoticeSweep } from "@/lib/voyage/notices-server";
import { apiError } from "@/lib/api-errors";

const RunSchema = z.object({
  claimId: z.string().uuid().optional(),
  leadDays: z.number().int().min(1).max(180).optional(),
  staleAfterHours: z.number().int().min(1).max(2160).optional(),
  dryRun: z.boolean().optional(),
});

// Protective-notice and SoF-chase worker. Same two-caller contract as
// voyage-shield/run and integrations/run-sync:
//   * an external scheduler with the CRON_SECRET header — whole book, service
//     role;
//   * an authenticated user — their own company, or one claim they own.
//
// Every output is queued for human approval; this route never serves anything.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const service = createServiceRoleClient();
    const report = await runNoticeSweep(service);
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
    const { claimId, ...sweepOpts } = parsed.data;

    // The sweep drafts across intelligence tables, so it runs service-role and
    // ownership is pinned here rather than relying on RLS inside the worker.
    const service = createServiceRoleClient();
    if (claimId) {
      const supabase = await createClient();
      const { data: claim } = await supabase
        .from("claims")
        .select("id, company_id")
        .eq("id", claimId)
        .maybeSingle();
      if (!claim || claim.company_id !== auth.companyId) {
        return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
      }
      const report = await runNoticeSweep(service, { ...sweepOpts, claimId: claim.id });
      return NextResponse.json({ mode: "manual", report });
    }

    const report = await runNoticeSweep(service, { ...sweepOpts, companyId: auth.companyId });
    return NextResponse.json({ mode: "manual", report });
  } catch (e) {
    return apiError(e, "voyage-notices/run/POST");
  }
}

// The approval queue: what the sweeps have drafted and nobody has actioned yet.
export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("pending_human_reviews")
      .select("id, claim_id, subject_type, subject_id, summary, payload, created_at, claims!inner(company_id, vessel, voyage_ref, port)")
      .eq("status", "pending")
      .in("subject_type", ["protective_notice", "sof_chase"])
      .eq("claims.company_id", auth.companyId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`REVIEW_QUERY_FAILED: ${error.message}`);
    return NextResponse.json({ reviews: data ?? [] });
  } catch (e) {
    return apiError(e, "voyage-notices/run/GET");
  }
}
