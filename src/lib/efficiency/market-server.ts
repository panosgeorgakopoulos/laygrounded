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

/** Which bucket the median actually came from. */
export type BenchmarkScope = "terminal" | "port";

export interface MarketRate {
  medianTonnesPerDay: number;
  sampleSize: number;
  companies: number;
  portLabel: string;
  /** Set only when the median is terminal-level. */
  terminalLabel: string | null;
  scope: BenchmarkScope;
  cargoKey: string | null;
}

export interface MarketRateResult {
  rate: MarketRate | null;
  /** Why there is no rate. Null when there is one. */
  unavailableReason: string | null;
  /**
   * Set when a terminal was asked for but the median came from the whole port.
   *
   * A specialised berth measured against a port-wide median is a different
   * claim from a like-for-like comparison, so the fallback is never silent.
   */
  fellBackToPortReason: string | null;
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
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

interface Row {
  id: string;
  company_id: string;
  port: string | null;
  terminal_name: string | null;
  cargo: string | null;
  sof_events: Array<{ occurred_at: string; event_type: string; status: string }> | null;
}

/** Rates for one bucket, with the k-anonymity verdict already applied. */
function bucketRate(
  rows: Row[],
  basis: RateBasis
): { sorted: number[]; companies: Set<string>; suppressed: string | null } {
  const samples: Array<{ companyId: string; rate: number }> = [];

  for (const row of rows) {
    // Only CONFIRMED events, for the same reason the congestion matview uses
    // them: a suggested event is an unreviewed model output, and statistics
    // built on those put unverified numbers into the market's mouth.
    const events = (row.sof_events ?? [])
      .filter((e) => e.status === "accepted" || e.status === "edited")
      .map((e) => ({ id: "", occurred_at: e.occurred_at, event_type: e.event_type })) as SofEventInput[];

    const achieved = computeAchievedRate(row.cargo, events, basis);
    // A call whose tonnage cannot be read contributes nothing rather than a
    // guess — the aggregate is only as honest as its weakest sample.
    if (!achieved || !achieved.quantity.confident) continue;

    samples.push({ companyId: row.company_id, rate: achieved.tonnesPerDay });
  }

  const companies = new Set(samples.map((s) => s.companyId));
  let suppressed: string | null = null;

  if (samples.length < MIN_VOYAGES) {
    suppressed = `${samples.length} comparable call${samples.length === 1 ? "" : "s"} (${MIN_VOYAGES} needed)`;
  } else if (companies.size < MIN_COMPANIES) {
    suppressed = `calls from only ${companies.size} compan${companies.size === 1 ? "y" : "ies"} (${MIN_COMPANIES} needed)`;
  }

  return {
    sorted: samples.map((s) => s.rate).sort((a, b) => a - b),
    companies,
    suppressed,
  };
}

export async function marketRateForLane(
  db: SupabaseClient,
  opts: {
    port: string;
    terminal?: string | null;
    cargo?: string | null;
    excludeCompanyId: string;
    basis?: RateBasis;
  }
): Promise<MarketRateResult> {
  const portKey = norm(opts.port);
  const terminalKey = norm(opts.terminal) || null;
  const cargoKey = opts.cargo?.trim().toLowerCase() ?? null;
  const basis = opts.basis ?? "net";

  const { data, error } = await db
    .from("claims")
    .select("id, company_id, port, terminal_name, cargo, sof_events(occurred_at, event_type, status)")
    .neq("company_id", opts.excludeCompanyId)
    .limit(500);

  if (error) {
    return {
      rate: null,
      unavailableReason: `Market data could not be read: ${error.message}`,
      fellBackToPortReason: null,
    };
  }

  const inPort = ((data ?? []) as unknown as Row[]).filter((row) => {
    if (norm(row.port) !== portKey) return false;
    // Cargo narrowing is optional: a lane with too few calls for one cargo
    // still yields a usable figure, provided the caller is told which it got.
    if (cargoKey && !(row.cargo ?? "").toLowerCase().includes(cargoKey)) return false;
    return true;
  });

  // ── Terminal first, when one was asked for ──────────────────────────────
  // Crane rates vary more within a port than between ports, so a like-for-like
  // terminal comparison is the meaningful one whenever it clears the floors.
  if (terminalKey) {
    const atTerminal = inPort.filter((r) => norm(r.terminal_name) === terminalKey);
    const t = bucketRate(atTerminal, basis);
    if (!t.suppressed) {
      return {
        rate: {
          medianTonnesPerDay: Math.round(median(t.sorted) * 10) / 10,
          sampleSize: t.sorted.length,
          companies: t.companies.size,
          portLabel: opts.port,
          terminalLabel: opts.terminal ?? null,
          scope: "terminal",
          cargoKey,
        },
        unavailableReason: null,
        fellBackToPortReason: null,
      };
    }

    // Fall back to the port, but never silently — a specialised berth measured
    // against a port-wide median is a different claim.
    const p = bucketRate(inPort, basis);
    if (!p.suppressed) {
      return {
        rate: {
          medianTonnesPerDay: Math.round(median(p.sorted) * 10) / 10,
          sampleSize: p.sorted.length,
          companies: p.companies.size,
          portLabel: opts.port,
          terminalLabel: null,
          scope: "port",
          cargoKey,
        },
        unavailableReason: null,
        fellBackToPortReason: `Not enough data for ${opts.terminal} specifically (${t.suppressed}), so the median is for ${opts.port} as a whole. Crane rates vary between terminals, so treat this as indicative.`,
      };
    }

    return {
      rate: null,
      // One sentence naming both buckets, rather than the same clause twice.
      unavailableReason: `Not enough comparable calls from other companies yet — ${t.suppressed} at ${opts.terminal}, and ${p.suppressed} across ${opts.port} as a whole.`,
      fellBackToPortReason: null,
    };
  }

  // ── No terminal recorded: port level only ───────────────────────────────
  const p = bucketRate(inPort, basis);
  if (p.suppressed) {
    return {
      rate: null,
      unavailableReason: `Not enough comparable calls from other companies yet at ${opts.port} — ${p.suppressed}.`,
      fellBackToPortReason: null,
    };
  }

  return {
    rate: {
      medianTonnesPerDay: Math.round(median(p.sorted) * 10) / 10,
      sampleSize: p.sorted.length,
      companies: p.companies.size,
      portLabel: opts.port,
      terminalLabel: null,
      scope: "port",
      cargoKey,
    },
    unavailableReason: null,
    fellBackToPortReason: null,
  };
}
