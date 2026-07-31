import { describe, expect, test } from "bun:test";
import type { SofEventInput } from "@/lib/laytime/types";
import {
  computeAchievedRate,
  computeWorkingTime,
  parseCargoQuantity,
} from "@/lib/efficiency/cargo-rate";

const ev = (at: string, type: string): SofEventInput =>
  ({ id: at + type, occurred_at: at, event_type: type }) as SofEventInput;

describe("parseCargoQuantity", () => {
  test("reads the common operator formats", () => {
    expect(parseCargoQuantity("Soybeans, 54,000 MT")?.tonnes).toBe(54000);
    expect(parseCargoQuantity("Iron Ore Fines 165000 MT")?.tonnes).toBe(165000);
    expect(parseCargoQuantity("Wheat 12 500 t")?.tonnes).toBe(12500);
    expect(parseCargoQuantity("Coal 82.5 kt")?.tonnes).toBe(82500);
    expect(parseCargoQuantity("Bauxite 30,000 tonnes")?.tonnes).toBe(30000);
  });

  test("returns null when there is no quantity to read", () => {
    // A rate from a misread tonnage looks authoritative and is wrong by
    // whatever factor the misread was — null is the safer answer.
    expect(parseCargoQuantity("Wheat in bulk")).toBeNull();
    expect(parseCargoQuantity("Steel coils")).toBeNull();
    expect(parseCargoQuantity("")).toBeNull();
    expect(parseCargoQuantity(null)).toBeNull();
  });

  test("flags an ambiguous description rather than picking silently", () => {
    // "50,000/55,000 MT" is a range with a tolerance, not a settled figure.
    const r = parseCargoQuantity("Grain 50,000 MT / 55,000 MT");
    expect(r).not.toBeNull();
    expect(r!.confident).toBe(false);
  });

  test("a single quantity is confident", () => {
    expect(parseCargoQuantity("Soybeans, 54,000 MT")!.confident).toBe(true);
  });

  test("keeps the source text so a reader can check the parse", () => {
    expect(parseCargoQuantity("Soybeans, 54,000 MT")!.raw).toContain("54,000");
  });

  test("ignores numbers with no mass unit", () => {
    expect(parseCargoQuantity("Grain in 5 holds")).toBeNull();
  });
});

describe("computeWorkingTime", () => {
  const base = [
    ev("2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
    ev("2026-03-03T00:00:00Z", "COMPLETED_LOADING"),
  ];

  test("measures the operations window", () => {
    const w = computeWorkingTime(base)!;
    expect(w.grossHours).toBe(48);
    expect(w.netHours).toBe(48);
  });

  test("subtracts weather, shifting and excepted periods", () => {
    const w = computeWorkingTime([
      ...base,
      ev("2026-03-01T06:00:00Z", "WEATHER_DELAY"),
      ev("2026-03-01T10:00:00Z", "WEATHER_DELAY_END"),
      ev("2026-03-02T00:00:00Z", "SHIFTING"),
      ev("2026-03-02T02:00:00Z", "SHIFTING_END"),
    ])!;
    expect(w.interruptions.weatherHours).toBe(4);
    expect(w.interruptions.shiftingHours).toBe(2);
    expect(w.netHours).toBe(42);
  });

  test("clips an interruption that began before cargo started", () => {
    // Otherwise the terminal is credited with time it never had.
    const w = computeWorkingTime([
      ...base,
      ev("2026-02-28T20:00:00Z", "WEATHER_DELAY"),
      ev("2026-03-01T04:00:00Z", "WEATHER_DELAY_END"),
    ])!;
    expect(w.interruptions.weatherHours).toBe(4);
    expect(w.netHours).toBe(44);
  });

  test("never returns a negative working span", () => {
    // Overlapping pairs could otherwise subtract more than the window holds.
    const w = computeWorkingTime([
      ev("2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
      ev("2026-03-01T10:00:00Z", "COMPLETED_LOADING"),
      ev("2026-03-01T00:00:00Z", "WEATHER_DELAY"),
      ev("2026-03-01T10:00:00Z", "WEATHER_DELAY_END"),
      ev("2026-03-01T01:00:00Z", "SHIFTING"),
      ev("2026-03-01T09:00:00Z", "SHIFTING_END"),
    ])!;
    expect(w.netHours).toBe(0);
  });

  test("uses the FIRST commencement and the LAST completion", () => {
    const w = computeWorkingTime([
      ev("2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
      ev("2026-03-01T12:00:00Z", "COMPLETED_LOADING"),
      ev("2026-03-02T00:00:00Z", "COMMENCED_LOADING"),
      ev("2026-03-03T00:00:00Z", "COMPLETED_LOADING"),
    ])!;
    // 1 Mar 00:00 -> 3 Mar 00:00 spans the gap between the two stints.
    expect(w.grossHours).toBe(48);
  });

  test("handles discharge as well as loading", () => {
    expect(
      computeWorkingTime([
        ev("2026-03-01T00:00:00Z", "COMMENCED_DISCHARGE"),
        ev("2026-03-02T00:00:00Z", "COMPLETED_DISCHARGE"),
      ])!.grossHours
    ).toBe(24);
  });

  test("returns null without a complete operations window", () => {
    expect(computeWorkingTime([ev("2026-03-01T00:00:00Z", "COMMENCED_LOADING")])).toBeNull();
    expect(computeWorkingTime([])).toBeNull();
    // Completion before commencement is not a window.
    expect(
      computeWorkingTime([
        ev("2026-03-02T00:00:00Z", "COMMENCED_LOADING"),
        ev("2026-03-01T00:00:00Z", "COMPLETED_LOADING"),
      ])
    ).toBeNull();
  });
});

describe("computeAchievedRate", () => {
  const events = [
    ev("2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
    ev("2026-03-03T00:00:00Z", "COMPLETED_LOADING"),
    ev("2026-03-01T06:00:00Z", "WEATHER_DELAY"),
    ev("2026-03-01T18:00:00Z", "WEATHER_DELAY_END"),
  ];

  test("net rate excludes weather; gross rate does not", () => {
    // 48h gross, 36h net, 36,000 MT.
    const net = computeAchievedRate("Grain 36,000 MT", events, "net")!;
    const gross = computeAchievedRate("Grain 36,000 MT", events, "gross")!;

    expect(net.tonnesPerDay).toBeCloseTo(24000, 0); // 36,000 / 1.5 days
    expect(gross.tonnesPerDay).toBeCloseTo(18000, 0); // 36,000 / 2 days
    // The distinction matters: a "per weather working day" rate must be
    // compared against the net figure, or a storm indicts the terminal.
    expect(net.tonnesPerDay).toBeGreaterThan(gross.tonnesPerDay);
  });

  test("returns null when either half of the ratio is missing", () => {
    expect(computeAchievedRate("Wheat in bulk", events)).toBeNull();
    expect(computeAchievedRate("Grain 36,000 MT", [])).toBeNull();
  });

  test("returns null rather than dividing by zero working time", () => {
    const allWeather = [
      ev("2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
      ev("2026-03-01T10:00:00Z", "COMPLETED_LOADING"),
      ev("2026-03-01T00:00:00Z", "WEATHER_DELAY"),
      ev("2026-03-01T10:00:00Z", "WEATHER_DELAY_END"),
    ];
    expect(computeAchievedRate("Grain 36,000 MT", allWeather, "net")).toBeNull();
  });

  test("carries the quantity and working time for audit", () => {
    const r = computeAchievedRate("Grain 36,000 MT", events)!;
    expect(r.quantity.tonnes).toBe(36000);
    expect(r.workingTime.interruptions.weatherHours).toBe(12);
  });
});
