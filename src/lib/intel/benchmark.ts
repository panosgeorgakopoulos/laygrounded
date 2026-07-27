// Lane benchmarking — your book against the market's, on the same measures.
//
// "Is 34 hours of waiting at Santos good?" is unanswerable from your own data
// alone, and it is the question that decides whether a desk pushes a claim or
// pays it. The cross-tenant aggregates can answer it; this module does the
// comparison and, more importantly, refuses to when the comparison would be
// meaningless or deanonymising.
//
// Two rules run through everything below:
//
//   1. YOUR OWN COMPANY IS NEVER PART OF THE MARKET BASELINE. On a thin lane you
//      would otherwise be benchmarked largely against yourself, which reads as
//      "perfectly average" no matter how good or bad you are. Exclusion is
//      enforced here rather than trusted to the caller's query.
//   2. The market side carries the same k-anonymity floors as the public index.
//      A benchmark against two other companies lets you difference out their
//      individual performance.
//
// Pure — the caller supplies rows read with the service-role client.

import { percentile } from "@/lib/oracle/pricing";
import { MIN_COMPANIES } from "@/lib/intel/congestion";

/** Distinct OTHER companies required before a market figure may be shown. */
export const MIN_MARKET_COMPANIES = MIN_COMPANIES;

/** Observations required on your own side before your figure means anything. */
export const MIN_OWN_OBSERVATIONS = 3;

export type BenchmarkVerdict = "ahead" | "behind" | "inline" | "insufficient_data";

export interface BenchmarkMetric {
  key: string;
  label: string;
  unit: "hours" | "percent" | "days";
  /** True when a lower number is the better outcome (waiting time, cycle time). */
  betterIsLower: boolean;
  yours: number | null;
  market: number | null;
  /** Signed so positive ALWAYS means "you are better", whichever way the metric runs. */
  advantagePct: number | null;
  verdict: BenchmarkVerdict;
  ownObservations: number;
  marketObservations: number;
  marketCompanies: number;
  /** Why a metric is unavailable, when it is. Never null on insufficient_data. */
  note: string | null;
}

/** One observation of a metric, attributed to the company that produced it. */
export interface Observation {
  companyId: string;
  value: number;
}

export interface MetricSpec {
  key: string;
  label: string;
  unit: BenchmarkMetric["unit"];
  betterIsLower: boolean;
}

// Below this relative gap, calling a desk "ahead" or "behind" is overreading
// sampling noise.
const INLINE_THRESHOLD_PCT = 5;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compares one metric. `observations` may contain your rows and everyone
 * else's; the split is done here, by company id.
 */
export function benchmarkMetric(
  spec: MetricSpec,
  observations: Observation[],
  yourCompanyId: string,
): BenchmarkMetric {
  const own = observations.filter((o) => o.companyId === yourCompanyId);
  // Rule 1: the market is everyone who is not you.
  const market = observations.filter((o) => o.companyId !== yourCompanyId);
  const marketCompanies = new Set(market.map((o) => o.companyId));

  const base: Omit<BenchmarkMetric, "yours" | "market" | "advantagePct" | "verdict" | "note"> = {
    key: spec.key,
    label: spec.label,
    unit: spec.unit,
    betterIsLower: spec.betterIsLower,
    ownObservations: own.length,
    marketObservations: market.length,
    marketCompanies: marketCompanies.size,
  };

  const yourMedian =
    own.length >= MIN_OWN_OBSERVATIONS
      ? round1(percentile(own.map((o) => o.value).sort((a, b) => a - b), 0.5))
      : null;

  if (own.length < MIN_OWN_OBSERVATIONS) {
    return {
      ...base,
      yours: null,
      market: null,
      advantagePct: null,
      verdict: "insufficient_data",
      note: `Needs at least ${MIN_OWN_OBSERVATIONS} of your own voyages to report a figure.`,
    };
  }

  // Rule 2: the market figure is withheld unless enough OTHER companies stand
  // behind it. Your own number is still shown — it is yours.
  if (marketCompanies.size < MIN_MARKET_COMPANIES) {
    return {
      ...base,
      yours: yourMedian,
      market: null,
      advantagePct: null,
      verdict: "insufficient_data",
      note:
        `Not enough independent companies on this lane to publish a market figure ` +
        `(needs ${MIN_MARKET_COMPANIES}).`,
    };
  }

  const marketMedian = round1(
    percentile(market.map((o) => o.value).sort((a, b) => a - b), 0.5),
  );

  let advantagePct: number | null = null;
  let verdict: BenchmarkVerdict = "inline";

  if (marketMedian !== 0) {
    const rawPct = ((yourMedian! - marketMedian) / Math.abs(marketMedian)) * 100;
    // Flip the sign for lower-is-better metrics so a positive advantage always
    // reads the same way in the UI, whichever direction the metric runs.
    const signed = spec.betterIsLower ? -rawPct : rawPct;
    advantagePct = Math.round(signed);
    if (signed > INLINE_THRESHOLD_PCT) verdict = "ahead";
    else if (signed < -INLINE_THRESHOLD_PCT) verdict = "behind";
  }

  return {
    ...base,
    yours: yourMedian,
    market: marketMedian,
    advantagePct,
    verdict,
    note: null,
  };
}

export const BENCHMARK_SPECS: Record<string, MetricSpec> = {
  waiting_hours: {
    key: "waiting_hours",
    label: "Waiting time, NOR to berth",
    unit: "hours",
    betterIsLower: true,
  },
  recovery_rate: {
    key: "recovery_rate",
    label: "Demurrage recovery rate",
    unit: "percent",
    betterIsLower: false,
  },
  dispute_cycle_days: {
    key: "dispute_cycle_days",
    label: "Days from claim to settlement",
    unit: "days",
    betterIsLower: true,
  },
};

export interface BenchmarkReport {
  metrics: BenchmarkMetric[];
  /** Ports the comparison was scoped to, or null for the whole book. */
  portFilter: string | null;
  generatedAt: string;
}

export function buildBenchmarkReport(
  observationsByMetric: Record<string, Observation[]>,
  yourCompanyId: string,
  portFilter: string | null = null,
  now: Date = new Date(),
): BenchmarkReport {
  const metrics = Object.entries(BENCHMARK_SPECS).map(([key, spec]) =>
    benchmarkMetric(spec, observationsByMetric[key] ?? [], yourCompanyId),
  );
  return { metrics, portFilter, generatedAt: now.toISOString() };
}
