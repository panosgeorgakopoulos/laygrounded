// The market half of the dual benchmark.
//
// `port_congestion_stats` records waiting and working HOURS per call but no
// cargo tonnage, so a market MT/day rate cannot be read from it. The rate is
// therefore assembled here from the claims themselves, using the same tested
// quantity parser the contractual side uses — one definition of "how many
// tonnes", so the two benchmarks are commensurable.
//
// ── THE FLOORS ARE IMPORTED, NOT RESTATED ──────────────────────────────────
//
// This reads OTHER COMPANIES' claims to build an aggregate, so it carries the
// congestion index's own k-anonymity floors by importing them. Restating "5"
// and "3" here would let the two drift, and a lowered floor is a
// deanonymisation, not a tuning knob. Your own company is excluded from the
// baseline for the same reason `benchmark.ts` excludes it: on a thin lane you
// would otherwise be measured largely against yourself.
//
// Service-role only — RLS cannot scope a cross-tenant aggregate, so the
// enforcement is the floors plus returning aggregates only, never rows.

import type { SupabaseClient } from "@supabase/supabase-js";
import { MIN_COMPANIES, MIN_VOYAGES } from "@/lib/intel/congestion";
import { computeAchievedRate, type RateBasis } from "@/lib/efficiency/cargo-rate";
import type { SofEventInput } from "@/lib/laytime/types";

export interface MarketRate {
  medianTonnesPerDay: number;
  sampleSize: number;
  companies: number;
  portLabel: string;
  cargoKey: string | null;
}

export interface MarketRateResult {
  rate: MarketRate | null;
  /** Why there is no rate. Null when there is one. */
  unavailableReason: string | null;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median achieved rate on this lane, across other companies.
 *
 * Returns `unavailableReason` rather than a number whenever the floors are not
 * met — the caller then reports INSUFFICIENT_DATA for the market comparison and
 * proceeds with the contractual one, which needs no pooled data at all.
 */
export async function marketRateForLane(
  db: SupabaseClient,
  opts: {
    port: string;
    cargo?: string | null;
    excludeCompanyId: string;
    basis?: RateBasis;
  }
): Promise<MarketRateResult> {
  const portKey = opts.port.trim().toLowerCase();
  const cargoKey = opts.cargo?.trim().toLowerCase() ?? null;

  const { data, error } = await db
    .from("claims")
    .select("id, company_id, port, cargo, sof_events(occurred_at, event_type, status)")
    .neq("company_id", opts.excludeCompanyId)
    .limit(500);

  if (error) {
    return { rate: null, unavailableReason: `Market data could not be read: ${error.message}` };
  }

  type Row = {
    id: string;
    company_id: string;
    port: string | null;
    cargo: string | null;
    sof_events: Array<{ occurred_at: string; event_type: string; status: string }> | null;
  };

  const samples: Array<{ companyId: string; rate: number }> = [];

  for (const row of (data ?? []) as unknown as Row[]) {
    if ((row.port ?? "").trim().toLowerCase() !== portKey) continue;
    // Cargo narrowing is optional: a lane with too few calls for one cargo
    // still yields a usable port-level figure, which is better than nothing
    // provided the caller is told which it got.
    if (cargoKey && !(row.cargo ?? "").toLowerCase().includes(cargoKey)) continue;

    // Only CONFIRMED events, for the same reason the congestion matview uses
    // them: a suggested event is an unreviewed model output, and statistics
    // built on those put unverified numbers into the market's mouth.
    const events = (row.sof_events ?? [])
      .filter((e) => e.status === "accepted" || e.status === "edited")
      .map((e) => ({ id: "", occurred_at: e.occurred_at, event_type: e.event_type })) as SofEventInput[];

    const achieved = computeAchievedRate(row.cargo, events, opts.basis ?? "net");
    // A call whose tonnage cannot be read contributes nothing rather than a
    // guess — the aggregate is only as honest as its weakest sample.
    if (!achieved || !achieved.quantity.confident) continue;

    samples.push({ companyId: row.company_id, rate: achieved.tonnesPerDay });
  }

  const companies = new Set(samples.map((s) => s.companyId));

  if (samples.length < MIN_VOYAGES) {
    return {
      rate: null,
      unavailableReason: `INSUFFICIENT_DATA: ${samples.length} comparable call${samples.length === 1 ? "" : "s"} on this lane from other companies; the floor is ${MIN_VOYAGES}.`,
    };
  }
  if (companies.size < MIN_COMPANIES) {
    return {
      rate: null,
      unavailableReason: `INSUFFICIENT_DATA: comparable calls come from ${companies.size} compan${companies.size === 1 ? "y" : "ies"}; the k-anonymity floor is ${MIN_COMPANIES}.`,
    };
  }

  const sorted = samples.map((s) => s.rate).sort((a, b) => a - b);

  return {
    rate: {
      medianTonnesPerDay: Math.round(median(sorted) * 10) / 10,
      sampleSize: samples.length,
      companies: companies.size,
      portLabel: opts.port,
      cargoKey,
    },
    unavailableReason: null,
  };
}
