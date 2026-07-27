import { describe, expect, test } from "bun:test";
import { observeNonWorkingDays } from "./calendar-observation";
import type { SofEventInput } from "@/lib/laytime/types";

const ev = (id: string, at: string, type: string): SofEventInput =>
  ({ id, occurred_at: at, event_type: type }) as SofEventInput;

// Alongside from 02 March through 07 March. Cargo work runs 02–03 and resumes
// on 06, leaving 04 and 05 entirely idle.
const IDLE_MIDDLE: SofEventInput[] = [
  ev("nor", "2026-03-01T06:00:00Z", "NOR_TENDERED"),
  ev("fast", "2026-03-02T06:00:00Z", "ALL_FAST"),
  ev("s1", "2026-03-02T08:00:00Z", "COMMENCED_LOADING"),
  ev("e1", "2026-03-03T18:00:00Z", "COMPLETED_LOADING"),
  ev("s2", "2026-03-06T08:00:00Z", "COMMENCED_LOADING"),
  ev("e2", "2026-03-07T18:00:00Z", "COMPLETED_LOADING"),
];

describe("observing idle days", () => {
  test("a fully idle day inside the stay is proposed", () => {
    const dates = observeNonWorkingDays(IDLE_MIDDLE, "UTC").map((c) => c.date);
    expect(dates).toEqual(["2026-03-04", "2026-03-05"]);
  });

  test("each candidate explains itself for a reviewer", () => {
    const [first] = observeNonWorkingDays(IDLE_MIDDLE, "UTC");
    expect(first.rationale).toContain("no cargo activity");
    expect(first.observedHours).toBe(24);
  });

  test("days with cargo activity are never proposed", () => {
    const dates = observeNonWorkingDays(IDLE_MIDDLE, "UTC").map((c) => c.date);
    expect(dates).not.toContain("2026-03-02");
    expect(dates).not.toContain("2026-03-06");
  });

  test("a day spanned by an open operations interval counts as worked", () => {
    // Work runs straight through 03–05 with no events on those dates; silence
    // inside an ongoing operation is not idleness.
    const continuous = [
      ev("fast", "2026-03-02T06:00:00Z", "ALL_FAST"),
      ev("s1", "2026-03-02T08:00:00Z", "COMMENCED_LOADING"),
      ev("e1", "2026-03-06T18:00:00Z", "COMPLETED_LOADING"),
    ];
    expect(observeNonWorkingDays(continuous, "UTC")).toEqual([]);
  });
});

describe("competing explanations", () => {
  test("a weather stoppage explains the idleness, so no holiday is proposed", () => {
    const withWeather = [
      ...IDLE_MIDDLE,
      ev("w1", "2026-03-04T00:00:00Z", "WEATHER_DELAY"),
      ev("w2", "2026-03-05T23:00:00Z", "WEATHER_DELAY_END"),
    ];
    expect(observeNonWorkingDays(withWeather, "UTC")).toEqual([]);
  });

  test("a shifting period likewise suppresses the proposal", () => {
    const withShifting = [
      ...IDLE_MIDDLE,
      ev("sh1", "2026-03-04T00:00:00Z", "SHIFTING"),
      ev("sh2", "2026-03-04T23:00:00Z", "SHIFTING_END"),
    ];
    expect(observeNonWorkingDays(withShifting, "UTC").map((c) => c.date)).toEqual([
      "2026-03-05",
    ]);
  });
});

describe("scope limits", () => {
  test("partial days at the edges of the stay are not evidence", () => {
    // Berthed midway through 02 March and completed midway through 04 March:
    // 02 and 04 are only partly observed, so only 03 can be judged.
    const events = [
      ev("fast", "2026-03-02T12:00:00Z", "ALL_FAST"),
      ev("e", "2026-03-04T12:00:00Z", "COMPLETED_LOADING"),
    ];
    expect(observeNonWorkingDays(events, "UTC").map((c) => c.date)).toEqual(["2026-03-03"]);
  });

  test("time before berthing is outside the observation window", () => {
    // A week at anchor says nothing about whether the port was working.
    const events = [
      ev("nor", "2026-02-20T06:00:00Z", "NOR_TENDERED"),
      ev("fast", "2026-03-02T12:00:00Z", "ALL_FAST"),
      ev("e", "2026-03-04T12:00:00Z", "COMPLETED_LOADING"),
    ];
    expect(observeNonWorkingDays(events, "UTC").map((c) => c.date)).toEqual(["2026-03-03"]);
  });

  test("no berthing or no completion yields nothing", () => {
    expect(observeNonWorkingDays([ev("nor", "2026-03-01T06:00:00Z", "NOR_TENDERED")], "UTC")).toEqual([]);
    expect(observeNonWorkingDays([ev("fast", "2026-03-02T06:00:00Z", "ALL_FAST")], "UTC")).toEqual([]);
  });

  test("an empty timeline is not an error", () => {
    expect(observeNonWorkingDays([], "UTC")).toEqual([]);
  });
});

describe("timezone", () => {
  test("idle days are judged in the port's local reckoning", () => {
    // Alongside 02 Mar 16:00Z to 06 Mar 16:00Z. In Singapore (UTC+8) that is
    // local 03 Mar 00:00 through 07 Mar 00:00, so local 03–06 are each fully
    // observed and idle, and 07 is not covered at all. Judged in UTC the same
    // stay would report 02–06, shifting every boundary by eight hours.
    const events = [
      ev("fast", "2026-03-02T16:00:00Z", "ALL_FAST"),
      ev("e", "2026-03-06T16:00:00Z", "COMPLETED_LOADING"),
    ];
    expect(observeNonWorkingDays(events, "Asia/Singapore").map((c) => c.date)).toEqual([
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
    ]);
    // The UTC reading would have included 02 March; local reckoning excludes it.
    expect(observeNonWorkingDays(events, "UTC").map((c) => c.date)).toContain("2026-03-03");
  });
});
