import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";

// ERP sync health for external monitoring (UptimeRobot / k8s probes):
// 200 = queue healthy, 503 = attention required. Unauthenticated by design,
// so the body is aggregate-only — counts and timestamps, never tenant data,
// integration ids, or error strings.
//
// "Unhealthy" means any of:
//   * dead-lettered jobs exist (exhausted retries — needs a human);
//   * an integration is in status 'error';
//   * pending jobs are overdue by > OVERDUE_GRACE_MS (the silent-failure
//     case: the cron that drains the queue has stopped firing).
// Note the queue's failure model: a failed attempt returns the job to
// 'pending' with backoff — so a stalled retry backlog, not a 'failed' row,
// is what a dying sync actually looks like.

const OVERDUE_GRACE_MS = 15 * 60 * 1000;

export async function GET() {
  try {
    const supabase = createServiceRoleClient();
    const overdueCutoff = new Date(Date.now() - OVERDUE_GRACE_MS).toISOString();

    const [
      { count: deadJobs },
      { count: overduePending },
      { count: erroredIntegrations },
      { data: lastTerminal },
    ] = await Promise.all([
      supabase.from("sync_jobs").select("id", { count: "exact", head: true }).eq("status", "dead"),
      supabase
        .from("sync_jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .lt("next_attempt_at", overdueCutoff),
      supabase
        .from("integrations")
        .select("id", { count: "exact", head: true })
        .eq("status", "error"),
      supabase
        .from("sync_jobs")
        .select("status, updated_at")
        .in("status", ["succeeded", "failed", "dead"])
        .order("updated_at", { ascending: false })
        .limit(1),
    ]);

    const last = lastTerminal?.[0] ?? null;
    const reasons: string[] = [];
    if ((deadJobs ?? 0) > 0) reasons.push("dead_letter_jobs_present");
    if ((overduePending ?? 0) > 0) reasons.push("pending_jobs_overdue");
    if ((erroredIntegrations ?? 0) > 0) reasons.push("integration_in_error_state");
    if (last && last.status !== "succeeded") reasons.push("last_terminal_job_not_succeeded");

    const healthy = reasons.length === 0;
    const body = {
      status: healthy ? "ok" : "unhealthy",
      reasons,
      checks: {
        dead_jobs: deadJobs ?? 0,
        overdue_pending_jobs: overduePending ?? 0,
        integrations_in_error: erroredIntegrations ?? 0,
        last_terminal_job: last ? { status: last.status, at: last.updated_at } : null,
      },
      checked_at: new Date().toISOString(),
    };

    return NextResponse.json(body, {
      status: healthy ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    // The health check itself failing is an outage signal, not a 200.
    return NextResponse.json(
      { status: "unhealthy", reasons: ["health_check_error"] },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
