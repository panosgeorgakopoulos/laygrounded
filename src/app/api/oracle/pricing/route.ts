import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import {
  computeRiskExposure,
  MIN_SAMPLE_VOYAGES,
  OracleVoyageStat,
} from "@/lib/oracle/pricing";

const PricingRequestSchema = z.object({
  port: z.string().min(2),
  cargo: z.string().optional(),
  month: z.number().int().min(1).max(12),
  laytimeAllowedHours: z.number().positive(),
  demurrageRatePerDay: z.number().positive(),
  currency: z.string().length(3).default("USD"),
});

interface StatRow {
  cargo_key: string;
  month: number;
  weather_delay_hours: number;
  used_hours: number;
  allowed_hours: number;
  excess_hours: number;
  verified: boolean;
}

// Pre-fixture pricing oracle: a broker's proposed terms replayed against the
// verified voyage history at that port/month. oracle_voyage_stats is a
// cross-tenant matview with no end-user grants, so this route is the privacy
// boundary — service-role read, aggregate-only response, no claim/company ids.
export async function POST(req: NextRequest) {
  try {
    await requireAuth();

    const parsed = PricingRequestSchema.safeParse(await req.json().catch(() => ({})));
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
    const { data, error } = await service
      .from("oracle_voyage_stats")
      .select("cargo_key, month, weather_delay_hours, used_hours, allowed_hours, excess_hours, verified")
      .eq("port_key", portKey)
      .eq("month", input.month);
    if (error) throw new Error(`ORACLE_READ_FAILED: ${error.message}`);
    const rows = (data ?? []) as StatRow[];

    // Cargo narrowing is best-effort: if it starves the sample, price on the
    // whole port/month instead of refusing, and say so.
    let cargoFallback = false;
    let usedCargoFilter: string | null = null;
    let selected = rows;
    if (cargoKey) {
      const cargoRows = rows.filter((r) => r.cargo_key === cargoKey);
      if (cargoRows.length >= MIN_SAMPLE_VOYAGES) {
        selected = cargoRows;
        usedCargoFilter = cargoKey;
      } else {
        cargoFallback = true;
      }
    }

    // Prefer voyages whose evidence was never contradicted; fall back to the
    // full sample only when the verified subset is too thin to price on.
    let verifiedOnly = false;
    const verifiedRows = selected.filter((r) => r.verified);
    if (verifiedRows.length >= MIN_SAMPLE_VOYAGES) {
      selected = verifiedRows;
      verifiedOnly = true;
    }

    const stats: OracleVoyageStat[] = selected.map((r) => ({
      month: r.month,
      weatherDelayHours: r.weather_delay_hours,
      usedHours: r.used_hours,
      allowedHours: r.allowed_hours,
      excessHours: r.excess_hours,
      verified: r.verified,
    }));

    const exposure = computeRiskExposure(stats, {
      laytimeAllowedHours: input.laytimeAllowedHours,
      demurrageRatePerDay: input.demurrageRatePerDay,
    });

    return NextResponse.json({
      exposure,
      currency: input.currency,
      basis: {
        port: input.port.trim(),
        month: input.month,
        cargo: usedCargoFilter,
        sampleSize: exposure.sampleSize,
        verifiedOnly,
        cargoFallback,
      },
    });
  } catch (e) {
    return apiError(e, "oracle/pricing/POST", { INSUFFICIENT_DATA: 422 });
  }
}
