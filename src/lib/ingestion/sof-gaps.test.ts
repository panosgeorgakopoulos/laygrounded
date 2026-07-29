import { describe, expect, test } from "bun:test";
import { detectSofGaps, DEFAULT_STALE_AFTER_HOURS, type GapKey } from "./sof-gaps";

const NOW = "2026-07-29T12:00:00Z";
/** Older than the staleness threshold, so absent milestones count as missing. */
const OLD = "2026-07-20T12:00:00Z";
/** Well inside the threshold — a voyage still in progress. */
const RECENT = "2026-07-29T09:00:00Z";

function ev(event_type: string, occurred_at: string) {
  return { event_type, occurred_at };
}

const keys = (r: { gaps: Array<{ key: GapKey }> }) => r.gaps.map((g) => g.key).sort();

describe("detectSofGaps — nothing to chase", () => {
  test("a complete stale voyage reports no gaps", () => {
    const r = detectSofGaps({
      events: [
        ev("NOR_TENDERED", "2026-07-18T06:00:00Z"),
        ev("BERTHED", "2026-07-18T12:00:00Z"),
        ev("COMMENCED_LOADING", "2026-07-19T06:00:00Z"),
        ev("COMPLETED_LOADING", OLD),
      ],
      now: NOW,
    });
    expect(r.gaps).toEqual([]);
    expect(r.blocking).toBe(false);
    expect(r.signature).toBe("");
  });

  test("a live voyage mid-operation is not chased for its missing completion", () => {
    const r = detectSofGaps({
      events: [
        ev("NOR_TENDERED", "2026-07-28T06:00:00Z"),
        ev("BERTHED", "2026-07-28T18:00:00Z"),
        ev("COMMENCED_LOADING", RECENT),
      ],
      now: NOW,
    });
    // Quiet for 3h — far inside the 48h threshold.
    expect(r.quietForHours).toBeLessThan(DEFAULT_STALE_AFTER_HOURS);
    expect(keys(r)).toEqual([]);
  });
});

describe("detectSofGaps — blocking gaps", () => {
  test("no events at all", () => {
    const r = detectSofGaps({ events: [], now: NOW });
    expect(keys(r)).toEqual(["no_events"]);
    expect(r.blocking).toBe(true);
    expect(r.quietForHours).toBeNull();
  });

  test("missing NOR is reported even on a fresh record — the engine cannot compute without it", () => {
    const r = detectSofGaps({
      events: [ev("COMMENCED_LOADING", RECENT)],
      now: NOW,
    });
    expect(keys(r)).toContain("missing_nor");
    expect(r.blocking).toBe(true);
  });

  test("commenced but never completed, once quiet", () => {
    const r = detectSofGaps({
      events: [ev("NOR_TENDERED", "2026-07-18T06:00:00Z"), ev("COMMENCED_LOADING", OLD)],
      now: NOW,
    });
    expect(keys(r)).toContain("missing_completion");
    expect(r.blocking).toBe(true);
    expect(r.gaps.find((g) => g.key === "missing_completion")!.since).toBe(OLD);
  });

  test("discharge is treated the same as loading", () => {
    const r = detectSofGaps({
      events: [ev("NOR_TENDERED", "2026-07-18T06:00:00Z"), ev("COMMENCED_DISCHARGE", OLD)],
      now: NOW,
    });
    expect(keys(r)).toContain("missing_completion");
  });
});

describe("detectSofGaps — non-blocking gaps", () => {
  test("NOR with no operations, once quiet", () => {
    const r = detectSofGaps({ events: [ev("NOR_TENDERED", OLD)], now: NOW });
    expect(keys(r)).toContain("missing_commencement");
    expect(r.gaps.find((g) => g.key === "missing_commencement")!.severity).toBe("material");
    expect(r.blocking).toBe(false);
  });

  test("operations without a berthing time is minor, not blocking", () => {
    const r = detectSofGaps({
      events: [
        ev("NOR_TENDERED", "2026-07-18T06:00:00Z"),
        ev("COMMENCED_LOADING", "2026-07-19T06:00:00Z"),
        ev("COMPLETED_LOADING", OLD),
      ],
      now: NOW,
    });
    expect(keys(r)).toEqual(["missing_berthing"]);
    expect(r.blocking).toBe(false);
  });

  test("ALL_FAST satisfies the berthing requirement", () => {
    const r = detectSofGaps({
      events: [
        ev("NOR_TENDERED", "2026-07-18T06:00:00Z"),
        ev("ALL_FAST", "2026-07-18T12:00:00Z"),
        ev("COMMENCED_LOADING", "2026-07-19T06:00:00Z"),
        ev("COMPLETED_LOADING", OLD),
      ],
      now: NOW,
    });
    expect(keys(r)).toEqual([]);
  });
});

describe("detectSofGaps — unpaired interruptions", () => {
  const complete = [
    ev("NOR_TENDERED", "2026-07-18T06:00:00Z"),
    ev("BERTHED", "2026-07-18T12:00:00Z"),
    ev("COMMENCED_LOADING", "2026-07-19T06:00:00Z"),
    ev("COMPLETED_LOADING", OLD),
  ];

  const cases: Array<{ name: string; start: string; end: string; key: GapKey }> = [
    { name: "weather", start: "WEATHER_DELAY", end: "WEATHER_DELAY_END", key: "unpaired_weather" },
    { name: "shifting", start: "SHIFTING", end: "SHIFTING_END", key: "unpaired_shifting" },
    { name: "excepted period", start: "EXCEPTED_PERIOD_START", end: "EXCEPTED_PERIOD_END", key: "unpaired_excepted" },
  ];

  for (const c of cases) {
    test(`an unclosed ${c.name} stoppage is reported`, () => {
      const r = detectSofGaps({
        events: [...complete, ev(c.start, "2026-07-19T12:00:00Z")],
        now: NOW,
      });
      expect(keys(r)).toContain(c.key);
    });

    test(`a closed ${c.name} stoppage is not`, () => {
      const r = detectSofGaps({
        events: [
          ...complete,
          ev(c.start, "2026-07-19T12:00:00Z"),
          ev(c.end, "2026-07-19T18:00:00Z"),
        ],
        now: NOW,
      });
      expect(keys(r)).not.toContain(c.key);
    });
  }

  test("reported even on a fresh record — an unclosed stoppage silently skews the figure", () => {
    const r = detectSofGaps({
      events: [
        ev("NOR_TENDERED", "2026-07-29T06:00:00Z"),
        ev("WEATHER_DELAY", RECENT),
      ],
      now: NOW,
    });
    expect(keys(r)).toContain("unpaired_weather");
  });

  test("two starts and one end leaves exactly one gap, dated to the later start", () => {
    const r = detectSofGaps({
      events: [
        ...complete,
        ev("WEATHER_DELAY", "2026-07-19T12:00:00Z"),
        ev("WEATHER_DELAY", "2026-07-19T20:00:00Z"),
        ev("WEATHER_DELAY_END", "2026-07-19T18:00:00Z"),
      ],
      now: NOW,
    });
    const weather = r.gaps.filter((g) => g.key === "unpaired_weather");
    expect(weather).toHaveLength(1);
    // Ends match starts chronologically, so the surplus is the LATER start.
    expect(weather[0].since).toBe("2026-07-19T20:00:00Z");
  });

  test("more ends than starts produces no gap rather than a negative slice", () => {
    const r = detectSofGaps({
      events: [
        ...complete,
        ev("WEATHER_DELAY", "2026-07-19T12:00:00Z"),
        ev("WEATHER_DELAY_END", "2026-07-19T18:00:00Z"),
        ev("WEATHER_DELAY_END", "2026-07-19T20:00:00Z"),
      ],
      now: NOW,
    });
    expect(keys(r)).not.toContain("unpaired_weather");
  });
});

describe("detectSofGaps — staleness", () => {
  test("quietForHours measures from the most recent event", () => {
    const r = detectSofGaps({
      events: [ev("NOR_TENDERED", "2026-07-27T12:00:00Z"), ev("BERTHED", "2026-07-28T12:00:00Z")],
      now: NOW,
    });
    expect(r.quietForHours).toBe(24);
  });

  test("a custom threshold shifts the boundary", () => {
    const events = [ev("NOR_TENDERED", "2026-07-29T00:00:00Z")];
    expect(keys(detectSofGaps({ events, now: NOW }))).toEqual([]);
    expect(keys(detectSofGaps({ events, now: NOW, staleAfterHours: 6 }))).toContain(
      "missing_commencement"
    );
  });

  test("exactly at the threshold counts as stale", () => {
    const r = detectSofGaps({
      events: [ev("NOR_TENDERED", "2026-07-27T12:00:00Z")],
      now: NOW,
      staleAfterHours: 48,
    });
    expect(r.quietForHours).toBe(48);
    expect(keys(r)).toContain("missing_commencement");
  });
});

describe("detectSofGaps — signature", () => {
  test("is stable across event reordering", () => {
    const events = [
      ev("NOR_TENDERED", "2026-07-18T06:00:00Z"),
      ev("COMMENCED_LOADING", OLD),
      ev("WEATHER_DELAY", "2026-07-19T12:00:00Z"),
    ];
    const a = detectSofGaps({ events, now: NOW }).signature;
    const b = detectSofGaps({ events: [...events].reverse(), now: NOW }).signature;
    expect(a).toBe(b);
    expect(a).not.toBe("");
  });

  test("changes when a different gap appears", () => {
    const base = [ev("NOR_TENDERED", "2026-07-18T06:00:00Z"), ev("COMMENCED_LOADING", OLD)];
    const a = detectSofGaps({ events: base, now: NOW }).signature;
    const b = detectSofGaps({
      events: [...base, ev("WEATHER_DELAY", "2026-07-19T12:00:00Z")],
      now: NOW,
    }).signature;
    expect(a).not.toBe(b);
  });

  test("is unchanged when an unrelated confirmed event is added", () => {
    // Same gap set (missing completion + missing berthing suppressed by BERTHED)
    // must yield the same signature, so a re-sweep does not re-chase.
    const a = detectSofGaps({
      events: [ev("NOR_TENDERED", "2026-07-18T06:00:00Z"), ev("BERTHED", "2026-07-18T12:00:00Z"), ev("COMMENCED_LOADING", OLD)],
      now: NOW,
    }).signature;
    const b = detectSofGaps({
      events: [ev("NOR_TENDERED", "2026-07-18T06:00:00Z"), ev("BERTHED", "2026-07-18T12:00:00Z"), ev("COMMENCED_LOADING", OLD)],
      now: "2026-07-30T12:00:00Z",
    }).signature;
    expect(a).toBe(b);
  });
});
