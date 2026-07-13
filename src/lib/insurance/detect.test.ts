import { describe, expect, test } from "bun:test";
import type { BreakdownRow } from "@/lib/laytime/types";
import { detectParametricTrigger, longestContinuousWeatherDelay } from "./detect";

function row(
  start: string,
  end: string,
  status: BreakdownRow["status"],
  duration_hours: number
): BreakdownRow {
  return {
    start_time: start,
    end_time: end,
    duration_hours,
    status,
    counts: status === "laytime",
    clause_ref: "GENCON94-6c",
    reasoning: "test fixture",
  };
}

describe("longestContinuousWeatherDelay", () => {
  test("no weather rows → null", () => {
    const breakdown = [
      row("2026-02-01T00:00:00Z", "2026-02-01T12:00:00Z", "laytime", 12),
      row("2026-02-01T12:00:00Z", "2026-02-01T18:00:00Z", "shifting", 6),
    ];
    expect(longestContinuousWeatherDelay(breakdown)).toBeNull();
  });

  test("single weather row is its own window", () => {
    const breakdown = [
      row("2026-02-01T00:00:00Z", "2026-02-01T06:00:00Z", "laytime", 6),
      row("2026-02-01T06:00:00Z", "2026-02-02T06:00:00Z", "weather_delay", 24),
      row("2026-02-02T06:00:00Z", "2026-02-03T00:00:00Z", "laytime", 18),
    ];
    expect(longestContinuousWeatherDelay(breakdown)).toEqual({
      hours: 24,
      start: "2026-02-01T06:00:00Z",
      end: "2026-02-02T06:00:00Z",
      segments: 1,
    });
  });

  test("contiguous weather rows merge into one window", () => {
    const breakdown = [
      row("2026-02-01T00:00:00Z", "2026-02-03T00:00:00Z", "weather_delay", 48),
      row("2026-02-03T00:00:00Z", "2026-02-06T00:00:00Z", "weather_delay", 72),
      row("2026-02-06T00:00:00Z", "2026-02-06T12:00:00Z", "weather_delay", 12),
    ];
    expect(longestContinuousWeatherDelay(breakdown)).toEqual({
      hours: 132,
      start: "2026-02-01T00:00:00Z",
      end: "2026-02-06T12:00:00Z",
      segments: 3,
    });
  });

  test("an intervening laytime row breaks continuity", () => {
    const breakdown = [
      row("2026-02-01T00:00:00Z", "2026-02-03T00:00:00Z", "weather_delay", 48),
      row("2026-02-03T00:00:00Z", "2026-02-03T06:00:00Z", "laytime", 6),
      row("2026-02-03T06:00:00Z", "2026-02-06T06:00:00Z", "weather_delay", 72),
    ];
    const r = longestContinuousWeatherDelay(breakdown);
    expect(r?.hours).toBe(72); // the second, longer run — not 120
    expect(r?.start).toBe("2026-02-03T06:00:00Z");
    expect(r?.segments).toBe(1);
  });

  test("differing timestamp formats for the same instant stay contiguous", () => {
    const breakdown = [
      row("2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z", "weather_delay", 24),
      row("2026-02-02T00:00:00+00:00", "2026-02-03T00:00:00+00:00", "weather_delay", 24),
    ];
    expect(longestContinuousWeatherDelay(breakdown)?.hours).toBe(48);
  });

  test("a real gap between weather rows splits the window", () => {
    const breakdown = [
      row("2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z", "weather_delay", 24),
      // 2h unexplained gap — must not merge
      row("2026-02-02T02:00:00Z", "2026-02-03T02:00:00Z", "weather_delay", 24),
    ];
    const r = longestContinuousWeatherDelay(breakdown);
    expect(r?.hours).toBe(24);
    expect(r?.segments).toBe(1);
  });
});

describe("detectParametricTrigger", () => {
  const fiveDayStorm = [
    row("2026-02-01T00:00:00Z", "2026-02-03T12:00:00Z", "weather_delay", 60),
    row("2026-02-03T12:00:00Z", "2026-02-06T00:00:00Z", "weather_delay", 60),
  ];

  test("fires at exactly the threshold", () => {
    const r = detectParametricTrigger(fiveDayStorm, 120);
    expect(r).not.toBeNull();
    expect(r?.hours).toBe(120);
  });

  test("does not fire just under the threshold", () => {
    expect(detectParametricTrigger(fiveDayStorm, 120.1)).toBeNull();
  });

  test("does not fire when runs are long in total but broken", () => {
    const broken = [
      row("2026-02-01T00:00:00Z", "2026-02-03T12:00:00Z", "weather_delay", 60),
      row("2026-02-03T12:00:00Z", "2026-02-03T13:00:00Z", "laytime", 1),
      row("2026-02-03T13:00:00Z", "2026-02-06T01:00:00Z", "weather_delay", 60),
    ];
    expect(detectParametricTrigger(broken, 120)).toBeNull();
  });

  test("empty breakdown never fires", () => {
    expect(detectParametricTrigger([], 1)).toBeNull();
  });
});
