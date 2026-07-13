// Pre-Fixture Pricing Oracle — pure risk math over historical voyage stats.
//
// A shipbroker negotiating a fixture wants to know what a proposed laytime
// allowance + demurrage rate would have cost across the voyages we have
// actually observed (and evidence-verified) at that port. This module is the
// pure half: given historical voyage stats and the broker's proposed terms,
// it replays every voyage against the hypothetical allowance and prices the
// excess. All I/O (reading the oracle_voyage_stats materialized view) lives
// in the API route — same no-I/O discipline as the laytime engine.

export interface OracleVoyageStat {
  month: number;
  weatherDelayHours: number;
  usedHours: number;
  allowedHours: number;
  excessHours: number;
  verified: boolean;
}

export interface PricingInput {
  laytimeAllowedHours: number;
  demurrageRatePerDay: number;
}

export interface RiskExposure {
  sampleSize: number;
  verifiedShare: number;
  demurrageProbability: number;
  meanExposure: number;
  medianExposure: number;
  p90Exposure: number;
  worstExposure: number;
  meanWeatherDelayHours: number;
  meanUsedHours: number;
  assessment: string;
}

// Below this the estimate is noise — the route surfaces INSUFFICIENT_DATA.
export const MIN_SAMPLE_VOYAGES = 3;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

// Linear-interpolation percentile over an ascending-sorted array. A
// single-element array returns that element for every p; an empty array
// returns 0. p is clamped to [0, 1].
export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = (sortedValues.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

// Amount formatting for the assessment sentence. Deliberately currency-free:
// this module stays pure and unit-agnostic; the route attaches the currency.
function formatAmount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// One human sentence a broker can paste into a recap email.
function buildAssessment(
  allowanceHours: number,
  overCount: number,
  total: number,
  meanExposure: number,
  p90Exposure: number
): string {
  if (overCount === 0) {
    return `At a ${allowanceHours}h allowance, none of the ${total} historical voyages would have exceeded laytime.`;
  }
  return `At a ${allowanceHours}h allowance, ${overCount} of ${total} historical voyages would have gone on demurrage; expected exposure ${formatAmount(meanExposure)}, P90 ${formatAmount(p90Exposure)}.`;
}

// Replays every historical voyage against the broker's proposed allowance:
// what each voyage actually used stays fixed; only the allowance and the
// demurrage rate are hypothetical. Throws Error("INSUFFICIENT_DATA") when the
// sample is below MIN_SAMPLE_VOYAGES.
export function computeRiskExposure(
  stats: OracleVoyageStat[],
  input: PricingInput
): RiskExposure {
  if (stats.length < MIN_SAMPLE_VOYAGES) {
    throw new Error("INSUFFICIENT_DATA");
  }

  const exposures = stats.map((s) => {
    const hypotheticalExcess = Math.max(s.usedHours - input.laytimeAllowedHours, 0);
    return (hypotheticalExcess / 24) * input.demurrageRatePerDay;
  });
  const sorted = [...exposures].sort((a, b) => a - b);
  const overCount = exposures.filter((e) => e > 0).length;

  const meanExposure = round2(mean(exposures));
  const p90Exposure = round2(percentile(sorted, 0.9));

  return {
    sampleSize: stats.length,
    verifiedShare: round2(stats.filter((s) => s.verified).length / stats.length),
    demurrageProbability: round2(overCount / stats.length),
    meanExposure,
    medianExposure: round2(percentile(sorted, 0.5)),
    p90Exposure,
    worstExposure: round2(sorted[sorted.length - 1]),
    meanWeatherDelayHours: round1(mean(stats.map((s) => s.weatherDelayHours))),
    meanUsedHours: round1(mean(stats.map((s) => s.usedHours))),
    assessment: buildAssessment(
      input.laytimeAllowedHours,
      overCount,
      stats.length,
      meanExposure,
      p90Exposure
    ),
  };
}
