import { describe, expect, test } from "bun:test";
import { buildChartModel, buildOverlayModel, CHART, type HistogramBin } from "@/lib/risk/chart-model";
import realPayload from "@/lib/risk/__fixtures__/real-payload.json";

// An SVG containing a single NaN renders as nothing at all — silently, with no
// console error. So every coordinate the chart emits is checked to be finite
// and inside the viewBox, across the inputs a real book will actually produce.

const PLOT_L = CHART.pad.left;
const PLOT_R = CHART.width - CHART.pad.right;
const PLOT_T = CHART.pad.top;
const PLOT_B = CHART.height - CHART.pad.bottom;

function numbersIn(path: string): number[] {
  return (path.match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi) ?? []).map(Number);
}

function assertSaneModel(m: NonNullable<ReturnType<typeof buildChartModel>>) {
  const nums = numbersIn(m.path);
  expect(nums.length).toBeGreaterThan(0);
  for (const n of nums) expect(Number.isFinite(n)).toBe(true);
  expect(m.path).not.toContain("NaN");
  expect(m.path).not.toContain("Infinity");

  for (const v of [m.zeroX, m.base, m.yTop, m.lo, m.hi]) {
    expect(Number.isFinite(v)).toBe(true);
  }
  for (const t of [...m.xTicks, ...m.yTicks]) expect(Number.isFinite(t)).toBe(true);

  // Path coordinates alternate x,y after the leading M — check both bands.
  for (let i = 0; i < nums.length; i += 2) {
    expect(nums[i]).toBeGreaterThanOrEqual(PLOT_L - 0.5);
    expect(nums[i]).toBeLessThanOrEqual(PLOT_R + 0.5);
  }
  for (let i = 1; i < nums.length; i += 2) {
    expect(nums[i]).toBeGreaterThanOrEqual(PLOT_T - 0.5);
    expect(nums[i]).toBeLessThanOrEqual(PLOT_B + 0.5);
  }
}

const bins = (spec: Array<[number, number, number]>): HistogramBin[] =>
  spec.map(([from, to, count]) => ({ from, to, count }));

describe("the real API payload", () => {
  // Captured from a live run: Santos / Grain, ETA +9d, 5,000 trials. Mean is
  // NEGATIVE and P90 POSITIVE, so the two annotation lines straddle zero —
  // the case most likely to expose a sign bug.
  const model = buildChartModel(realPayload as never)!;

  test("produces a finite, in-bounds path", () => {
    expect(model).not.toBeNull();
    assertSaneModel(model);
  });

  test("places break-even inside the plot with the mean left and P90 right", () => {
    const p = realPayload as unknown as { meanValue: number; p90Value: number };
    expect(p.meanValue).toBeLessThan(0);
    expect(p.p90Value).toBeGreaterThan(0);

    expect(model.zeroX).toBeGreaterThanOrEqual(PLOT_L);
    expect(model.zeroX).toBeLessThanOrEqual(PLOT_R);
    expect(model.x(p.meanValue)).toBeLessThan(model.zeroX);
    expect(model.x(p.p90Value)).toBeGreaterThan(model.zeroX);
  });

  test("the y-axis covers the tallest bin without clipping it", () => {
    const p = realPayload as unknown as { histogram: HistogramBin[]; trials: number };
    const maxShare = Math.max(...p.histogram.map((b) => b.count / p.trials));
    expect(model.yTop).toBeGreaterThanOrEqual(maxShare);
    expect(model.y(maxShare)).toBeGreaterThanOrEqual(PLOT_T - 0.5);
  });
});

describe("edge cases", () => {
  test("an empty histogram returns null rather than an empty frame", () => {
    expect(buildChartModel({ histogram: [], trials: 5000, meanValue: 0, p90Value: 0 })).toBeNull();
  });

  test("zero trials returns null rather than dividing by zero", () => {
    expect(
      buildChartModel({ histogram: bins([[0, 1, 0]]), trials: 0, meanValue: 0, p90Value: 0 })
    ).toBeNull();
  });

  test("a single bin renders without NaN", () => {
    const m = buildChartModel({
      histogram: bins([[0, 0, 5000]]),
      trials: 5000,
      meanValue: 0,
      p90Value: 0,
    })!;
    expect(m).not.toBeNull();
    assertSaneModel(m);
  });

  test("every outcome on demurrage still shows break-even on the plot", () => {
    // Otherwise the split that gives the chart its meaning falls off the edge.
    const m = buildChartModel({
      histogram: bins([[10_000, 20_000, 2500], [20_000, 30_000, 2500]]),
      trials: 5000,
      meanValue: 20_000,
      p90Value: 28_000,
    })!;
    assertSaneModel(m);
    expect(m.lo).toBeLessThanOrEqual(0);
    expect(m.zeroX).toBeGreaterThanOrEqual(PLOT_L);
    expect(m.zeroX).toBeLessThanOrEqual(PLOT_R);
  });

  test("every outcome on despatch still shows break-even on the plot", () => {
    const m = buildChartModel({
      histogram: bins([[-40_000, -30_000, 2500], [-30_000, -20_000, 2500]]),
      trials: 5000,
      meanValue: -30_000,
      p90Value: -21_000,
    })!;
    assertSaneModel(m);
    expect(m.hi).toBeGreaterThanOrEqual(0);
    expect(m.zeroX).toBeLessThanOrEqual(PLOT_R);
  });

  test("a P90 beyond the histogram is still drawn inside the plot", () => {
    const m = buildChartModel({
      histogram: bins([[0, 100, 5000]]),
      trials: 5000,
      meanValue: 50,
      p90Value: 900_000,
    })!;
    expect(m.x(900_000)).toBeLessThanOrEqual(PLOT_R + 0.5);
    assertSaneModel(m);
  });

  test("an all-identical sample at exactly zero does not divide by zero", () => {
    const m = buildChartModel({
      histogram: bins([[0, 0, 5000]]),
      trials: 5000,
      meanValue: 0,
      p90Value: 0,
    })!;
    expect(Number.isFinite(m.zeroX)).toBe(true);
    assertSaneModel(m);
  });

  test("a vanishingly small tallest bin still gets a usable axis", () => {
    // 24 bins each holding 1/5000 of the sample: without a floor the y-axis
    // would round to 0 and every coordinate would be Infinity.
    const m = buildChartModel({
      histogram: bins(Array.from({ length: 24 }, (_, i) => [i * 10, (i + 1) * 10, 1])),
      trials: 5000,
      meanValue: 100,
      p90Value: 200,
    })!;
    expect(m.yTop).toBeGreaterThan(0);
    assertSaneModel(m);
  });

  test("the axis never exceeds 100%", () => {
    const m = buildChartModel({
      histogram: bins([[0, 1, 5000]]),
      trials: 5000,
      meanValue: 0.5,
      p90Value: 1,
    })!;
    expect(m.yTop).toBeLessThanOrEqual(1);
  });

  test("the path is closed, so the area fills rather than drawing a line", () => {
    const m = buildChartModel(realPayload as never)!;
    expect(m.path.startsWith("M ")).toBe(true);
    expect(m.path.trimEnd().endsWith("Z")).toBe(true);
  });

  test("bins map left to right in order", () => {
    const m = buildChartModel({
      histogram: bins([[-100, 0, 10], [0, 100, 20], [100, 200, 30]]),
      trials: 60,
      meanValue: 50,
      p90Value: 150,
    })!;
    expect(m.x(-100)).toBeLessThan(m.x(0));
    expect(m.x(0)).toBeLessThan(m.x(100));
    // Taller bin sits higher on the plot (smaller y).
    expect(m.y(30 / 60)).toBeLessThan(m.y(10 / 60));
  });
});

describe("buildOverlayModel", () => {
  const bins = (spec: Array<[number, number, number]>): HistogramBin[] =>
    spec.map(([from, to, count]) => ({ from, to, count }));

  // Both series binned on ONE domain, as the portfolio simulator imposes.
  const correlated = bins([[0, 100, 200], [100, 200, 500], [200, 300, 300]]);
  const independent = bins([[0, 100, 400], [100, 200, 500], [200, 300, 100]]);

  const model = buildOverlayModel({
    series: [
      { key: "correlated", histogram: correlated },
      { key: "independent", histogram: independent },
    ],
    trials: 1000,
    markers: [
      { key: "corrP90", value: 260, label: "Correlated P90" },
      { key: "indepP90", value: 180, label: "Independent P90" },
    ],
  })!;

  test("produces a finite in-bounds path per series", () => {
    expect(Object.keys(model.paths).sort()).toEqual(["correlated", "independent"]);
    for (const d of Object.values(model.paths)) {
      expect(d).not.toContain("NaN");
      expect(d).not.toContain("Infinity");
      const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      for (let i = 0; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(PLOT_L - 0.5);
        expect(nums[i]).toBeLessThanOrEqual(PLOT_R + 0.5);
      }
      for (let i = 1; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(PLOT_T - 0.5);
        expect(nums[i]).toBeLessThanOrEqual(PLOT_B + 0.5);
      }
    }
  });

  test("shares one y-scale, so equal densities render at equal heights", () => {
    // The whole point of the overlay: both middle bins hold 500 of 1000.
    expect(model.y(500 / 1000)).toBe(model.y(500 / 1000));
    // And the taller correlated tail sits above the shorter independent one.
    expect(model.y(300 / 1000)).toBeLessThan(model.y(100 / 1000));
  });

  test("keeps both markers inside the plot even beyond the histogram", () => {
    for (const m of model.markers) {
      expect(m.x).toBeGreaterThanOrEqual(PLOT_L - 0.5);
      expect(m.x).toBeLessThanOrEqual(PLOT_R + 0.5);
    }
  });

  test("the uplift band spans between the two markers, low to high", () => {
    expect(model.upliftBand).not.toBeNull();
    expect(model.upliftBand!.fromX).toBeLessThan(model.upliftBand!.toX);
    // Independent P90 (180) is left of correlated P90 (260).
    const corr = model.markers.find((m) => m.key === "corrP90")!;
    const indep = model.markers.find((m) => m.key === "indepP90")!;
    expect(indep.x).toBeLessThan(corr.x);
    expect(model.upliftBand!.fromX).toBeCloseTo(indep.x, 6);
    expect(model.upliftBand!.toX).toBeCloseTo(corr.x, 6);
  });

  test("returns null rather than an empty frame", () => {
    expect(buildOverlayModel({ series: [], trials: 1000 })).toBeNull();
    expect(
      buildOverlayModel({ series: [{ key: "a", histogram: correlated }], trials: 0 })
    ).toBeNull();
    expect(
      buildOverlayModel({ series: [{ key: "a", histogram: [] }], trials: 1000 })
    ).toBeNull();
  });

  test("a single series still renders", () => {
    const one = buildOverlayModel({
      series: [{ key: "only", histogram: correlated }],
      trials: 1000,
    })!;
    expect(Object.keys(one.paths)).toEqual(["only"]);
    expect(one.upliftBand).toBeNull();
  });

  test("survives a degenerate domain without dividing by zero", () => {
    const flat = buildOverlayModel({
      series: [{ key: "a", histogram: bins([[50, 50, 1000]]) }],
      trials: 1000,
      markers: [{ key: "m", value: 50, label: "P90" }],
    })!;
    expect(Number.isFinite(flat.x(50))).toBe(true);
    expect(flat.paths.a).not.toContain("NaN");
  });
});
