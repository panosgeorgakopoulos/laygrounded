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

// ── Two-series overlay (portfolio: correlated vs independent) ───────────────

export interface OverlaySeriesInput {
  key: string;
  histogram: HistogramBin[];
}

export interface OverlayMarker {
  key: string;
  value: number;
  label: string;
}

export interface OverlayModel {
  lo: number;
  hi: number;
  yTop: number;
  x: (v: number) => number;
  y: (share: number) => number;
  base: number;
  /** One closed stepped-area path per series, keyed as supplied. */
  paths: Record<string, string>;
  xTicks: number[];
  yTicks: number[];
  markers: Array<OverlayMarker & { x: number }>;
  /** x-span between the first two markers — the uplift, made visible. */
  upliftBand: { fromX: number; toX: number } | null;
}

export interface OverlayModelInput {
  series: OverlaySeriesInput[];
  trials: number;
  markers?: OverlayMarker[];
}

/**
 * Geometry for two distributions drawn on one pair of axes.
 *
 * Assumes the histograms were binned on a SHARED domain (the portfolio
 * simulator imposes one). If they were not, the paths would still render, but
 * equal densities would sit at unequal heights and the comparison the chart
 * exists to make would be wrong — so the shared domain is the caller's
 * contract, and this function asserts what it can: an empty or zero-trial input
 * yields null rather than an axis frame that looks like a chart of zero.
 */
export function buildOverlayModel(input: OverlayModelInput): OverlayModel | null {
  const { series, trials, markers = [] } = input;
  if (trials <= 0) return null;
  const usable = series.filter((s) => s.histogram.length > 0);
  if (usable.length === 0) return null;

  const plotW = CHART.width - CHART.pad.left - CHART.pad.right;
  const plotH = CHART.height - CHART.pad.top - CHART.pad.bottom;

  const edges = usable.flatMap((s) => [s.histogram[0].from, s.histogram[s.histogram.length - 1].to]);
  const markerValues = markers.map((m) => m.value);
  const lo = Math.min(...edges, ...markerValues);
  const hi = Math.max(...edges, ...markerValues);
  const span = hi - lo || 1;

  const maxShare = Math.max(
    ...usable.flatMap((s) => s.histogram.map((b) => b.count / trials)),
    1e-9
  );
  const yTop = Math.min(1, Math.max(Math.ceil(maxShare * 20) / 20, 0.05));

  const x = (v: number) => CHART.pad.left + ((v - lo) / span) * plotW;
  const y = (share: number) => CHART.pad.top + plotH - (share / yTop) * plotH;
  const base = CHART.pad.top + plotH;

  const paths: Record<string, string> = {};
  for (const s of usable) {
    let d = `M ${x(s.histogram[0].from)} ${base}`;
    for (const b of s.histogram) {
      const yy = y(b.count / trials);
      d += ` L ${x(b.from)} ${yy} L ${x(b.to)} ${yy}`;
    }
    d += ` L ${x(s.histogram[s.histogram.length - 1].to)} ${base} Z`;
    paths[s.key] = d;
  }

  const placed = markers.map((m) => ({ ...m, x: x(m.value) }));
  const upliftBand =
    placed.length >= 2
      ? {
          fromX: Math.min(placed[0].x, placed[1].x),
          toX: Math.max(placed[0].x, placed[1].x),
        }
      : null;

  return {
    lo,
    hi,
    yTop,
    x,
    y,
    base,
    paths,
    xTicks: Array.from({ length: 5 }, (_, i) => lo + (span * i) / 4),
    yTicks: Array.from({ length: 5 }, (_, i) => (yTop * i) / 4),
    markers: placed,
    upliftBand,
  };
}
