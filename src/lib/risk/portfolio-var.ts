// Portfolio demurrage risk — the book, not the voyage.
//
// Every operator's real question is about the whole book: what is my demurrage
// exposure across all open fixtures, and how bad is the bad case? The naive
// answer — simulate each voyage and add the percentiles — throws away the one
// thing that makes a bad quarter bad: five vessels in the US Gulf are exposed
// to the SAME hurricane, so their outcomes arrive together.
//
// ── WHY COMMON RANDOM NUMBERS ARE PHYSICALLY CORRECT HERE ──────────────────
//
// Ensemble member k is a single global model run. Member k at Houston and
// member k at New Orleans are the SAME simulated atmosphere, not two unrelated
// draws — and historical year Y at two ports is likewise one real year. So
// making every voyage in a weather system share the trajectory index per trial
// is not an approximation of correlation; it IS the correlation, sampled from
// physically consistent states.
//
// This is only available to us because the pre-arrival engine samples whole
// TRAJECTORIES rather than per-hour marginals. A competitor holding per-voyage
// point estimates has no path to it at all.
//
// ── WHAT THIS MODULE IS CAREFUL ABOUT ──────────────────────────────────────
//
// VaR (a percentile) is NOT SUBADDITIVE. It is tempting to assert "correlation
// makes the portfolio P90 exceed the sum of the individual P90s", and that is
// not generally true:
//
//   * under COMONOTONIC dependence — perfect correlation — VaR is exactly
//     ADDITIVE, so the portfolio P90 EQUALS the sum, never exceeds it;
//   * under independence it is usually LESS (the familiar diversification
//     benefit);
//   * but it CAN exceed the sum, and does so here for a reason that has
//     nothing to do with correlation: demurrage is zero-inflated. When each
//     vessel is individually unlikely to go on demurrage its own P90 sits at
//     zero, while the portfolio's does not — so the sum of zeros is beaten by
//     a portfolio that has a real chance of at least one bad call.
//
// Both effects are real and this module reports them SEPARATELY, because
// conflating them would credit correlation with an effect produced by skew:
//
//   correlationUplift  = correlated P90 − independent P90   (the correlation)
//   diversification    = portfolio P90 − Σ individual P90s  (the aggregation)
//
// Expected Shortfall is reported alongside VaR because ES *is* coherent and
// subadditive — it is the tail number that behaves the way intuition expects a
// risk measure to behave.
//
// Pure: no I/O, no clock, no Math.random.

import { makeRng } from "@/lib/risk/prng";
import { runTrialFromVector, UNIFORMS_PER_TRIAL, type TrialInputs } from "@/lib/risk/trial";
import {
  estimateMean,
  estimatePercentile,
  estimateProbability,
  mean,
  percentile,
  type Estimate,
} from "@/lib/risk/aggregate";
import { haversineKm, type LatLon } from "@/lib/geo";

export interface PortfolioVoyage {
  id: string;
  label: string;
  /** The port's position — decides which weather system the voyage sits in. */
  position: LatLon;
  inputs: TrialInputs;
}

export interface ClusteringOptions {
  /**
   * Great-circle radius within which two ports share a weather system.
   *
   * 500 km by default: mid-latitude depressions and tropical systems have a
   * synoptic scale of roughly 1,000 km, so ports inside this radius genuinely
   * experience one system. Rotterdam–Antwerp is ~100 km; the US Gulf range is
   * ~700 km end to end, which correctly splits into overlapping neighbourhoods
   * rather than one blanket cluster.
   */
  radiusKm: number;
  /**
   * Operating windows must overlap in time as well as space. Two vessels at the
   * same port a month apart share a climate, not a storm.
   */
  requireTimeOverlap: boolean;
}

export const DEFAULT_CLUSTERING: ClusteringOptions = {
  radiusKm: 500,
  requireTimeOverlap: true,
};

export interface WeatherCluster {
  id: string;
  voyageIds: string[];
  label: string;
}

/** The span a voyage could plausibly occupy, used for time-overlap tests. */
function voyageWindow(v: PortfolioVoyage): { from: number; to: number } {
  const eta = Date.parse(v.inputs.etaISO);
  const HOUR = 3_600_000;
  const from = eta + v.inputs.etaErrorHours.min * HOUR;
  // Late arrival, plus queueing, plus cargo work, plus stoppage headroom.
  const worstWait = v.inputs.waitingHoursSorted[v.inputs.waitingHoursSorted.length - 1] ?? 0;
  const to =
    eta + (v.inputs.etaErrorHours.max + worstWait + v.inputs.opsDurationHours * 2) * HOUR;
  return { from, to };
}

/**
 * Groups voyages that share a weather system.
 *
 * Single-linkage: A and C end up together if both are near B, because one
 * synoptic system genuinely spans that chain. The alternative (all-pairs) would
 * split a real weather front into artificial fragments and understate exactly
 * the correlation this module exists to measure.
 */
export function clusterByWeatherSystem(
  voyages: PortfolioVoyage[],
  options: ClusteringOptions = DEFAULT_CLUSTERING
): WeatherCluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const v of voyages) parent.set(v.id, v.id);

  for (let i = 0; i < voyages.length; i++) {
    for (let j = i + 1; j < voyages.length; j++) {
      const a = voyages[i];
      const b = voyages[j];
      if (haversineKm(a.position, b.position) > options.radiusKm) continue;

      if (options.requireTimeOverlap) {
        const wa = voyageWindow(a);
        const wb = voyageWindow(b);
        if (wa.to < wb.from || wb.to < wa.from) continue;
      }
      union(a.id, b.id);
    }
  }

  const groups = new Map<string, string[]>();
  for (const v of voyages) {
    const root = find(v.id);
    groups.set(root, [...(groups.get(root) ?? []), v.id]);
  }

  return [...groups.entries()]
    .map(([root, ids]) => {
      const members = voyages.filter((v) => ids.includes(v.id));
      return {
        id: root,
        voyageIds: ids,
        label:
          members.length === 1
            ? members[0].label
            : `${members.length} voyages near ${members[0].label}`,
      };
    })
    .sort((a, b) => b.voyageIds.length - a.voyageIds.length);
}

export interface PortfolioDistribution {
  expectedCost: Estimate;
  p50Cost: Estimate;
  p90Cost: Estimate;
  p95Cost: Estimate;
  /**
   * Mean cost across the worst decile.
   *
   * Reported because Expected Shortfall IS coherent — subadditive, so
   * diversification can never look like it increases risk — where VaR is not.
   * When the two disagree, ES is the one to trust.
   */
  expectedShortfall90: Estimate;
  worstCase: number;
  bestCase: number;
  /** P(the book costs anything at all). */
  anyDemurrageProbability: Estimate;
  histogram: Array<{ from: number; to: number; count: number }>;
}

export interface VoyageContribution {
  voyageId: string;
  label: string;
  expectedCost: Estimate;
  p90Cost: Estimate;
  demurrageProbability: Estimate;
  /**
   * Share of the portfolio's worst-decile cost this voyage accounts for.
   *
   * Computed over the SAME trials that formed the tail, so the contributions
   * sum to the portfolio's Expected Shortfall by construction. That is the
   * actionable output: it names the fixture to re-nominate.
   */
  tailContributionShare: number;
  tailContributionAmount: number;
}

export interface PortfolioRiskReport {
  seed: string;
  trials: number;
  voyageCount: number;
  currency: string;
  clusters: WeatherCluster[];
  /** The book simulated with shared weather — the honest answer. */
  correlated: PortfolioDistribution;
  /**
   * The same book simulated as if every vessel had its own private weather.
   *
   * A counterfactual, kept because the DIFFERENCE is the finding. Alone it
   * would be a number nobody should act on.
   */
  independent: PortfolioDistribution;
  perVoyage: VoyageContribution[];
  sumOfIndividualP90: number;
  /**
   * correlated P90 − independent P90. Positive = correlation fattens the tail.
   * This is the correlation effect, isolated.
   */
  correlationUplift: number;
  /**
   * portfolio P90 − Σ individual P90s. Negative = diversification benefit,
   * positive = the zero-inflation penalty described in the module header.
   * This is the AGGREGATION effect and is not caused by correlation.
   */
  diversification: number;
  diversificationVerdict: "benefit" | "penalty" | "neutral";
  notes: string[];
}

export interface PortfolioOptions {
  seed: string;
  trials?: number;
  currency?: string;
  clustering?: ClusteringOptions;
  antithetic?: boolean;
}

export const DEFAULT_PORTFOLIO_TRIALS = 4000;
export const MAX_PORTFOLIO_TRIALS = 20000;

const HISTOGRAM_BINS = 24;

/** One trial's draw for the whole book, before any voyage is priced. */
interface TrialDraw {
  /** Shared weather uniform per cluster — the common random number. */
  clusterU: Map<string, number>;
  /** Idiosyncratic uniforms per voyage: ETA error and queue. */
  voyageU: Map<string, [number, number]>;
  /** Private weather uniform per voyage, for the independent counterfactual. */
  voyageWeatherU: Map<string, number>;
}

function drawTrial(
  voyages: PortfolioVoyage[],
  clusters: WeatherCluster[],
  next: () => number
): TrialDraw {
  const clusterU = new Map<string, number>();
  for (const c of clusters) clusterU.set(c.id, next());

  const voyageU = new Map<string, [number, number]>();
  const voyageWeatherU = new Map<string, number>();
  for (const v of voyages) {
    voyageU.set(v.id, [next(), next()]);
    voyageWeatherU.set(v.id, next());
  }
  return { clusterU, voyageU, voyageWeatherU };
}

function mirrorDraw(d: TrialDraw): TrialDraw {
  const flip = (u: number) => 1 - u;
  return {
    clusterU: new Map([...d.clusterU].map(([k, u]) => [k, flip(u)])),
    voyageU: new Map([...d.voyageU].map(([k, [a, b]]) => [k, [flip(a), flip(b)] as [number, number]])),
    voyageWeatherU: new Map([...d.voyageWeatherU].map(([k, u]) => [k, flip(u)])),
  };
}

export function simulatePortfolio(
  voyages: PortfolioVoyage[],
  options: PortfolioOptions
): PortfolioRiskReport {
  if (voyages.length === 0) throw new Error("NO_VOYAGES");
  const ids = new Set(voyages.map((v) => v.id));
  if (ids.size !== voyages.length) throw new Error("DUPLICATE_VOYAGE_ID");

  const trials = Math.min(
    Math.max(Math.floor(options.trials ?? DEFAULT_PORTFOLIO_TRIALS), 100),
    MAX_PORTFOLIO_TRIALS
  );
  const antithetic = options.antithetic ?? true;
  const clustering = options.clustering ?? DEFAULT_CLUSTERING;
  const clusters = clusterByWeatherSystem(voyages, clustering);

  const clusterOf = new Map<string, string>();
  for (const c of clusters) for (const vid of c.voyageIds) clusterOf.set(vid, c.id);

  const rng = makeRng(options.seed);

  const correlatedTotals: number[] = [];
  const independentTotals: number[] = [];
  // Per-voyage costs, aligned by trial index with correlatedTotals, so the tail
  // decomposition uses the same trials that formed the tail.
  const perVoyageCosts = new Map<string, number[]>();
  for (const v of voyages) perVoyageCosts.set(v.id, []);

  const priceDraw = (draw: TrialDraw) => {
    let correlatedTotal = 0;
    let independentTotal = 0;

    for (const v of voyages) {
      const [uEta, uWait] = draw.voyageU.get(v.id)!;

      // CORRELATED: the trajectory uniform comes from the cluster, so every
      // vessel in this weather system meets the same atmosphere this trial.
      // Each still applies its OWN ensembleWeight to it, which is correct —
      // a vessel further out genuinely has less forecast skill available.
      const uWeatherShared = draw.clusterU.get(clusterOf.get(v.id)!)!;
      const corr = runTrialFromVector([uEta, uWait, uWeatherShared], v.inputs);
      correlatedTotal += corr.net;
      perVoyageCosts.get(v.id)!.push(corr.net);

      // INDEPENDENT: private weather, everything else identical. Holding the
      // idiosyncratic draws fixed between the two runs is itself a variance
      // reduction — the difference isolates dependence rather than noise.
      const indep = runTrialFromVector([uEta, uWait, draw.voyageWeatherU.get(v.id)!], v.inputs);
      independentTotal += indep.net;
    }

    correlatedTotals.push(correlatedTotal);
    independentTotals.push(independentTotal);
  };

  if (antithetic) {
    const pairs = Math.floor(trials / 2);
    for (let i = 0; i < pairs; i++) {
      const draw = drawTrial(voyages, clusters, rng.next);
      priceDraw(draw);
      // Mirror the CLUSTER uniforms too, or the pair would be coherent for each
      // vessel individually while silently decorrelating the book.
      priceDraw(mirrorDraw(draw));
    }
    if (trials % 2 === 1) priceDraw(drawTrial(voyages, clusters, rng.next));
  } else {
    for (let i = 0; i < trials; i++) priceDraw(drawTrial(voyages, clusters, rng.next));
  }

  // Both distributions are binned on ONE shared domain.
  //
  // Binning each on its own min/max would give them different bin widths, so
  // the same density would render at different heights and the overlay would
  // misstate the comparison it exists to make. The union domain is computed
  // once and imposed on both.
  const allTotals = [...correlatedTotals, ...independentTotals];
  const sharedDomain: [number, number] = [Math.min(...allTotals), Math.max(...allTotals)];

  const correlated = summarisePortfolio(correlatedTotals, sharedDomain);
  const independent = summarisePortfolio(independentTotals, sharedDomain);

  // ── Per-voyage tail decomposition ─────────────────────────────────────────
  const sortedTotals = [...correlatedTotals].sort((a, b) => a - b);
  const tailThreshold = percentile(sortedTotals, 0.9);
  const tailTrialIdx: number[] = [];
  for (let i = 0; i < correlatedTotals.length; i++) {
    if (correlatedTotals[i] >= tailThreshold) tailTrialIdx.push(i);
  }
  const tailTotal = tailTrialIdx.reduce((acc, i) => acc + correlatedTotals[i], 0);

  const perVoyage: VoyageContribution[] = voyages.map((v) => {
    const costs = perVoyageCosts.get(v.id)!;
    const sorted = [...costs].sort((a, b) => a - b);
    const tailAmount = mean(tailTrialIdx.map((i) => costs[i]));
    return {
      voyageId: v.id,
      label: v.label,
      expectedCost: estimateMean(costs),
      p90Cost: estimatePercentile(sorted, 0.9),
      demurrageProbability: estimateProbability(costs.filter((c) => c > 0).length, costs.length),
      tailContributionShare:
        tailTotal === 0
          ? 0
          : tailTrialIdx.reduce((acc, i) => acc + costs[i], 0) / tailTotal,
      tailContributionAmount: tailAmount,
    };
  });

  const sumOfIndividualP90 = perVoyage.reduce((acc, p) => acc + p.p90Cost.value, 0);
  const diversification = correlated.p90Cost.value - sumOfIndividualP90;
  const correlationUplift = correlated.p90Cost.value - independent.p90Cost.value;

  const notes: string[] = [
    `${voyages.length} voyages grouped into ${clusters.length} weather ${clusters.length === 1 ? "system" : "systems"} ` +
      `(within ${clustering.radiusKm} km${clustering.requireTimeOverlap ? " and overlapping in time" : ""}).`,
    "Correlated is the honest figure. The independent run is a counterfactual kept so the difference between them can be shown; it is not a second opinion.",
  ];

  if (clusters.length === voyages.length) {
    notes.push(
      "No two voyages share a weather system, so correlation has nothing to act on here and the two runs should agree within Monte Carlo error."
    );
  }
  if (diversification > 0) {
    notes.push(
      "The portfolio P90 exceeds the sum of the individual P90s. That is NOT caused by correlation — VaR is additive at most under perfect correlation. It happens because demurrage is zero-inflated: each vessel is individually unlikely enough that its own P90 sits at or below zero, while the book as a whole has a real chance of at least one bad call. Expected Shortfall is the coherent measure to quote alongside it."
    );
  }

  return {
    seed: options.seed,
    trials: correlatedTotals.length,
    voyageCount: voyages.length,
    currency: options.currency ?? "USD",
    clusters,
    correlated,
    independent,
    perVoyage,
    sumOfIndividualP90,
    correlationUplift,
    diversification,
    diversificationVerdict:
      Math.abs(diversification) < 1 ? "neutral" : diversification > 0 ? "penalty" : "benefit",
    notes,
  };
}

function summarisePortfolio(
  totals: number[],
  sharedDomain?: [number, number]
): PortfolioDistribution {
  const sorted = [...totals].sort((a, b) => a - b);
  const p90 = percentile(sorted, 0.9);
  const tail = sorted.filter((v) => v >= p90);

  return {
    expectedCost: estimateMean(totals),
    p50Cost: estimatePercentile(sorted, 0.5),
    p90Cost: estimatePercentile(sorted, 0.9),
    p95Cost: estimatePercentile(sorted, 0.95),
    expectedShortfall90: estimateMean(tail),
    worstCase: sorted[sorted.length - 1] ?? 0,
    bestCase: sorted[0] ?? 0,
    anyDemurrageProbability: estimateProbability(
      totals.filter((t) => t > 0).length,
      totals.length
    ),
    histogram: buildHistogram(sorted, sharedDomain),
  };
}

/**
 * Bins onto `domain` when given one, so two distributions can be overlaid.
 *
 * Values are clamped into the range rather than dropped: a sample outside the
 * domain is still a sample, and silently discarding it would make the bars sum
 * to less than the trial count.
 */
function buildHistogram(
  sorted: number[],
  domain?: [number, number]
): Array<{ from: number; to: number; count: number }> {
  if (sorted.length === 0) return [];
  const lo = domain ? domain[0] : sorted[0];
  const hi = domain ? domain[1] : sorted[sorted.length - 1];
  if (hi === lo) return [{ from: lo, to: hi, count: sorted.length }];

  const width = (hi - lo) / HISTOGRAM_BINS;
  const bins = Array.from({ length: HISTOGRAM_BINS }, (_, i) => ({
    from: lo + i * width,
    to: lo + (i + 1) * width,
    count: 0,
  }));
  for (const v of sorted) {
    const idx = Math.floor((v - lo) / width);
    bins[Math.min(Math.max(idx, 0), HISTOGRAM_BINS - 1)].count++;
  }
  return bins;
}

/** Uniforms consumed per voyage per trial, for callers reasoning about cost. */
export const UNIFORMS_PER_VOYAGE = UNIFORMS_PER_TRIAL;
