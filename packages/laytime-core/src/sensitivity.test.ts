/// <reference types="bun-types" />
// Run with: bun test src/lib/laytime/sensitivity.test.ts

import { describe, it, expect } from "bun:test";
import { analyzeSensitivity } from "./sensitivity";
import { CpTerms, SofEventInput } from "./types";

function iso(s: string): string {
  return new Date(s).toISOString();
}

// Demurrage claim on a WWD basis with one weather exclusion: rich attack surface.
const events: SofEventInput[] = [
  { id: "nor", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
  { id: "ops", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "COMMENCED_LOADING" },
  { id: "w1", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "WEATHER_DELAY" },
  { id: "w2", occurred_at: iso("2024-03-04T20:00:00Z"), event_type: "WEATHER_DELAY_END" },
  { id: "done", occurred_at: iso("2024-03-05T08:00:00Z"), event_type: "COMPLETED_LOADING" },
];

const wwdTerms: CpTerms = {
  laytime_allowed_hours: 4,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "WWDSHEX-EIU",
  demurrage_rate: 24000,
  despatch_rate: 12000,
  currency: "USD",
};

describe("analyzeSensitivity", () => {
  it("ranks counterparty attacks and owner opportunities by money moved", () => {
    const r = analyzeSensitivity(events, wwdTerms);

    // Baseline: 14h counting, 4 allowed → 10h demurrage = 10,000.
    expect(r.baselineNet).toBe(10000);

    // Completion 6h earlier must be a vulnerability worth 6h of demurrage.
    const completion6 = r.vulnerabilities.find(
      (v) => v.category === "completion" && v.label.includes("6h")
    );
    expect(completion6?.deltaNet).toBe(-6000);

    // Striking the weather delay converts 4 excluded hours into demurrage —
    // an owner opportunity of +4,000.
    const weatherStruck = r.opportunities.find((o) =>
      o.label.includes("struck out")
    );
    expect(weatherStruck?.deltaNet).toBe(4000);

    // Weakest point = worst single vulnerability, sorted first.
    expect(r.maxSingleLoss).toBe(r.vulnerabilities[0].deltaNet);
    expect(r.vulnerabilities[0].deltaNet).toBeLessThanOrEqual(-6000);
  });

  it("filters immaterial disputes (weather under SHINC moves nothing)", () => {
    const shincTerms: CpTerms = { ...wwdTerms, days_basis: "SHINC" };
    const r = analyzeSensitivity(events, shincTerms);
    // Under SHINC weather neither counts nor excludes — extending or striking
    // it is a worthless dispute and must not appear.
    expect(r.vulnerabilities.some((v) => v.category === "weather")).toBe(false);
    expect(r.opportunities.some((o) => o.category === "weather")).toBe(false);
  });

  it("throws NO_NOR when the baseline itself cannot compute", () => {
    expect(() =>
      analyzeSensitivity(
        events.filter((e) => e.id !== "nor"),
        wwdTerms
      )
    ).toThrow(/NO_NOR/);
  });
});
