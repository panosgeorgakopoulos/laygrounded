import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { evaluateInsuranceTriggers } from "@/lib/insurance/oracle";
import { apiError } from "@/lib/api-errors";

const RunSchema = z.object({
  claimId: z.string().uuid().optional(),
});

// Oracle evaluation trigger (run-sync pattern): cron sweeps every active
// policy against recent calculations; an authenticated user evaluates their
// own company (optionally one claim). Re-runs are safe — emitted windows are
// deduped by the trigger ledger's idempotency key.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const service = createServiceRoleClient();
    const report = await evaluateInsuranceTriggers(service);
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
      const report = await evaluateInsuranceTriggers(service, {
        companyId: auth.companyId,
        claimId: claim.id,
      });
      return NextResponse.json({ mode: "manual", report });
    }

    const report = await evaluateInsuranceTriggers(service, { companyId: auth.companyId });
    return NextResponse.json({ mode: "manual", report });
  } catch (e) {
    return apiError(e, "insurance/run/POST");
  }
}
