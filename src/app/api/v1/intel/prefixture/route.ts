import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { MIN_DECISIVE_CHECKS } from "@/lib/intel/honesty-index";
import { MIN_SAMPLE_VOYAGES, type OracleVoyageStat } from "@/lib/oracle/pricing";
import {
  getPreFixtureIntelligence,
  type PortResilienceSnapshot,
} from "@/lib/analytics/predictive";
import { DAYS_BASES, type DaysBasis } from "@/lib/laytime/types";

const PrefixtureSchema = z.object({
  port: z.string().min(2),
  month: z.number().int().min(1).max(12),
  cargo: z.string().optional(),
  laytimeAllowedHours: z.number().positive(),
  demurrageRatePerDay: z.number().positive(),
  daysBasis: z.enum(DAYS_BASES as [DaysBasis, ...DaysBasis[]]).default("SHINC"),
  turnTimeHours: z.number().min(0).default(0),
  perspective: z.enum(["charterer", "owner"]).default("charterer"),
  currency: z.string().length(3).default("USD"),
});

// Suppress congestion medians built on fewer voyages than this — the same
// k-anonymity posture the honesty index applies to contradiction rates.
const MIN_CONGESTION_VOYAGES = 5;

// Pre-fixture intelligence: proposed clauses replayed against the observed
// history at that port/month, plus the resilience shock index. Both source
// matviews are cross-tenant with no end-user grants, so this route is the
// privacy boundary — service-role reads, aggregate-only response, k-anonymity
// floors, never a claim or company id.
export async function POST(req: NextRequest) {
  try {
    await requireAuth();

    const parsed = PrefixtureSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const input = parsed.data;
    const portKey = input.port.trim().toLowerCase();
    const cargoKey = input.cargo?.trim().toLowerCase() || null;

    const service = createServiceRoleClient();
    const [{ data: statRows, error: statErr }, { data: resilienceRow }] = await Promise.all([
      service
        .from("oracle_voyage_stats")
        .select("cargo_key, month, weather_delay_hours, used_hours, allowed_hours, excess_hours, verified")
        .eq("port_key", portKey)
        .eq("month", input.month),
      service
        .from("port_honesty_and_resilience_index")
        .select(
          "weather_decisive_checks, weather_contradicted_checks, weather_contradiction_rate, voyages_observed, median_congestion_delay_hours, p90_congestion_delay_hours"
        )
        .eq("port_key", portKey)
        .eq("month", input.month)
        .maybeSingle(),
    ]);
    if (statErr) throw new Error(`ORACLE_READ_FAILED: ${statErr.message}`);

    // Cargo narrowing and verified-preference, same policy as /api/oracle/pricing.
    let selected = (statRows ?? []) as Array<{
      cargo_key: string;
      month: number;
      weather_delay_hours: number;
      used_hours: number;
      allowed_hours: number;
      excess_hours: number;
      verified: boolean;
    }>;
    let cargoFallback = false;
    if (cargoKey) {
      const cargoRows = selected.filter((r) => r.cargo_key === cargoKey);
      if (cargoRows.length >= MIN_SAMPLE_VOYAGES) selected = cargoRows;
      else cargoFallback = true;
    }
    let verifiedOnly = false;
    const verifiedRows = selected.filter((r) => r.verified);
    if (verifiedRows.length >= MIN_SAMPLE_VOYAGES) {
      selected = verifiedRows;
      verifiedOnly = true;
    }

    const samples: OracleVoyageStat[] = selected.map((r) => ({
      month: r.month,
      weatherDelayHours: r.weather_delay_hours,
      usedHours: r.used_hours,
      allowedHours: r.allowed_hours,
      excessHours: r.excess_hours,
      verified: r.verified,
    }));

    const resilience: PortResilienceSnapshot | null = resilienceRow
      ? {
          portKey,
          month: input.month,
          weatherContradictionRate:
            resilienceRow.weather_decisive_checks >= MIN_DECISIVE_CHECKS
              ? resilienceRow.weather_contradiction_rate
              : null,
          weatherDecisiveChecks: resilienceRow.weather_decisive_checks,
          medianCongestionDelayHours:
            resilienceRow.voyages_observed >= MIN_CONGESTION_VOYAGES
              ? resilienceRow.median_congestion_delay_hours
              : null,
          p90CongestionDelayHours:
            resilienceRow.voyages_observed >= MIN_CONGESTION_VOYAGES
              ? resilienceRow.p90_congestion_delay_hours
              : null,
          voyagesObserved: resilienceRow.voyages_observed,
        }
      : null;

    const intelligence = getPreFixtureIntelligence(
      samples,
      {
        label: `${input.daysBasis}, ${input.laytimeAllowedHours}h`,
        daysBasis: input.daysBasis,
        laytimeAllowedHours: input.laytimeAllowedHours,
        demurrageRatePerDay: input.demurrageRatePerDay,
        turnTimeHours: input.turnTimeHours,
      },
      { resilience, perspective: input.perspective }
    );

    return NextResponse.json({
      intelligence,
      currency: input.currency,
      basis: {
        port: input.port.trim(),
        month: input.month,
        cargo: cargoFallback ? null : cargoKey,
        cargoFallback,
        verifiedOnly,
        sampleSize: intelligence.sampleSize,
      },
    });
  } catch (e) {
    return apiError(e, "v1/intel/prefixture/POST", { INSUFFICIENT_DATA: 422 });
  }
}
