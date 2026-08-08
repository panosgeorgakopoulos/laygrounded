import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { dispatchErpEvents } from "@/lib/events/erp-dispatch";
import { dispatchHinterlandWebhooks } from "@/lib/events/webhook-dispatch";
import { dispatchSettlementPayloads } from "@/lib/events/settlement-dispatch";
import { dispatchNotifications } from "@/lib/notifications/dispatch";
import { runPendingSyncJobs } from "@/lib/integrations/sync";
import { runPendingDeliveries } from "@/lib/webhooks/delivery";
import { apiError } from "@/lib/api-errors";

// Drains `domain_events` into both downstream queues, then delivers.
//
// Two callers, following the established `run-sync` pattern:
//   * a scheduler with the CRON_SECRET header — sweeps ALL companies;
//   * an authenticated user — the same sweep, for observability during a demo.
//
// Both run as service-role: the dispatchers read `integrations`, `api_webhooks`
// and `claims` across the tenant boundary by design, and tenancy comes from each
// event's own `company_id` rather than from the caller. That is the whole reason
// `domain_events.company_id` is NOT NULL.
//
// The three consumers are INDEPENDENT. Each has its own row in
// `domain_event_consumptions`, so a hinterland failure cannot stop ERP pushes,
// and neither can stop a settlement payload being generated.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;

  try {
    if (!isCron) {
      await requireAuth();
    }

    const service = createServiceRoleClient();
    const eventLimit = isCron ? 200 : 50;
    const deliverLimit = isCron ? 25 : 10;

    const erp = await dispatchErpEvents(service, { limit: eventLimit });
    const hinterland = await dispatchHinterlandWebhooks(service, { limit: eventLimit });
    const settlement = await dispatchSettlementPayloads(service, { limit: eventLimit });
    // Fourth consumer, with its own cursor. Runs last only because it is the
    // cheapest — there is no ordering dependency between consumers, and there
    // must not be one: a fact has many independent readers.
    const notifications = await dispatchNotifications(service, { limit: eventLimit });

    // Drain what was just enqueued so a manual trigger shows an end-to-end
    // result rather than "enqueued, check back later".
    const syncDelivery = await runPendingSyncJobs(service, deliverLimit);
    const webhookDelivery = await runPendingDeliveries(service, deliverLimit);

    return NextResponse.json({
      mode: isCron ? "cron" : "manual",
      dispatch: { erp, hinterland, settlement, notifications },
      delivery: { erp: syncDelivery, hinterland: webhookDelivery },
    });
  } catch (e) {
    return apiError(e, "events/dispatch/POST");
  }
}
