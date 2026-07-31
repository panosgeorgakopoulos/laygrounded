// Turning a pile of trial outcomes into figures someone can act on — with the
// uncertainty of the estimate itself attached.
//
// A P90 from a Monte Carlo is an ESTIMATE of a percentile, not the percentile.
// Reporting "P90 = $84,000" without saying how tightly that is pinned invites a
// reader to treat simulation noise as signal, and to see a number move between
// two runs of the same fixture and conclude the model is unstable. Every
// statistic here therefore travels with its own error bar.
//
// Pure.

/** Linear-interpolated percentile of an ascending-sorted array. */
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const idx = (sortedAscending.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscending[lo];
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * (idx - lo);
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n−1). */
export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
}

export interface Estimate {
  value: number;
  /** Monte Carlo standard error of this estimate. */
  standardError: number;
  /** 95% interval for the estimate — how much is left to gain from more trials. */
  ci95: [number, number];
}

const Z95 = 1.959963984540054;

export function estimateMean(xs: number[]): Estimate {
  const m = mean(xs);
  const se = xs.length === 0 ? 0 : stdDev(xs) / Math.sqrt(xs.length);
  return { value: m, standardError: se, ci95: [m - Z95 * se, m + Z95 * se] };
}

/** Estimate of a probability, with the Wald standard error for a proportion. */
export function estimateProbability(successes: number, n: number): Estimate {
  if (n === 0) return { value: 0, standardError: 0, ci95: [0, 0] };
  const p = successes / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  return {
    value: p,
    standardError: se,
    ci95: [Math.max(0, p - Z95 * se), Math.min(1, p + Z95 * se)],
  };
}

/**
 * Estimate of a percentile, with a DISTRIBUTION-FREE interval.
 *
 * The interval comes from order statistics: the rank of the true p-quantile in
 * a sample of n is Binomial(n, p), so the ranks at ±1.96 standard deviations
 * bracket it without assuming the outcome distribution has any particular
 * shape. That matters here — demurrage outcomes are heavily zero-inflated (most
 * trials finish inside laytime) and violently right-skewed, so a normal-theory
 * interval around a percentile would be simply wrong.
 */
export function estimatePercentile(sortedAscending: number[], p: number): Estimate {
  const n = sortedAscending.length;
  const value = percentile(sortedAscending, p);
  if (n < 2) return { value, standardError: 0, ci95: [value, value] };

  const sd = Math.sqrt(n * p * (1 - p));
  const loRank = Math.max(0, Math.floor(n * p - Z95 * sd));
  const hiRank = Math.min(n - 1, Math.ceil(n * p + Z95 * sd));

  const lo = sortedAscending[loRank];
  const hi = sortedAscending[hiRank];
  // Back out an SE from the interval width so every Estimate reads alike.
  return { value, standardError: (hi - lo) / (2 * Z95), ci95: [lo, hi] };
}

/**
 * A percentile of a per-trial TIME series, in hours.
 *
 * Kept out of `RiskDistribution` on purpose — see the note on
 * `SimulationResult.outcomes`. `RiskDistribution` is a sealed document that
 * `verifyReplay()` compares field-for-field against a fresh recomputation, so
 * new keys there retroactively break every stored assessment. This is computed
 * by the caller from `outcomes` and stored in its own column.
 *
 * Exists because the distribution reports time only as MEANS. A hinterland
 * partner re-planning trucks needs the tail: a mean wait of 10h routinely hides
 * a P90 of 40h, and the whole point of the notification is the bad case.
 */
export function percentileOfHours(values: number[], p: number): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return percentile([...finite].sort((a, b) => a - b), p);
}

export interface TrialOutcome {
  /** Owner's perspective: demurrage earned minus despatch paid. */
  net: number;
  demurrageAmount: number;
  despatchAmount: number;
  usedHours: number;
  waitingHours: number;
  stoppageHours: number;
  /** Which pool the weather trajectory came from. */
  trajectoryKind: "ensemble" | "climatology";
}

export interface RiskDistribution {
  trials: number;
  /** P(this voyage ends on demurrage at all) — the headline number. */
  demurrageProbability: Estimate;
  /** Mean net exposure across ALL trials, including the ones costing nothing. */
  expectedExposure: Estimate;
  /**
   * Mean net exposure across only the trials that went on demurrage.
   *
   * Reported separately because the two answer different questions: "what
   * should I provision" versus "what does it cost me when it happens". A 5%
   * chance of $200k and a certainty of $10k have the same expected value and
   * call for completely different decisions.
   */
  conditionalExposure: Estimate;
  percentiles: {
    p10: Estimate;
    p50: Estimate;
    p90: Estimate;
    p95: Estimate;
  };
  meanUsedHours: number;
  meanWaitingHours: number;
  meanStoppageHours: number;
  worstCase: number;
  bestCase: number;
  /** How many trials came from each weather pool — the horizon blend, realised. */
  trajectoryMix: { ensemble: number; climatology: number };
  /** Histogram of net outcomes for charting. */
  histogram: Array<{ from: number; to: number; count: number }>;
}

const HISTOGRAM_BINS = 24;

export function summarize(outcomes: TrialOutcome[]): RiskDistribution {
  const n = outcomes.length;
  const nets = outcomes.map((o) => o.net);
  const sortedNets = [...nets].sort((a, b) => a - b);
  const onDemurrage = outcomes.filter((o) => o.demurrageAmount > 0);

  return {
    trials: n,
    demurrageProbability: estimateProbability(onDemurrage.length, n),
    expectedExposure: estimateMean(nets),
    conditionalExposure: estimateMean(onDemurrage.map((o) => o.net)),
    percentiles: {
      p10: estimatePercentile(sortedNets, 0.1),
      p50: estimatePercentile(sortedNets, 0.5),
      p90: estimatePercentile(sortedNets, 0.9),
      p95: estimatePercentile(sortedNets, 0.95),
    },
    meanUsedHours: mean(outcomes.map((o) => o.usedHours)),
    meanWaitingHours: mean(outcomes.map((o) => o.waitingHours)),
    meanStoppageHours: mean(outcomes.map((o) => o.stoppageHours)),
    worstCase: sortedNets[n - 1] ?? 0,
    bestCase: sortedNets[0] ?? 0,
    trajectoryMix: {
      ensemble: outcomes.filter((o) => o.trajectoryKind === "ensemble").length,
      climatology: outcomes.filter((o) => o.trajectoryKind === "climatology").length,
    },
    histogram: buildHistogram(sortedNets),
  };
}

function buildHistogram(sortedNets: number[]): Array<{ from: number; to: number; count: number }> {
  if (sortedNets.length === 0) return [];
  const lo = sortedNets[0];
  const hi = sortedNets[sortedNets.length - 1];
  if (hi === lo) return [{ from: lo, to: hi, count: sortedNets.length }];

  const width = (hi - lo) / HISTOGRAM_BINS;
  const bins = Array.from({ length: HISTOGRAM_BINS }, (_, i) => ({
    from: lo + i * width,
    to: lo + (i + 1) * width,
    count: 0,
  }));
  for (const v of sortedNets) {
    const idx = Math.min(Math.floor((v - lo) / width), HISTOGRAM_BINS - 1);
    bins[idx].count++;
  }
  return bins;
}
