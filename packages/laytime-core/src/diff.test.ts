/// <reference types="bun-types" />
// Tests for the negotiation scenario differ.
// Run with: bun test src/lib/laytime/diff.test.ts

import { describe, it, expect } from "bun:test";
import { diffScenarios, applyProposals } from "./diff";
import { CpTerms, SofEventInput } from "./types";

function iso(dateStr: string): string {
  return new Date(dateStr).toISOString();
}

const cpTerms: CpTerms = {
  laytime_allowed_hours: 12,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "SHINC",
  demurrage_rate: 24000,
  despatch_rate: 12000,
  currency: "USD",
};

// Baseline: laytime commences 14:00, completes next day 16:00 → 26h used,
// 14h demurrage @ 24000/day = 14000.
const baselineEvents: SofEventInput[] = [
  { id: "nor", occurred_at: iso("2024-03-04T08:00:00Z"), event_type: "NOR_TENDERED" },
  { id: "fast", occurred_at: iso("2024-03-04T14:00:00Z"), event_type: "ALL_FAST" },
  { id: "start", occurred_at: iso("2024-03-04T16:00:00Z"), event_type: "COMMENCED_LOADING" },
  { id: "done", occurred_at: iso("2024-03-05T16:00:00Z"), event_type: "COMPLETED_LOADING" },
];

describe("diffScenarios", () => {
  it("computes the money delta when a completion time is amended earlier", () => {
    const diff = diffScenarios(baselineEvents, cpTerms, [
      {
        id: "p1",
        action: "amend",
        event_id: "done",
        proposed_occurred_at: iso("2024-03-05T12:00:00Z"),
        proposed_event_type: null,
      },
    ]);

    expect(diff.baseline!.totals.time_on_demurrage_hours).toBe(14);
    expect(diff.amended!.totals.time_on_demurrage_hours).toBe(10);
    expect(diff.delta!.used_hours).toBe(-4);
    // 4h less demurrage: 4/24 × 24000 = 4000 in the charterer's favour.
    expect(diff.delta!.demurrage_amount).toBe(-4000);
    expect(diff.delta!.net_amount).toBe(-4000);
  });

  it("reports an amended-side error without losing the baseline", () => {
    const diff = diffScenarios(baselineEvents, cpTerms, [
      {
        id: "p2",
        action: "remove",
        event_id: "nor",
        proposed_occurred_at: null,
        proposed_event_type: null,
      },
    ]);

    expect(diff.baseline).not.toBeNull();
    expect(diff.amended).toBeNull();
    expect(diff.amendedError).toMatch(/NO_NOR/);
    expect(diff.delta).toBeNull();
  });

  it("applyProposals skips stale event ids and adds new events in order", () => {
    const amended = applyProposals(baselineEvents, [
      {
        id: "p3",
        action: "amend",
        event_id: "ghost",
        proposed_occurred_at: iso("2024-03-05T00:00:00Z"),
        proposed_event_type: null,
      },
      {
        id: "p4",
        action: "add",
        event_id: null,
        proposed_occurred_at: iso("2024-03-04T20:00:00Z"),
        proposed_event_type: "WEATHER_DELAY",
      },
    ]);

    expect(amended).toHaveLength(5);
    expect(amended[3].event_type).toBe("WEATHER_DELAY");
    expect(amended[3].id).toBe("proposal-p4");
  });
});
