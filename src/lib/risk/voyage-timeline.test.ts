import { describe, expect, test } from "bun:test";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import { synthesizeVoyageTimeline } from "@/lib/risk/voyage-timeline";
import type { CpTerms } from "@/lib/laytime/types";

const CP: CpTerms = {
  laytime_allowed_hours: 6,
  turn_time_hours: 0,
  nor_variant: "WIBON",
  days_basis: "WWDSHEX-EIU",
  demurrage_rate: 24000,
  despatch_rate: 12000,
  currency: "USD",
} as CpTerms;

describe("synthesizeVoyageTimeline", () => {
  test("places NOR, berthing and ops at the sampled offsets", () => {
    const events = synthesizeVoyageTimeline({
      startISO: "2026-03-04T00:00:00.000Z",
      waitingHours: 10,
      berthToOpsHours: 2,
      stoppageFlags: Array(60).fill(false),
      opsDurationHours: 4,
    });

    expect(events[0]).toMatchObject({
      event_type: "NOR_TENDERED",
      occurred_at: "2026-03-04T00:00:00.000Z",
    });
    expect(events[1]).toMatchObject({
      event_type: "ALL_FAST",
      occurred_at: "2026-03-04T10:00:00.000Z",
    });
    expect(events[2]).toMatchObject({
      event_type: "COMMENCED_LOADING",
      occurred_at: "2026-03-04T12:00:00.000Z",
    });
    // 4 working hours from hour 12 → completes at 16:00.
    expect(events[events.length - 1]).toMatchObject({
      event_type: "COMPLETED_LOADING",
      occurred_at: "2026-03-04T16:00:00.000Z",
    });
  });

  test("pauses work during stoppages and pairs the weather events", () => {
    const flags = Array(40).fill(false);
    flags[5] = true;
    flags[6] = true;
    const events = synthesizeVoyageTimeline({
      startISO: "2026-03-04T06:00:00.000Z",
      waitingHours: 2,
      berthToOpsHours: 1,
      stoppageFlags: flags,
      opsDurationHours: 6,
    });

    expect(events.map((e) => e.event_type)).toEqual([
      "NOR_TENDERED",
      "ALL_FAST",
      "COMMENCED_LOADING",
      "WEATHER_DELAY",
      "WEATHER_DELAY_END",
      "COMPLETED_LOADING",
    ]);
    // 6 working hours + 2 stopped, from hour 3 → hour 11.
    expect(events[events.length - 1].occurred_at).toBe("2026-03-04T17:00:00.000Z");

    // And the engine consumes it directly.
    const totals = recomputeLaytime(events, CP).totals;
    expect(totals.used_hours).toBe(9);
    expect(totals.time_on_demurrage_hours).toBe(3);
  });

  test("closes a stoppage still running when cargo finishes", () => {
    const flags = Array(10).fill(false);
    for (let i = 4; i < 10; i++) flags[i] = true;
    const events = synthesizeVoyageTimeline({
      startISO: "2026-03-04T06:00:00.000Z",
      waitingHours: 2,
      berthToOpsHours: 1,
      stoppageFlags: flags,
      opsDurationHours: 3,
    });
    const types = events.map((e) => e.event_type);
    expect(types.filter((t) => t === "WEATHER_DELAY").length).toBe(
      types.filter((t) => t === "WEATHER_DELAY_END").length
    );
    expect(types[types.length - 1]).toBe("COMPLETED_LOADING");
    // An unterminated interruption would make the engine exclude everything
    // after it, so this pairing is load-bearing rather than cosmetic.
    expect(() => recomputeLaytime(events, CP)).not.toThrow();
  });

  test("emits the discharge pair when asked", () => {
    const events = synthesizeVoyageTimeline({
      startISO: "2026-03-04T00:00:00.000Z",
      waitingHours: 1,
      berthToOpsHours: 1,
      stoppageFlags: Array(20).fill(false),
      opsDurationHours: 3,
      operation: "discharge",
    });
    const types = events.map((e) => e.event_type);
    expect(types).toContain("COMMENCED_DISCHARGE");
    expect(types).toContain("COMPLETED_DISCHARGE");
    expect(types).not.toContain("COMMENCED_LOADING");
  });

  test("hours past the flag array count as workable, not as unknown weather", () => {
    // The array runs out at 10 but 8 hours of work are needed from hour 2.
    const events = synthesizeVoyageTimeline({
      startISO: "2026-03-04T00:00:00.000Z",
      waitingHours: 1,
      berthToOpsHours: 1,
      stoppageFlags: Array(10).fill(false),
      opsDurationHours: 8,
    });
    expect(events[events.length - 1].occurred_at).toBe("2026-03-04T10:00:00.000Z");
  });

  test("rounds fractional durations to the engine's hourly resolution", () => {
    const events = synthesizeVoyageTimeline({
      startISO: "2026-03-04T00:00:00.000Z",
      waitingHours: 2.4,
      berthToOpsHours: 0.6,
      stoppageFlags: Array(20).fill(false),
      opsDurationHours: 2,
    });
    expect(events[1].occurred_at).toBe("2026-03-04T02:00:00.000Z"); // 2.4 → 2
    expect(events[2].occurred_at).toBe("2026-03-04T03:00:00.000Z"); // +1
  });

  test("a zero wait berths on arrival", () => {
    const events = synthesizeVoyageTimeline({
      startISO: "2026-03-04T00:00:00.000Z",
      waitingHours: 0,
      berthToOpsHours: 0,
      stoppageFlags: Array(20).fill(false),
      opsDurationHours: 2,
    });
    expect(events[0].occurred_at).toBe(events[1].occurred_at);
    expect(events[1].occurred_at).toBe(events[2].occurred_at);
  });

  test("negative inputs are clamped rather than reversing the timeline", () => {
    const events = synthesizeVoyageTimeline({
      startISO: "2026-03-04T00:00:00.000Z",
      waitingHours: -5,
      berthToOpsHours: -2,
      stoppageFlags: Array(20).fill(false),
      opsDurationHours: 2,
    });
    expect(new Date(events[1].occurred_at).getTime()).toBeGreaterThanOrEqual(
      new Date(events[0].occurred_at).getTime()
    );
  });
});
