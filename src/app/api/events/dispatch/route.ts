import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { dispatchErpEvents } from "@/lib/events/erp-dispatch";
import { runPendingSyncJobs } from "@/lib/integrations/sync";
import { apiError } from "@/lib/api-errors";

// Drains `domain_events` into ERP sync jobs, then drains the sync queue.
//
// Two callers, following the established `run-sync` pattern:
//   * a scheduler with the CRON_SECRET header — dispatches across ALL companies;
//   * an authenticated user — the same sweep, for observability during a demo.
//
// Both run as service-role: the dispatcher reads `integrations` and `claims`
// across the tenant boundary by design, and tenancy comes from each event's
// own `company_id` rather than from the caller. That is the whole reason
// `domain_events.company_id` is NOT NULL.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;

  try {
    if (!isCron) {
      // Authenticated callers are allowed to trigger the sweep but get no
      // tenant-scoped variant: the dispatcher is a global worker, and a
      // per-company version would need a different, narrower query.
      await requireAuth();
    }

    const service = createServiceRoleClient();
    const dispatch = await dispatchErpEvents(service, { limit: isCron ? 200 : 50 });
    // Drain what was just enqueued so a manual trigger shows an end-to-end
    // result rather than "enqueued, check back later".
    const delivery = await runPendingSyncJobs(service, isCron ? 25 : 10);

    return NextResponse.json({ mode: isCron ? "cron" : "manual", dispatch, delivery });
  } catch (e) {
    return apiError(e, "events/dispatch/POST");
  }
}
