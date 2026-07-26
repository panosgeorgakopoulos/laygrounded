import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { buildBenchmarkReport, type Observation } from "@/lib/intel/benchmark";

// Same history window as the congestion index, so the two surfaces cannot
// disagree about the same lane.
const MONTHS_OF_HISTORY = 24;

/**
 * Your book against the market, on the same measures.
 *
 * Cross-tenant reads run on the service-role client because the source view has
 * no end-user grants. The caller's own company id comes from the session and is
 * used to SPLIT the observations, never to filter the market down to them — the
 * pure module excludes your rows from the baseline itself.
 *
 * `?port=` scopes the comparison to one lane.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const service = createServiceRoleClient();

    const portParam = req.nextUrl.searchParams.get("port");
    const portKey = portParam ? portParam.trim().toLowerCase() : null;

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - MONTHS_OF_HISTORY);
    const cutoffIso = cutoff.toISOString();

    let waitingQuery = service
      .from("port_congestion_stats")
      .select("company_id, waiting_hours, port_key")
      .gte("nor_at", cutoffIso);
    if (portKey) waitingQuery = waitingQuery.eq("port_key", portKey);

    // Settlement performance comes from the claims themselves: recovery rate is
    // what was actually collected against what the engine computed, and cycle
    // time is claim creation to settlement.
    let settledQuery = service
      .from("claims")
      .select(
        "company_id, port, created_at, settled_at, settled_amount, " +
          "laytime_calculations(demurrage_amount, computed_at)",
      )
      .not("settled_at", "is", null)
      .gte("settled_at", cutoffIso);
    if (portKey) settledQuery = settledQuery.ilike("port", portParam!.trim());

    const [{ data: waitingRows, error: waitErr }, { data: settledRows, error: settleErr }] =
      await Promise.all([waitingQuery, settledQuery]);

    if (waitErr) throw waitErr;
    if (settleErr) throw settleErr;

    const waiting: Observation[] = (waitingRows ?? []).map((r) => ({
      companyId: r.company_id,
      value: Number(r.waiting_hours),
    }));

    const recovery: Observation[] = [];
    const cycle: Observation[] = [];

    for (const row of (settledRows ?? []) as unknown as Array<Record<string, any>>) {
      const calcs = Array.isArray(row.laytime_calculations)
        ? row.laytime_calculations
        : row.laytime_calculations
          ? [row.laytime_calculations]
          : [];
      // Newest calculation is the one the settlement was struck against.
      const latest = calcs.sort(
        (a: any, b: any) =>
          new Date(b.computed_at).getTime() - new Date(a.computed_at).getTime(),
      )[0];

      const claimed = latest ? Number(latest.demurrage_amount) : 0;
      const settled = Number(row.settled_amount ?? 0);
      // A claim with nothing computed has no recovery *rate* — dividing by zero
      // would manufacture a 0% or an Infinity, both of them fiction.
      if (claimed > 0) {
        recovery.push({
          companyId: row.company_id,
          value: Math.min((settled / claimed) * 100, 200),
        });
      }

      if (row.created_at && row.settled_at) {
        const days =
          (new Date(row.settled_at).getTime() - new Date(row.created_at).getTime()) / 86_400_000;
        if (days >= 0) cycle.push({ companyId: row.company_id, value: Math.round(days) });
      }
    }

    const report = buildBenchmarkReport(
      { waiting_hours: waiting, recovery_rate: recovery, dispute_cycle_days: cycle },
      auth.companyId,
      portParam ? portParam.trim() : null,
    );

    return NextResponse.json(report);
  } catch (e) {
    return apiError(e, "intel/benchmark/GET");
  }
}
