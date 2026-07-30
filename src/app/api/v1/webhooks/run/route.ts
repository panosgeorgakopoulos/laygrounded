import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { sweepTimeBarWebhooks } from "@/lib/api/webhooks";

// Time-bar alert sweep. Two callers (same contract as the other run routes):
//   * an external scheduler with the CRON_SECRET header — whole book;
//   * an authenticated user — their own company.
//
// Session- or cron-authenticated, deliberately NOT API-key authenticated:
// this fires webhooks, so it is an operator action, not something an
// integrator's read key should be able to trigger.
//
// Safe to run often. Idempotency lives in the (webhook_id, idempotency_key)
// unique index, so a claim crossing into 'warning' alerts once, not once per
// sweep — hourly or daily are both fine.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const service = createServiceRoleClient();
    const report = await sweepTimeBarWebhooks({ client: service });
    return NextResponse.json({ mode: "cron", report });
  }

  try {
    const auth = await requireAuth();
    const service = createServiceRoleClient();
    const report = await sweepTimeBarWebhooks({ client: service, companyId: auth.companyId });
    return NextResponse.json({ mode: "user", report });
  } catch (e) {
    return apiError(e, "v1/webhooks/run/POST");
  }
}
