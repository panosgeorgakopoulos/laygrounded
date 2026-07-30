// The geometry behind the risk distribution chart.
//
// Split out of the component so it can be tested without a DOM. Chart maths is
// exactly the kind of code that looks fine and renders a path full of `NaN` on
// the one input nobody tried — an empty histogram, a single bin, every outcome
// on one side of zero — and an SVG with a NaN in it fails silently by drawing
// nothing at all.
//
// Pure.

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

export interface ChartGeometry {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
}

export const CHART: ChartGeometry = {
  width: 820,
  height: 340,
  pad: { top: 28, right: 22, bottom: 52, left: 66 },
};

export interface ChartModel {
  lo: number;
  hi: number;
  yTop: number;
  /** Value → x pixel. */
  x: (v: number) => number;
  /** Share (0–1) → y pixel. */
  y: (share: number) => number;
  /** Stepped area path over the bins, closed to the baseline. */
  path: string;
  base: number;
  zeroX: number;
  xTicks: number[];
  yTicks: number[];
}

export interface ChartModelInput {
  histogram: HistogramBin[];
  trials: number;
  meanValue: number;
  p90Value: number;
}

/**
 * Builds every coordinate the chart needs, or null when there is nothing to draw.
 *
 * Returning null rather than an empty model is deliberate: the caller must render
 * a stated "no distribution" message, not an empty axis frame that looks like a
 * chart of zero.
 */
export function buildChartModel(input: ChartModelInput): ChartModel | null {
  const { histogram, trials, meanValue, p90Value } = input;
  if (histogram.length === 0 || trials <= 0) return null;

  const plotW = CHART.width - CHART.pad.left - CHART.pad.right;
  const plotH = CHART.height - CHART.pad.top - CHART.pad.bottom;

  // Zero must be inside the domain even when every outcome sits on one side of
  // it: the split at break-even is what the chart means, so it can never fall
  // off the plot. The annotation values are included for the same reason — a
  // P90 outside the drawn range would render its dashed line against an edge.
  const lo = Math.min(histogram[0].from, 0, meanValue, p90Value);
  const hi = Math.max(histogram[histogram.length - 1].to, 0, meanValue, p90Value);
  // A degenerate domain (every outcome identical AND equal to zero) would divide
  // by zero and put NaN into every coordinate.
  const span = hi - lo || 1;

  const maxShare = Math.max(...histogram.map((b) => b.count / trials), 1e-9);
  // Round up to a clean 5% step so the top gridline is a number worth reading.
  const yTop = Math.min(1, Math.max(Math.ceil(maxShare * 20) / 20, 0.05));

  const x = (v: number) => CHART.pad.left + ((v - lo) / span) * plotW;
  const y = (share: number) => CHART.pad.top + plotH - (share / yTop) * plotH;

  const base = CHART.pad.top + plotH;

  let path = `M ${x(histogram[0].from)} ${base}`;
  for (const b of histogram) {
    const yy = y(b.count / trials);
    path += ` L ${x(b.from)} ${yy} L ${x(b.to)} ${yy}`;
  }
  path += ` L ${x(histogram[histogram.length - 1].to)} ${base} Z`;

  return {
    lo,
    hi,
    yTop,
    x,
    y,
    path,
    base,
    zeroX: x(0),
    xTicks: Array.from({ length: 5 }, (_, i) => lo + (span * i) / 4),
    yTicks: Array.from({ length: 5 }, (_, i) => (yTop * i) / 4),
  };
}
