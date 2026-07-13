import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { runClearinghouse } from "@/lib/settlement/clearinghouse";
import { apiError } from "@/lib/api-errors";

// Clearinghouse sweep trigger (run-sync pattern): cron header runs the whole
// book with the service-role client; an authenticated user sweeps only their
// own company. Race safety is the settlements.claim_id UNIQUE constraint,
// so overlapping sweeps cannot double-clear a claim.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const service = createServiceRoleClient();
    const report = await runClearinghouse(service);
    return NextResponse.json({ mode: "cron", report });
  }

  try {
    const auth = await requireAuth();
    const service = createServiceRoleClient();
    const report = await runClearinghouse(service, { companyId: auth.companyId });
    return NextResponse.json({ mode: "manual", report });
  } catch (e) {
    return apiError(e, "settlement/run/POST");
  }
}
