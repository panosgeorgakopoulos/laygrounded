/// <reference types="bun-types" />
// Run with: bun test src/lib/simulator/fixture-risk.test.ts

import { describe, it, expect } from "bun:test";
import { deriveStoppageFlags, percentile, synthesizeVoyage } from "./fixture-risk";
import { recomputeLaytime } from "@/lib/laytime/gencon94";

describe("deriveStoppageFlags", () => {
  it("stops work on rain, gusts, or high wind — same thresholds as evidence", () => {
    const flags = deriveStoppageFlags({
      times: ["t0", "t1", "t2", "t3"],
      precipitationMm: [0, 1.2, 0, null],
      windSpeedKn: [10, 5, 21, null],
      windGustKn: [12, 8, 10, 26],
    });
    expect(flags).toEqual([false, true, true, true]);
  });
});

describe("percentile", () => {
  it("interpolates between sorted values", () => {
    expect(percentile([0, 10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([0, 10], 0.9)).toBe(9);
    expect(percentile([], 0.9)).toBe(0);
  });
});

describe("synthesizeVoyage", () => {
  it("pauses cargo work during stoppage hours and pairs weather events", () => {
    // Ops start at hour 3; hours 5-6 stopped → 2h stoppage inside a 6h job.
    const flags = Array(30).fill(false);
    flags[5] = true;
    flags[6] = true;
    const events = synthesizeVoyage("2024-03-04T06:00:00.000Z", flags, 6);

    const types = events.map((e) => e.event_type);
    expect(types).toEqual([
      "NOR_TENDERED",
      "ALL_FAST",
      "COMMENCED_LOADING",
      "WEATHER_DELAY",
      "WEATHER_DELAY_END",
      "COMPLETED_LOADING",
    ]);
    // 6 working hours + 2 stopped = completion at hour 3 + 8 = 11 → 17:00.
    expect(events[events.length - 1].occurred_at).toBe("2024-03-04T17:00:00.000Z");

    // And the engine consumes the synthetic timeline directly.
    const result = recomputeLaytime(events, {
      laytime_allowed_hours: 6,
      turn_time_hours: 0,
      nor_variant: "WIBON",
      days_basis: "WWDSHEX-EIU",
      demurrage_rate: 24000,
      despatch_rate: 12000,
      currency: "USD",
    });
    // Commences at NOR 06:00; weather 11:00-13:00 excluded under WWD;
    // counting hours: 06:00→11:00 (5h) + 13:00→17:00 (4h) = 9h vs 6 allowed.
    expect(result.totals.used_hours).toBe(9);
    expect(result.totals.time_on_demurrage_hours).toBe(3);
  });

  it("closes an open stoppage at completion", () => {
    // Storm from hour 4 onward for a while; 3 working hours needed.
    const flags = Array(10).fill(false);
    for (let i = 4; i < 10; i++) flags[i] = true;
    const events = synthesizeVoyage("2024-03-04T06:00:00.000Z", flags, 3);
    const types = events.map((e) => e.event_type);
    // hour3 work(1), hour4-9 stopped, hour10+ workable (beyond flags) → 2 more.
    expect(types).toContain("WEATHER_DELAY");
    expect(types).toContain("WEATHER_DELAY_END");
    expect(types[types.length - 1]).toBe("COMPLETED_LOADING");
  });
});
