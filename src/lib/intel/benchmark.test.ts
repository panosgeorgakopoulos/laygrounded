import { describe, expect, test } from "bun:test";
import {
  benchmarkMetric,
  buildBenchmarkReport,
  BENCHMARK_SPECS,
  MIN_MARKET_COMPANIES,
  MIN_OWN_OBSERVATIONS,
  type Observation,
} from "./benchmark";

const WAITING = BENCHMARK_SPECS.waiting_hours; // lower is better
const RECOVERY = BENCHMARK_SPECS.recovery_rate; // higher is better

function obs(companyId: string, values: number[]): Observation[] {
  return values.map((value) => ({ companyId, value }));
}

/** Market rows spread across enough distinct companies to clear the floor. */
function market(values: number[], companies = MIN_MARKET_COMPANIES): Observation[] {
  return values.map((value, i) => ({ companyId: `other-${i % companies}`, value }));
}

describe("own-company exclusion", () => {
  test("your rows never enter the market baseline", () => {
    // Your 100s would drag a naive market median far above the real 10.
    const result = benchmarkMetric(
      WAITING,
      [...obs("me", [100, 100, 100]), ...market([10, 10, 10, 10, 10, 10])],
      "me",
    );
    expect(result.market).toBe(10);
    expect(result.yours).toBe(100);
    expect(result.marketObservations).toBe(6);
  });

  test("a lane that is only you yields no market figure", () => {
    // Otherwise you would be benchmarked against yourself and always look average.
    const result = benchmarkMetric(WAITING, obs("me", [10, 20, 30]), "me");
    expect(result.verdict).toBe("insufficient_data");
    expect(result.market).toBeNull();
    expect(result.yours).toBe(20);
    expect(result.note).toContain("independent companies");
  });
});

describe("k-anonymity on the market side", () => {
  test("too few distinct companies withholds the market figure", () => {
    const result = benchmarkMetric(
      WAITING,
      [...obs("me", [10, 10, 10]), ...market([5, 5, 5, 5], 2)],
      "me",
    );
    expect(result.verdict).toBe("insufficient_data");
    expect(result.market).toBeNull();
    expect(result.marketCompanies).toBe(2);
  });

  test("your own figure is still shown when the market is withheld", () => {
    const result = benchmarkMetric(
      WAITING,
      [...obs("me", [12, 14, 16]), ...market([5, 5], 1)],
      "me",
    );
    expect(result.yours).toBe(14);
    expect(result.market).toBeNull();
  });

  test("enough companies publishes the comparison", () => {
    const result = benchmarkMetric(
      WAITING,
      [...obs("me", [10, 10, 10]), ...market([20, 20, 20, 20, 20, 20])],
      "me",
    );
    expect(result.verdict).not.toBe("insufficient_data");
    expect(result.market).toBe(20);
  });
});

describe("thin own-side data", () => {
  test("below the own-observation floor reports nothing", () => {
    const result = benchmarkMetric(
      WAITING,
      [...obs("me", [10]), ...market([20, 20, 20, 20, 20, 20])],
      "me",
    );
    expect(result.verdict).toBe("insufficient_data");
    expect(result.yours).toBeNull();
    expect(result.note).toContain(`${MIN_OWN_OBSERVATIONS}`);
  });
});

describe("advantage direction", () => {
  test("waiting less than the market is an advantage, despite the lower number", () => {
    const result = benchmarkMetric(
      WAITING,
      [...obs("me", [10, 10, 10]), ...market([20, 20, 20, 20, 20, 20])],
      "me",
    );
    expect(result.verdict).toBe("ahead");
    expect(result.advantagePct).toBe(50);
  });

  test("waiting more than the market is a disadvantage", () => {
    const result = benchmarkMetric(
      WAITING,
      [...obs("me", [30, 30, 30]), ...market([20, 20, 20, 20, 20, 20])],
      "me",
    );
    expect(result.verdict).toBe("behind");
    expect(result.advantagePct).toBe(-50);
  });

  test("recovering more than the market is an advantage, with the sign the same way up", () => {
    const result = benchmarkMetric(
      RECOVERY,
      [...obs("me", [90, 90, 90]), ...market([60, 60, 60, 60, 60, 60])],
      "me",
    );
    expect(result.verdict).toBe("ahead");
    expect(result.advantagePct).toBe(50);
  });

  test("recovering less than the market is a disadvantage", () => {
    const result = benchmarkMetric(
      RECOVERY,
      [...obs("me", [30, 30, 30]), ...market([60, 60, 60, 60, 60, 60])],
      "me",
    );
    expect(result.verdict).toBe("behind");
  });

  test("a small gap is inline, not a finding", () => {
    const result = benchmarkMetric(
      WAITING,
      [...obs("me", [20, 20, 20]), ...market([21, 21, 21, 21, 21, 21])],
      "me",
    );
    expect(result.verdict).toBe("inline");
  });

  test("a zero market median cannot produce a divide-by-zero", () => {
    const result = benchmarkMetric(
      WAITING,
      [...obs("me", [5, 5, 5]), ...market([0, 0, 0, 0, 0, 0])],
      "me",
    );
    expect(result.advantagePct).toBeNull();
    expect(result.verdict).toBe("inline");
  });
});

describe("report assembly", () => {
  test("every configured metric is reported, including unavailable ones", () => {
    const report = buildBenchmarkReport({}, "me");
    expect(report.metrics).toHaveLength(Object.keys(BENCHMARK_SPECS).length);
    expect(report.metrics.every((m) => m.verdict === "insufficient_data")).toBe(true);
    // An unavailable metric must always explain itself.
    expect(report.metrics.every((m) => m.note !== null)).toBe(true);
  });

  test("no company id leaks into the report", () => {
    const report = buildBenchmarkReport(
      {
        waiting_hours: [...obs("me", [10, 10, 10]), ...market([20, 20, 20, 20, 20, 20])],
      },
      "me",
    );
    expect(JSON.stringify(report)).not.toContain("other-");
    expect(JSON.stringify(report)).not.toContain('"me"');
  });
});
