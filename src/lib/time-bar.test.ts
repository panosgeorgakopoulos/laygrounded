/// <reference types="bun-types" />
// Run with: bun test src/lib/time-bar.test.ts

import { describe, it, expect } from "bun:test";
import { computeTimeBar } from "./time-bar";

const baseInputs = {
  timeBarDays: 90,
  hasSofDocument: true,
  hasValidCpTerms: true,
  hasCalculation: true,
};

describe("computeTimeBar", () => {
  it("anchors on the latest completion event and counts down", () => {
    const status = computeTimeBar({
      ...baseInputs,
      events: [
        { event_type: "NOR_TENDERED", occurred_at: "2026-06-01T08:00:00Z" },
        { event_type: "COMPLETED_LOADING", occurred_at: "2026-06-03T10:00:00Z" },
        { event_type: "COMPLETED_DISCHARGE", occurred_at: "2026-06-20T10:00:00Z" },
      ],
      now: new Date("2026-07-01T00:00:00Z"),
    });

    expect(status.anchorEventAt).toBe("2026-06-20T10:00:00.000Z");
    expect(status.deadline).toBe("2026-09-18T10:00:00.000Z");
    expect(status.daysRemaining).toBe(79);
    expect(status.state).toBe("ok");
    expect(status.complete).toBe(true);
  });

  it("escalates to warning, critical, and expired near the deadline", () => {
    const events = [
      { event_type: "NOR_TENDERED", occurred_at: "2026-01-01T00:00:00Z" },
      { event_type: "COMPLETED_DISCHARGE", occurred_at: "2026-01-10T00:00:00Z" },
    ];
    // Deadline: 2026-04-10.
    const at = (d: string) =>
      computeTimeBar({ ...baseInputs, events, now: new Date(d) }).state;

    expect(at("2026-03-01T00:00:00Z")).toBe("ok");
    expect(at("2026-03-25T00:00:00Z")).toBe("warning");
    expect(at("2026-04-05T00:00:00Z")).toBe("critical");
    expect(at("2026-04-11T00:00:01Z")).toBe("expired");
  });

  it("reports no_anchor and missing checklist items without completion", () => {
    const status = computeTimeBar({
      timeBarDays: 90,
      hasSofDocument: false,
      hasValidCpTerms: true,
      hasCalculation: false,
      events: [{ event_type: "NOR_TENDERED", occurred_at: "2026-06-01T08:00:00Z" }],
      now: new Date("2026-07-01T00:00:00Z"),
    });

    expect(status.state).toBe("no_anchor");
    expect(status.deadline).toBeNull();
    expect(status.complete).toBe(false);
    const failing = status.completeness.filter((c) => !c.ok).map((c) => c.key);
    expect(failing).toEqual(["sof_document", "completion_event", "calculation"]);
  });
});
