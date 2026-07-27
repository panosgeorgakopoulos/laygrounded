import { describe, expect, test } from "bun:test";
import { recomputeLaytime } from "./gencon94";
import type { CpTerms, SofEventInput } from "./types";

// The engine must be a function of the event SET, not of the array order it
// arrived in. This is the property an offline verifier rests on: a third party
// re-running a claim from a signed bundle has no way to reproduce whatever order
// a Postgres heap scan happened to return on the day.
//
// Before the canonical ordering existed, the specimen below computed 48 used
// hours in one array order and 60 in the other — the same facts, twelve hours
// apart, decided by nothing.

const TERMS: CpTerms = {
  cp_form: "GENCON94",
  laytime_allowed_hours: 96,
  turn_time_hours: 0,
  nor_variant: "WIBON",
  days_basis: "WWDSHEX-EIU",
  demurrage_rate: 24_000,
  despatch_rate: 12_000,
  currency: "USD",
  port_timezone: "UTC",
};

// w1e (a terminator) and w2 (an initiator) fall at the SAME instant.
const EVENTS: SofEventInput[] = [
  { id: "nor", occurred_at: "2026-03-02T00:00:00Z", event_type: "NOR_TENDERED" },
  { id: "fast", occurred_at: "2026-03-02T01:00:00Z", event_type: "ALL_FAST" },
  { id: "s", occurred_at: "2026-03-02T02:00:00Z", event_type: "COMMENCED_LOADING" },
  { id: "w1", occurred_at: "2026-03-03T06:00:00Z", event_type: "WEATHER_DELAY" },
  { id: "w1e", occurred_at: "2026-03-03T18:00:00Z", event_type: "WEATHER_DELAY_END" },
  { id: "w2", occurred_at: "2026-03-03T18:00:00Z", event_type: "WEATHER_DELAY" },
  { id: "w2e", occurred_at: "2026-03-04T06:00:00Z", event_type: "WEATHER_DELAY_END" },
  { id: "e", occurred_at: "2026-03-05T00:00:00Z", event_type: "COMPLETED_LOADING" },
];

function run(events: SofEventInput[]) {
  return JSON.stringify(recomputeLaytime(events, TERMS));
}

function swap(events: SofEventInput[], i: number, j: number): SofEventInput[] {
  const copy = [...events];
  [copy[i], copy[j]] = [copy[j], copy[i]];
  return copy;
}

describe("order independence", () => {
  test("swapping two events at the same instant changes nothing", () => {
    // Index 4 = w1e (terminator), index 5 = w2 (initiator).
    expect(run(swap(EVENTS, 4, 5))).toBe(run(EVENTS));
  });

  test("a reversed input array gives the identical result", () => {
    expect(run([...EVENTS].reverse())).toBe(run(EVENTS));
  });

  test("every rotation of the input agrees", () => {
    const baseline = run(EVENTS);
    for (let i = 1; i < EVENTS.length; i++) {
      const rotated = [...EVENTS.slice(i), ...EVENTS.slice(0, i)];
      expect(run(rotated), `rotation by ${i} diverged`).toBe(baseline);
    }
  });

  test("many shuffles all agree — no ordering escapes the canonical sort", () => {
    const baseline = run(EVENTS);
    // Deterministic pseudo-shuffle so a failure is reproducible.
    let seed = 20260726;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 200; trial++) {
      const shuffled = [...EVENTS];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(run(shuffled), `shuffle ${trial} diverged`).toBe(baseline);
    }
  });

  test("the caller's array is not mutated", () => {
    // The engine sorts a copy: a caller that reuses its own array must not find
    // it silently reordered underneath.
    const original = EVENTS.map((e) => e.id);
    run(EVENTS);
    expect(EVENTS.map((e) => e.id)).toEqual(original);
  });
});

describe("terminators resolve before initiators at the same instant", () => {
  test("both stoppages survive, rather than one being swallowed", () => {
    // Pairing the initiator first would discard it (one is already open) and
    // then discard its terminator (none is open), losing a recorded stoppage
    // and 12 hours of exclusion with it.
    const result = recomputeLaytime(EVENTS, TERMS);
    const weatherHours = result.breakdown
      .filter((r) => r.status === "weather_delay")
      .reduce((sum, r) => sum + r.duration_hours, 0);
    expect(weatherHours).toBe(24);
  });
});
