import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { enqueueSyncJob, runPendingSyncJobs } from "@/lib/integrations/sync";
import { apiError } from "@/lib/api-errors";

const PushSchema = z.object({
  integrationId: z.string().uuid(),
  kind: z.enum(["push_invoice", "push_ledger"]).default("push_invoice"),
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
      .select("id, company_id, status")
      .eq("id", parsed.data.integrationId)
      .eq("company_id", auth.companyId)
      .maybeSingle();
    if (!integration) {
      return NextResponse.json({ error: "INTEGRATION_NOT_FOUND" }, { status: 404 });
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
    });
  }
}
