import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { runPendingSyncJobs, enqueueSyncJob } from "@/lib/integrations/sync";
import { apiError } from "@/lib/api-errors";

// Sync worker trigger. Two callers:
//   * an external scheduler (cron) with the CRON_SECRET header — runs the
//     whole queue with the service-role client;
//   * an authenticated user — enqueues a pull for their own integrations and
//     drains the queue.
// Next.js route handlers have no resident worker; at-least-once delivery
// comes from the queue's backoff + this endpoint being hit on a schedule.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const supabase = createServiceRoleClient();
    // Enqueue a voyage pull per active integration (deduped per hour), then drain.
    const { data: integrations } = await supabase
      .from("integrations")
      .select("id")
      .eq("status", "active");
    const hourBucket = new Date().toISOString().slice(0, 13);
    for (const i of integrations ?? []) {
      await enqueueSyncJob(supabase, i.id, "pull_voyages", {
        idempotencyKey: `pull:${hourBucket}`,
      });
    }
    const report = await runPendingSyncJobs(supabase, 25);
    return NextResponse.json({ mode: "cron", report });
  }

  try {
    const auth = await requireAuth();
    const supabase = await createClient();
    const service = createServiceRoleClient();

    const { data: integrations } = await supabase
      .from("integrations")
      .select("id")
      .eq("company_id", auth.companyId)
      .eq("status", "active");

    const minuteBucket = new Date().toISOString().slice(0, 16);
    for (const i of integrations ?? []) {
      await enqueueSyncJob(service, i.id, "pull_voyages", {
        idempotencyKey: `pull:${minuteBucket}`,
      });
    }
    // Drain with the service client: job execution crosses RLS boundaries
    // (webhook_logs inserts) and the jobs were ownership-checked at enqueue.
    const report = await runPendingSyncJobs(service, 25);
    return NextResponse.json({ mode: "manual", report });
  } catch (e) {
    return apiError(e, "run-sync/POST");
  }
}
