// Samplers for the pre-arrival simulation.
//
// Every sampler here takes a uniform in [0, 1) rather than an Rng. That is
// deliberate and load-bearing: it makes each draw a pure function of one
// number, which is what lets `simulate.ts` build a trial from a fixed-length
// vector of uniforms and mirror that vector for antithetic variates. A sampler
// that reached into a generator itself would consume an unpredictable number
// of draws and break the pairing.
//
// Pure.

/**
 * Inverse-CDF sampling from observed values (the empirical distribution).
 *
 * Used for berth waiting time, where we have real observations and no reason to
 * assume a parametric shape. Port queues are heavy-tailed and often bimodal —
 * a berth is free or there are nine ships ahead of you — so fitting a lognormal
 * to them would throw away exactly the structure that drives demurrage.
 *
 * Interpolates linearly between order statistics, which smooths the steps a
 * small sample would otherwise produce without inventing a tail beyond the
 * observed range.
 *
 * `sortedAscending` must be sorted and non-empty; callers hold that invariant
 * because sorting per draw would dominate the cost of the whole simulation.
 */
export function sampleEmpirical(sortedAscending: number[], u: number): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAscending[0];

  const idx = u * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, n - 1);
  const frac = idx - lo;
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * frac;
}

/**
 * Triangular distribution — the standard choice for a three-point estimate.
 *
 * Used for ETA error, where a master gives "expected the 14th, could be a day
 * early, could be three days late". It is bounded, which matters: an unbounded
 * ETA error would occasionally place arrival outside the fetched weather window
 * and quietly fall back to climatology for no physical reason.
 */
export function sampleTriangular(min: number, mode: number, max: number, u: number): number {
  if (max <= min) return min;
  const c = Math.min(Math.max(mode, min), max);
  const fc = (c - min) / (max - min);

  return u < fc
    ? min + Math.sqrt(u * (max - min) * (c - min))
    : max - Math.sqrt((1 - u) * (max - min) * (max - c));
}

/**
 * Standard normal by the inverse CDF (Acklam's rational approximation).
 *
 * Box-Muller would need two uniforms per draw and would therefore break the
 * one-uniform-per-decision contract that makes antithetic pairing work. An
 * inverse-CDF normal also mirrors correctly: 1-u maps to -z, so the antithetic
 * partner is the reflected draw, which is exactly the correlation we want.
 *
 * Accurate to ~1.15e-9 in absolute value, far tighter than any input here.
 */
export function standardNormal(u: number): number {
  // Clamp off the open ends: u = 0 would return -Infinity.
  const p = Math.min(Math.max(u, 1e-12), 1 - 1e-12);

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];

  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Lognormal by median and shape.
 *
 * Parameterised by MEDIAN rather than the log-mean, because the caller is a
 * shipping desk reasoning about "typically 30 hours" — the median is the
 * quantity they actually have an intuition for, and it equals exp(mu) directly.
 */
export function sampleLognormal(median: number, sigma: number, u: number): number {
  if (median <= 0) return 0;
  return median * Math.exp(sigma * standardNormal(u));
}

/**
 * Picks an index from a pool, uniformly.
 *
 * Separate from the samplers above because a pool choice is a *categorical*
 * draw, and reflecting it antithetically (1-u) reverses the pool order rather
 * than mirroring a magnitude — which is still a valid negative correlation, and
 * is what we want for trajectory selection.
 */
export function pickIndex(poolSize: number, u: number): number {
  if (poolSize <= 0) return -1;
  return Math.min(Math.floor(u * poolSize), poolSize - 1);
}
