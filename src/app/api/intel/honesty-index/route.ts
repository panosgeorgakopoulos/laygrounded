import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import {
  MIN_DECISIVE_CHECKS,
  scoreHonesty,
  type HonestyIndexRow,
  type HonestyScore,
} from "@/lib/intel/honesty-index";

// Terminal & Agent Honesty Index. The `honesty_index` materialized view is a
// cross-company aggregate, so it carries no RLS and no grants to
// anon/authenticated — it is read exclusively here via the service-role
// client. This route is the privacy boundary: it returns only aggregate
// scores (never claim or company identifiers), and the no-subject listing
// applies the k-anonymity floor so thin subjects can't be enumerated.

export async function GET(req: NextRequest) {
  try {
    // Any authenticated user may query the index — it's the paid network
    // feature, not company-scoped data.
    await requireAuth();

    const params = req.nextUrl.searchParams;
    const subject = params.get("subject")?.trim().toLowerCase() || null;
    const typeParam = params.get("type");
    if (typeParam !== null && typeParam !== "port" && typeParam !== "agent") {
      throw new Error("VALIDATION_ERROR");
    }
    const limitRaw = Number(params.get("limit") ?? 20);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.floor(limitRaw), 1), 100)
      : 20;

    const service = createServiceRoleClient();
    let query = service
      .from("honesty_index")
      .select(
        "subject_type, subject_key, subject_label, check_type, total_checks, decisive_checks, contradicted_checks, corroborated_checks, claims_covered, last_checked_at"
      );

    if (typeParam) query = query.eq("subject_type", typeParam);

    if (subject) {
      // Point lookup: subject_key is stored lower(trim(...))-normalized.
      query = query.eq("subject_key", subject);
    } else {
      // Worst offenders first. Only subjects above the k-anonymity floor are
      // listed at all — thin subjects must not be enumerable.
      query = query.gte("decisive_checks", MIN_DECISIVE_CHECKS);
    }

    const { data, error } = await query
      .order("contradicted_checks", { ascending: false })
      .limit(limit);
    if (error) throw new Error(`HONESTY_INDEX_READ_FAILED: ${error.message}`);

    // scoreHonesty suppresses rate + warning below the floor
    // (insufficient_data), covering the point-lookup path.
    const scores: HonestyScore[] = ((data ?? []) as HonestyIndexRow[]).map(scoreHonesty);
    return NextResponse.json({ scores });
  } catch (e) {
    return apiError(e, "intel/honesty-index/GET");
  }
}

// Refresh trigger, mirroring /api/integrations/run-sync: an external
// scheduler with the CRON_SECRET header, or any authenticated user. Either
// way the refresh itself runs as service role — refresh_honesty_index() is
// SECURITY DEFINER and only granted to service_role.
export async function POST(req: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const isCron = Boolean(cronSecret) && req.headers.get("x-cron-secret") === cronSecret;
    if (!isCron) {
      await requireAuth();
    }

    const service = createServiceRoleClient();
    const { error } = await service.rpc("refresh_honesty_index");
    if (error) throw new Error(`REFRESH_FAILED: ${error.message}`);

    return NextResponse.json({ refreshed: true });
  } catch (e) {
    return apiError(e, "intel/honesty-index/POST");
  }
}
