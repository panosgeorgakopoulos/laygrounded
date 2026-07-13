import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";

// Refresh trigger for the oracle_voyage_stats materialized view (run-sync
// cron pattern): an external scheduler with the CRON_SECRET header, or any
// authenticated user. The refresh function is SECURITY DEFINER and granted
// to service_role only.
export async function POST(req: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const isCron = Boolean(cronSecret) && req.headers.get("x-cron-secret") === cronSecret;
    if (!isCron) {
      await requireAuth();
    }

    const service = createServiceRoleClient();
    const { error } = await service.rpc("refresh_oracle_voyage_stats");
    if (error) throw new Error(`REFRESH_FAILED: ${error.message}`);

    return NextResponse.json({ refreshed: true });
  } catch (e) {
    return apiError(e, "oracle/refresh/POST");
  }
}
