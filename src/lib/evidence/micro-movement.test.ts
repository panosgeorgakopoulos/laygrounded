import { describe, expect, test } from "bun:test";
import type { SofEventInput } from "@/lib/laytime/types";
import {
  DEFAULT_THRESHOLDS,
  deriveMotionSegments,
  haversineMetres,
  summariseWindow,
  verifyTimelineMotion,
  type AisFix,
} from "@/lib/evidence/micro-movement";

// The failure mode this module must never have is manufacturing a finding from
// an absent or sparse feed. Roughly half these tests exist to prove it stays
// silent when it should.

const BERTH = { lat: 51.9500, lon: 4.1400 };

/** Fixes every `stepMin` minutes, drifting `metresPerStep` along a bearing. */
function track(
  startISO: string,
  count: number,
  stepMin: number,
  metresPerStep: number,
  origin = BERTH
): AisFix[] {
  const start = Date.parse(startISO);
  // 1 degree of latitude ≈ 111,320 m.
  return Array.from({ length: count }, (_, i) => ({
    at: new Date(start + i * stepMin * 60_000).toISOString(),
    lat: origin.lat + (i * metresPerStep) / 111_320,
    lon: origin.lon,
  }));
}

describe("haversineMetres", () => {
  test("matches a known separation", () => {
    // 0.01° of latitude ≈ 1113 m anywhere on the globe.
    const d = haversineMetres(
      { at: "", lat: 51.95, lon: 4.14 },
      { at: "", lat: 51.96, lon: 4.14 }
    );
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });

  test("is zero for the same point and symmetric", () => {
    const a: AisFix = { at: "", lat: 51.95, lon: 4.14 };
    const b: AisFix = { at: "", lat: 52.10, lon: 4.30 };
    expect(haversineMetres(a, a)).toBeCloseTo(0, 6);
    expect(haversineMetres(a, b)).toBeCloseTo(haversineMetres(b, a), 6);
  });

  test("handles the antimeridian without returning a half-globe", () => {
    const d = haversineMetres(
      { at: "", lat: 0, lon: 179.99 },
      { at: "", lat: 0, lon: -179.99 }
    );
    expect(d).toBeLessThan(3000);
  });
});

describe("deriveMotionSegments", () => {
  test("classifies a moored vessel", () => {
    // 10m every 10 minutes — warping, not way.
    const segs = deriveMotionSegments(track("2026-03-01T00:00:00Z", 12, 10, 10));
    expect(segs.every((s) => s.state === "moored")).toBe(true);
  });

  test("classifies a vessel under way", () => {
    // 2 km every 10 minutes ≈ 6.5 kn.
    const segs = deriveMotionSegments(track("2026-03-01T00:00:00Z", 6, 10, 2000));
    expect(segs.every((s) => s.state === "underway")).toBe(true);
  });

  test("classifies an intermediate shift", () => {
    // 400 m every 10 minutes ≈ 1.3 kn — moving, but not making way.
    const segs = deriveMotionSegments(track("2026-03-01T00:00:00Z", 6, 10, 400));
    expect(segs.every((s) => s.state === "shifting")).toBe(true);
  });

  test("marks a long interval as a gap and refuses to classify it", () => {
    // Two fixes 3 hours apart, 20 m apart. Average speed is ~0, but she could
    // have sailed and returned. This must NOT read as 'moored'.
    const segs = deriveMotionSegments([
      { at: "2026-03-01T00:00:00Z", lat: BERTH.lat, lon: BERTH.lon },
      { at: "2026-03-01T03:00:00Z", lat: BERTH.lat + 20 / 111_320, lon: BERTH.lon },
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0].isGap).toBe(true);
    expect(segs[0].state).toBe("unknown");
  });

  test("a duplicate-timestamp outlier cannot manufacture a phantom jump", () => {
    // The vessel cannot be in two places at one instant. Skipping only the
    // zero-duration segment is not enough — the outlier would still anchor the
    // NEXT segment, inventing a 1.1 km jump that classifies as 'underway' and
    // could contradict an honest SoF. The duplicate must be dropped outright.
    const segs = deriveMotionSegments([
      { at: "2026-03-01T00:00:00Z", lat: 51.95, lon: 4.14 },
      { at: "2026-03-01T00:00:00Z", lat: 51.96, lon: 4.14 }, // outlier
      { at: "2026-03-01T00:10:00Z", lat: 51.9501, lon: 4.14 },
    ]);
    expect(segs).toHaveLength(1);
    expect(segs.every((s) => Number.isFinite(s.speedKn))).toBe(true);
    expect(segs[0].state).toBe("moored");
  });

  test("sorts an out-of-order track rather than trusting the provider", () => {
    const forward = track("2026-03-01T00:00:00Z", 5, 10, 10);
    const shuffled = [forward[3], forward[0], forward[4], forward[1], forward[2]];
    expect(deriveMotionSegments(shuffled)).toEqual(deriveMotionSegments(forward));
  });

  test("discards unusable fixes without throwing", () => {
    const segs = deriveMotionSegments([
      { at: "not-a-date", lat: 51.95, lon: 4.14 },
      { at: "2026-03-01T00:00:00Z", lat: Number.NaN, lon: 4.14 },
      { at: "2026-03-01T00:10:00Z", lat: 51.95, lon: 4.14 },
      { at: "2026-03-01T00:20:00Z", lat: 51.9501, lon: 4.14 },
    ]);
    expect(segs).toHaveLength(1);
  });

  test("an empty or single-fix track yields no segments", () => {
    expect(deriveMotionSegments([])).toEqual([]);
    expect(deriveMotionSegments([{ at: "2026-03-01T00:00:00Z", lat: 1, lon: 1 }])).toEqual([]);
  });
});

describe("summariseWindow", () => {
  test("reports full coverage for a densely-tracked window", () => {
    const w = summariseWindow(
      track("2026-03-01T00:00:00Z", 13, 10, 10),
      "2026-03-01T00:00:00Z",
      "2026-03-01T02:00:00Z"
    );
    expect(w.coverage).toBeCloseTo(1, 1);
    expect(w.dominantState).toBe("moored");
  });

  test("clips segments straddling the window boundary", () => {
    // Track runs 00:00–02:00; the window is only the middle hour.
    const w = summariseWindow(
      track("2026-03-01T00:00:00Z", 13, 10, 10),
      "2026-03-01T00:30:00Z",
      "2026-03-01T01:30:00Z"
    );
    expect(w.hours).toBeCloseTo(1, 6);
    const observed = w.stateHours.moored + w.stateHours.shifting + w.stateHours.underway;
    expect(observed).toBeLessThanOrEqual(1.001);
  });

  test("reports low coverage when the window is mostly silent", () => {
    const w = summariseWindow(
      [
        { at: "2026-03-01T00:00:00Z", lat: BERTH.lat, lon: BERTH.lon },
        { at: "2026-03-01T00:10:00Z", lat: BERTH.lat, lon: BERTH.lon },
      ],
      "2026-03-01T00:00:00Z",
      "2026-03-01T04:00:00Z"
    );
    expect(w.coverage).toBeLessThan(0.1);
  });

  test("measures excursion from the window start, not just net displacement", () => {
    // Out 1 km and back: net displacement ~0, but she plainly moved.
    const w = summariseWindow(
      [
        { at: "2026-03-01T00:00:00Z", lat: BERTH.lat, lon: BERTH.lon },
        { at: "2026-03-01T00:20:00Z", lat: BERTH.lat + 1000 / 111_320, lon: BERTH.lon },
        { at: "2026-03-01T00:40:00Z", lat: BERTH.lat, lon: BERTH.lon },
      ],
      "2026-03-01T00:00:00Z",
      "2026-03-01T00:40:00Z"
    );
    expect(w.netDisplacementM).toBeLessThan(50);
    expect(w.maxExcursionM).toBeGreaterThan(900);
  });

  test("a zero-length window does not divide by zero", () => {
    const w = summariseWindow(track("2026-03-01T00:00:00Z", 5, 10, 10),
      "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
    expect(Number.isFinite(w.coverage)).toBe(true);
    expect(w.hours).toBe(0);
  });
});

const ev = (id: string, at: string, type: string): SofEventInput =>
  ({ id, occurred_at: at, event_type: type }) as SofEventInput;

describe("verifyTimelineMotion — refusals", () => {
  const events = [
    ev("1", "2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
    ev("2", "2026-03-01T06:00:00Z", "COMPLETED_LOADING"),
  ];

  test("a null track is `unavailable`, never a finding", () => {
    const [check] = verifyTimelineMotion(null, events);
    expect(check.verdict).toBe("unavailable");
    expect(check.summary).toContain("No AIS track");
  });

  test("a one-fix track is `unavailable`", () => {
    const [check] = verifyTimelineMotion(
      [{ at: "2026-03-01T01:00:00Z", lat: BERTH.lat, lon: BERTH.lon }],
      events
    );
    expect(check.verdict).toBe("unavailable");
  });

  test("a timeline with nothing testable says so rather than passing silently", () => {
    const [check] = verifyTimelineMotion(track("2026-03-01T00:00:00Z", 10, 10, 10), [
      ev("1", "2026-03-01T00:00:00Z", "NOR_TENDERED"),
    ]);
    expect(check.verdict).toBe("unavailable");
    expect(check.summary).toContain("no cargo-operation or shifting window");
  });

  test("sparse coverage is inconclusive, NEVER corroborated", () => {
    // The rule that matters most: two fixes six hours apart must not be read
    // as proof the vessel sat still for six hours.
    const sparse: AisFix[] = [
      { at: "2026-03-01T00:00:00Z", lat: BERTH.lat, lon: BERTH.lon },
      { at: "2026-03-01T06:00:00Z", lat: BERTH.lat, lon: BERTH.lon },
    ];
    const [check] = verifyTimelineMotion(sparse, events);
    expect(check.verdict).toBe("inconclusive");
    expect(check.summary).toContain("not evidence");
  });
});

describe("verifyTimelineMotion — cargo operations", () => {
  test("corroborates a vessel that held station throughout", () => {
    const [check] = verifyTimelineMotion(track("2026-03-01T00:00:00Z", 37, 10, 5), [
      ev("1", "2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
      ev("2", "2026-03-01T06:00:00Z", "COMPLETED_LOADING"),
    ]);
    expect(check.checkType).toBe("motion_cargo_operations");
    expect(check.verdict).toBe("corroborated");
    expect(check.eventId).toBe("1");
  });

  test("contradicts cargo work claimed while under way", () => {
    // 2 km every 10 minutes for six hours — she was at sea, not working cargo.
    const [check] = verifyTimelineMotion(track("2026-03-01T00:00:00Z", 37, 10, 2000), [
      ev("1", "2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
      ev("2", "2026-03-01T06:00:00Z", "COMPLETED_LOADING"),
    ]);
    expect(check.verdict).toBe("contradicted");
    expect(check.summary).toContain("making way");
  });

  test("handles discharge as well as loading", () => {
    const [check] = verifyTimelineMotion(track("2026-03-01T00:00:00Z", 37, 10, 5), [
      ev("1", "2026-03-01T00:00:00Z", "COMMENCED_DISCHARGE"),
      ev("2", "2026-03-01T06:00:00Z", "COMPLETED_DISCHARGE"),
    ]);
    expect(check.checkType).toBe("motion_cargo_operations");
    expect(check.verdict).toBe("corroborated");
  });

  test("checks every operations window, not just the first", () => {
    const checks = verifyTimelineMotion(track("2026-03-01T00:00:00Z", 73, 10, 5), [
      ev("1", "2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
      ev("2", "2026-03-01T04:00:00Z", "COMPLETED_LOADING"),
      ev("3", "2026-03-01T06:00:00Z", "COMMENCED_LOADING"),
      ev("4", "2026-03-01T10:00:00Z", "COMPLETED_LOADING"),
    ]);
    expect(checks.filter((c) => c.checkType === "motion_cargo_operations")).toHaveLength(2);
  });
});

describe("verifyTimelineMotion — shifting", () => {
  test("contradicts a claimed shift where the vessel never moved", () => {
    // The commercial point: shifting time is often excepted, so a phantom
    // shift is a way to reduce counted laytime.
    const [check] = verifyTimelineMotion(track("2026-03-01T00:00:00Z", 13, 10, 5), [
      ev("1", "2026-03-01T00:00:00Z", "SHIFTING"),
      ev("2", "2026-03-01T02:00:00Z", "SHIFTING_END"),
    ]);
    expect(check.checkType).toBe("motion_shifting");
    expect(check.verdict).toBe("contradicted");
    expect(check.summary).toContain("does not support a shift");
  });

  test("corroborates a shift that genuinely moved the vessel", () => {
    const [check] = verifyTimelineMotion(track("2026-03-01T00:00:00Z", 13, 10, 150), [
      ev("1", "2026-03-01T00:00:00Z", "SHIFTING"),
      ev("2", "2026-03-01T02:00:00Z", "SHIFTING_END"),
    ]);
    expect(check.verdict).toBe("corroborated");
  });

  test("an out-and-back shift counts as movement", () => {
    const there: AisFix[] = Array.from({ length: 13 }, (_, i) => ({
      at: new Date(Date.parse("2026-03-01T00:00:00Z") + i * 10 * 60_000).toISOString(),
      lat: BERTH.lat + (i <= 6 ? i * 120 : (12 - i) * 120) / 111_320,
      lon: BERTH.lon,
    }));
    const [check] = verifyTimelineMotion(there, [
      ev("1", "2026-03-01T00:00:00Z", "SHIFTING"),
      ev("2", "2026-03-01T02:00:00Z", "SHIFTING_END"),
    ]);
    expect(check.verdict).toBe("corroborated");
  });
});

describe("thresholds", () => {
  test("every verdict names the threshold source it rests on", () => {
    const checks = verifyTimelineMotion(track("2026-03-01T00:00:00Z", 37, 10, 5), [
      ev("1", "2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
      ev("2", "2026-03-01T06:00:00Z", "COMPLETED_LOADING"),
    ]);
    for (const c of checks) expect(c.thresholdSource).toBe(DEFAULT_THRESHOLDS.sourceLabel);
  });

  test("a tenant may tighten the moored tolerance", () => {
    const t = { ...DEFAULT_THRESHOLDS, mooredDisplacementM: 20, sourceLabel: "Tenant override" };
    // 50 m of movement: within the default tolerance, outside the tightened one.
    const [check] = verifyTimelineMotion(
      track("2026-03-01T00:00:00Z", 13, 10, 50),
      [
        ev("1", "2026-03-01T00:00:00Z", "SHIFTING"),
        ev("2", "2026-03-01T02:00:00Z", "SHIFTING_END"),
      ],
      t
    );
    expect(check.verdict).toBe("corroborated");
    expect(check.thresholdSource).toBe("Tenant override");
  });
});
