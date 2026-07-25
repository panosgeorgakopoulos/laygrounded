import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";

// Housekeeping sweep for the OAuth store: deletes spent authorization codes and
// long-expired tokens via purge_expired_oauth_artifacts() (SECURITY DEFINER,
// service-role EXECUTE only). An unbounded table of dead credentials is both a
// liability and a slow index, so this is meant to run on a schedule.
//
// Run-sync pattern (as settlement/run, voyage-shield/run): a cron header runs
// it; an authenticated user may also trigger it manually. There is no per-tenant
// scoping and nothing to abuse — the function only ever removes rows that have
// ALREADY expired, i.e. dead credentials that can no longer authenticate.

async function purge() {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc("purge_expired_oauth_artifacts");
  if (error) throw new Error(`OAUTH_PURGE_FAILED: ${error.message}`);
  // RETURNS TABLE(...) → a single-row result set.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { codes_deleted?: number; access_deleted?: number; refresh_deleted?: number }
    | null
    | undefined;
  return {
    codesDeleted: row?.codes_deleted ?? 0,
    accessDeleted: row?.access_deleted ?? 0,
    refreshDeleted: row?.refresh_deleted ?? 0,
  };
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) {
    const report = await purge();
    return NextResponse.json({ mode: "cron", report });
  }

  try {
    await requireAuth();
    const report = await purge();
    return NextResponse.json({ mode: "manual", report });
  } catch (e) {
    return apiError(e, "oauth/purge/POST");
  }
}
