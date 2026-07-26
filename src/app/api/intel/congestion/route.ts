import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import {
  buildCongestionCells,
  summarizePorts,
  MIN_VOYAGES,
  MIN_COMPANIES,
  type CongestionSample,
} from "@/lib/intel/congestion";

// How much history the nowcast reads. Two years is enough to show a seasonal
// shape without publishing an archive nobody asked for.
const MONTHS_OF_HISTORY = 24;

/**
 * The public congestion nowcast.
 *
 * This route IS the privacy boundary. `port_congestion_stats` is a cross-tenant
 * materialized view carrying company ids and has no grants to anon or
 * authenticated, so it can only be read here with the service-role client — and
 * the response is aggregates that cleared both k-anonymity floors, never a
 * claim id, a company id, or a per-voyage figure.
 *
 * Deliberately readable without a session: the index is meant to be a public
 * good (and, candidly, an acquisition surface). Nothing it returns is
 * attributable to a tenant.
 */
export async function GET() {
  try {
    const service = createServiceRoleClient();

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - MONTHS_OF_HISTORY);

    const { data, error } = await service
      .from("port_congestion_stats")
      .select("port_key, port_label, company_id, year, month, waiting_hours, working_hours")
      .gte("nor_at", cutoff.toISOString());

    if (error) throw error;

    const samples: CongestionSample[] = (data ?? []).map((r) => ({
      portKey: r.port_key,
      portLabel: r.port_label,
      companyId: r.company_id,
      year: r.year,
      month: r.month,
      waitingHours: Number(r.waiting_hours),
      workingHours: r.working_hours === null ? null : Number(r.working_hours),
    }));

    const ports = summarizePorts(buildCongestionCells(samples));

    return NextResponse.json({
      ports,
      // Stated openly: a reader should be able to see why a port is blank
      // without guessing whether we simply have no data.
      methodology: {
        measure: "Hours from Notice of Readiness to all fast, per voyage.",
        source:
          "Confirmed statement-of-facts events from participating LayGrounded tenants.",
        minVoyagesPerCell: MIN_VOYAGES,
        minCompaniesPerCell: MIN_COMPANIES,
        note:
          "Cells below either threshold are suppressed entirely. Figures are medians " +
          "across companies; no individual voyage, vessel or company is identifiable.",
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return apiError(e, "intel/congestion/GET");
  }
}

// Refresh trigger, same contract as the other sweeps: an external scheduler
// holding CRON_SECRET, or any authenticated user. The refresh itself is
// SECURITY DEFINER and granted to service_role only.
export async function POST(req: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const isCron = Boolean(cronSecret) && req.headers.get("x-cron-secret") === cronSecret;
    if (!isCron) {
      await requireAuth();
    }

    const service = createServiceRoleClient();
    const { error } = await service.rpc("refresh_port_congestion_stats");
    if (error) throw new Error(`REFRESH_FAILED: ${error.message}`);

    return NextResponse.json({ refreshed: true });
  } catch (e) {
    return apiError(e, "intel/congestion/POST");
  }
}
