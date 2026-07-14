import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import {
  calculateOptimalArrivalSpeed,
  type VesselTelemetry,
} from "@/lib/optimization/ecospeed";
import type { ConsumptionCurve } from "@/lib/compliance/carbon";
import { DEFAULT_CP_TERMS, type CpTerms } from "@/lib/laytime/types";

const TelemetrySchema = z.object({
  currentSpeedKnots: z.number().positive().max(40),
  distanceToPortNm: z.number().positive().max(20_000),
  // Omit to fall back to the port resilience index (then 0, stated).
  predictedCongestionDelayHours: z.number().min(0).max(2_000).optional(),
});

const EcospeedSchema = z.object({
  vesselImo: z.string().min(3).max(20),
  // Inline telemetry is persisted to vessel_telemetry_streams; omit it to
  // optimize on the latest stored reading instead.
  telemetry: TelemetrySchema.optional(),
  destinationPort: z.string().min(2).max(120).optional(),
  month: z.number().int().min(1).max(12).optional(),
  claimId: z.string().uuid().optional(),
  demurrageRatePerDay: z.number().positive().optional(),
  laytimeBufferHours: z.number().min(0).optional(),
  cancellingAt: z.string().datetime({ offset: true }).optional(),
  fixtureLossUsd: z.number().min(0).optional(),
  fuelPriceUsdPerTonne: z.number().positive().optional(),
  euaPriceEur: z.number().positive().optional(),
  eurUsd: z.number().positive().optional(),
  minSpeedKnots: z.number().positive().optional(),
  maxSpeedKnots: z.number().positive().optional(),
  speedStepKnots: z.number().positive().max(5).optional(),
});

// Same k-anonymity floor the prefixture intel route applies to the
// congestion medians of the cross-tenant resilience matview.
const MIN_CONGESTION_VOYAGES = 5;

interface TelemetryRow {
  current_speed_knots: number;
  distance_to_port_nm: number;
  predicted_congestion_delay_hours: number;
  destination_port: string | null;
  recorded_at: string;
}

// Dynamic eco-speed optimizer: prices every arrival speed for the vessel
// (fuel + ETS vs waiting + demurrage + laycan) and recommends the cheapest.
// The consumption curve comes from the tenant's vessel_analytics_profiles;
// congestion falls back to the cross-tenant port resilience index
// (aggregates only, floor-gated, via service role).
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();

    const parsed = EcospeedSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const input = parsed.data;

    const supabase = await createClient();
    const { data: profile } = await supabase
      .from("vessel_analytics_profiles")
      .select("vessel_imo, consumption_curve")
      .eq("company_id", auth.companyId)
      .eq("vessel_imo", input.vesselImo)
      .maybeSingle();
    if (!profile) throw new Error("PROFILE_NOT_FOUND");

    const curve = profile.consumption_curve as Partial<ConsumptionCurve> | null;
    if (
      !curve ||
      typeof curve.at_berth_aux_tonnes_per_day !== "number" ||
      !Array.isArray(curve.sea_curve) ||
      curve.sea_curve.length === 0 ||
      curve.sea_curve.some(
        (p) => typeof p?.speed_knots !== "number" || typeof p?.tonnes_per_day !== "number"
      )
    ) {
      throw new Error("NO_CONSUMPTION_CURVE");
    }

    // Telemetry: inline (persisted as a new stream reading) or latest stored.
    let telemetrySource: "inline" | "stored";
    let speedKnots: number;
    let distanceNm: number;
    let congestionHours: number | null;
    let destinationPort = input.destinationPort ?? null;
    if (input.telemetry) {
      telemetrySource = "inline";
      speedKnots = input.telemetry.currentSpeedKnots;
      distanceNm = input.telemetry.distanceToPortNm;
      congestionHours = input.telemetry.predictedCongestionDelayHours ?? null;
    } else {
      const { data: row } = await supabase
        .from("vessel_telemetry_streams")
        .select(
          "current_speed_knots, distance_to_port_nm, predicted_congestion_delay_hours, destination_port, recorded_at"
        )
        .eq("company_id", auth.companyId)
        .eq("vessel_imo", input.vesselImo)
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle<TelemetryRow>();
      if (!row) throw new Error("TELEMETRY_NOT_FOUND");
      telemetrySource = "stored";
      speedKnots = row.current_speed_knots;
      distanceNm = row.distance_to_port_nm;
      congestionHours = row.predicted_congestion_delay_hours;
      destinationPort = destinationPort ?? row.destination_port;
    }

    // Congestion fallback: the port resilience index (cross-tenant matview,
    // service-role read, aggregate only, suppressed below the k-floor).
    let congestionSource: "telemetry" | "port_index" | "none" = "telemetry";
    if (congestionHours == null) {
      congestionSource = "none";
      congestionHours = 0;
      if (destinationPort && input.month) {
        const service = createServiceRoleClient();
        const { data: idx } = await service
          .from("port_honesty_and_resilience_index")
          .select("median_congestion_delay_hours, voyages_observed")
          .eq("port_key", destinationPort.trim().toLowerCase())
          .eq("month", input.month)
          .maybeSingle();
        if (
          idx &&
          idx.voyages_observed >= MIN_CONGESTION_VOYAGES &&
          idx.median_congestion_delay_hours != null
        ) {
          congestionHours = idx.median_congestion_delay_hours;
          congestionSource = "port_index";
        }
      }
    }

    const telemetry: VesselTelemetry = {
      currentSpeedKnots: speedKnots,
      distanceToPortNm: distanceNm,
      predictedCongestionDelayHours: congestionHours ?? 0,
    };

    // Demurrage rate: explicit → claim's CP terms → documented default.
    let demurrageRatePerDay = input.demurrageRatePerDay ?? null;
    if (demurrageRatePerDay == null && input.claimId) {
      const { data: claim } = await supabase
        .from("claims")
        .select("id, company_id, cp_terms")
        .eq("id", input.claimId)
        .maybeSingle();
      if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");
      demurrageRatePerDay = (claim.cp_terms as CpTerms | null)?.demurrage_rate ?? null;
    }
    demurrageRatePerDay = demurrageRatePerDay ?? DEFAULT_CP_TERMS.demurrage_rate;

    const recommendation = calculateOptimalArrivalSpeed({
      telemetry,
      consumptionCurve: curve as ConsumptionCurve,
      demurrageRatePerDay,
      nowISO: new Date().toISOString(),
      laytimeBufferHours: input.laytimeBufferHours,
      cancellingAt: input.cancellingAt,
      fixtureLossUsd: input.fixtureLossUsd,
      fuelPriceUsdPerTonne: input.fuelPriceUsdPerTonne,
      euaPriceEur: input.euaPriceEur,
      eurUsd: input.eurUsd,
      minSpeedKnots: input.minSpeedKnots,
      maxSpeedKnots: input.maxSpeedKnots,
      speedStepKnots: input.speedStepKnots,
    });

    // Audit trail: inline readings become part of the vessel's stream.
    if (input.telemetry) {
      const { error: streamErr } = await supabase.from("vessel_telemetry_streams").insert({
        company_id: auth.companyId,
        vessel_imo: input.vesselImo,
        claim_id: input.claimId ?? null,
        destination_port: destinationPort,
        current_speed_knots: speedKnots,
        distance_to_port_nm: distanceNm,
        predicted_congestion_delay_hours: congestionHours,
        source: "api",
      });
      if (streamErr) throw new Error(`PERSIST_FAILED: ${streamErr.message}`);
    }

    return NextResponse.json({
      recommendation,
      telemetrySource,
      congestionSource,
      demurrageRatePerDay,
    });
  } catch (e) {
    return apiError(e, "v1/optimization/ecospeed/POST", {
      PROFILE_NOT_FOUND: 404,
      TELEMETRY_NOT_FOUND: 404,
      NO_CONSUMPTION_CURVE: 422,
      INVALID_TELEMETRY: 400,
      INVALID_SPEED_RANGE: 400,
      INVALID_CONSUMPTION_CURVE: 422,
    });
  }
}
