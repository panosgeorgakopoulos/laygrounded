import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { enqueueSyncJob, runPendingSyncJobs, supportsJobKind } from "@/lib/integrations/sync";
import type { IntegrationRow } from "@/lib/integrations/types";
import { apiError } from "@/lib/api-errors";

const PushSchema = z.object({
  integrationId: z.string().uuid(),
  kind: z.enum(["push_invoice", "push_ledger", "push_pnl"]).default("push_invoice"),
  // Required for push_pnl: a P&L is keyed on the voyage sheet, not the claim.
  voyagePnlId: z.string().uuid().optional(),
});

// Push this claim's finalized invoice/event ledger to an ERP. Enqueues an
// idempotent job (keyed on the calculation snapshot, so re-pushing the same
// numbers is a no-op) and drains the queue inline for responsiveness.
export async function POST(
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
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const parsed = PushSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { data: integration } = await supabase
      .from("integrations")
      .select(
        "id, company_id, provider, display_name, base_url, auth, config, status, last_error, last_sync_at"
      )
      .eq("id", parsed.data.integrationId)
      .eq("company_id", auth.companyId)
      .maybeSingle();
    if (!integration) {
      return NextResponse.json({ error: "INTEGRATION_NOT_FOUND" }, { status: 404 });
    }

    // Refuse an impossible push here, where the user can act on it, rather than
    // accepting it and dead-lettering after six delivery attempts. Returned
    // directly rather than thrown: `apiError` matches sentinels on the WHOLE
    // message, so a detailed one would fall through to an opaque 500.
    if (!supportsJobKind(integration as unknown as IntegrationRow, parsed.data.kind)) {
      return NextResponse.json(
        {
          error: "UNSUPPORTED_JOB_KIND",
          message: `${integration.provider} does not support '${parsed.data.kind}'`,
        },
        { status: 400 }
      );
    }

    if (parsed.data.kind === "push_pnl") {
      if (!parsed.data.voyagePnlId) {
        return NextResponse.json({ error: "MISSING_VOYAGE_PNL_ID" }, { status: 400 });
      }
      // Ownership: the sheet must belong to the caller's company, checked
      // explicitly rather than left to RLS (the job runs as service-role).
      const { data: pnl } = await supabase
        .from("voyage_pnl")
        .select("id, company_id, updated_at")
        .eq("id", parsed.data.voyagePnlId)
        .eq("company_id", auth.companyId)
        .maybeSingle();
      if (!pnl) {
        return NextResponse.json({ error: "PNL_NOT_FOUND" }, { status: 404 });
      }

      const service = createServiceRoleClient();
      const { jobId, deduped } = await enqueueSyncJob(service, integration.id, "push_pnl", {
        claimId,
        idempotencyKey: `push_pnl:${pnl.id}:${pnl.updated_at}`,
        payload: { voyage_pnl_id: pnl.id },
      });
      const report = await runPendingSyncJobs(service, 5);
      return NextResponse.json({ jobId, deduped, report });
    }

    const { data: calc } = await supabase
      .from("laytime_calculations")
      .select("computed_at")
      .eq("claim_id", claimId)
      .maybeSingle();
    if (!calc) {
      return NextResponse.json({ error: "NO_CALCULATION" }, { status: 400 });
    }

    const service = createServiceRoleClient();
    const { jobId, deduped } = await enqueueSyncJob(service, integration.id, parsed.data.kind, {
      claimId,
      idempotencyKey: `${parsed.data.kind}:${claimId}:${calc.computed_at}`,
    });
    const report = await runPendingSyncJobs(service, 5);

    return NextResponse.json({ jobId, deduped, report });
  } catch (e) {
    return apiError(e, "claims/push/POST", {
      INTEGRATION_NOT_FOUND: 404,
      NO_CALCULATION: 400,
      MISSING_VOYAGE_PNL_ID: 400,
      PNL_NOT_FOUND: 404,
    });
  }
}
