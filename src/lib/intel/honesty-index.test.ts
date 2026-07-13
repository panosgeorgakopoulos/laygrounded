/// <reference types="bun-types" />
// Run with: bun test src/lib/intel/honesty-index.test.ts

import { describe, expect, test } from "bun:test";
import {
  MIN_DECISIVE_CHECKS,
  scoreHonesty,
  type HonestyIndexRow,
  type HonestyScore,
} from "./honesty-index";

const row = (overrides: Partial<HonestyIndexRow> = {}): HonestyIndexRow => ({
  subject_type: "port",
  subject_key: "rotterdam",
  subject_label: "Rotterdam",
  check_type: "weather",
  total_checks: 24,
  decisive_checks: 20,
  contradicted_checks: 0,
  corroborated_checks: 20,
  claims_covered: 12,
  last_checked_at: "2026-07-10T08:00:00+00:00",
  ...overrides,
});

describe("scoreHonesty bands", () => {
  const cases: Array<{
    name: string;
    decisive: number;
    contradicted: number;
    band: HonestyScore["band"];
    rate: number | null;
  }> = [
    {
      name: "just below the k-anonymity floor is insufficient_data even at 100% contradicted",
      decisive: MIN_DECISIVE_CHECKS - 1,
      contradicted: MIN_DECISIVE_CHECKS - 1,
      band: "insufficient_data",
      rate: null,
    },
    {
      name: "exactly at the floor with zero contradictions is clean",
      decisive: MIN_DECISIVE_CHECKS,
      contradicted: 0,
      band: "clean",
      rate: 0,
    },
    {
      name: "exactly at the floor and fully contradicted is high_risk",
      decisive: MIN_DECISIVE_CHECKS,
      contradicted: MIN_DECISIVE_CHECKS,
      band: "high_risk",
      rate: 1,
    },
    {
      name: "just under 10% stays clean",
      decisive: 100,
      contradicted: 9,
      band: "clean",
      rate: 0.09,
    },
    {
      name: "exactly 10% crosses into caution",
      decisive: 10,
      contradicted: 1,
      band: "caution",
      rate: 0.1,
    },
    {
      name: "just under 30% stays caution",
      decisive: 100,
      contradicted: 29,
      band: "caution",
      rate: 0.29,
    },
    {
      name: "exactly 30% crosses into high_risk",
      decisive: 10,
      contradicted: 3,
      band: "high_risk",
      rate: 0.3,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const score = scoreHonesty(
        row({ decisive_checks: c.decisive, contradicted_checks: c.contradicted })
      );
      expect(score.band).toBe(c.band);
      if (c.rate === null) {
        expect(score.falseClaimRate).toBeNull();
      } else {
        expect(score.falseClaimRate).toBeCloseTo(c.rate, 10);
      }
    });
  }

  test("rate is contradicted over decisive, not over total", () => {
    const score = scoreHonesty(
      row({
        total_checks: 100, // inconclusive/unavailable must not dilute the rate
        decisive_checks: 8,
        contradicted_checks: 3,
        corroborated_checks: 5,
      })
    );
    expect(score.falseClaimRate).toBeCloseTo(3 / 8, 10);
    expect(score.band).toBe("high_risk");
  });
});

describe("scoreHonesty warnings", () => {
  test("port + weather high_risk produces the terminal weather warning", () => {
    const score = scoreHonesty(
      row({
        subject_type: "port",
        subject_label: "Santos",
        check_type: "weather",
        decisive_checks: 50,
        contradicted_checks: 19,
        claims_covered: 30,
      })
    );
    expect(score.band).toBe("high_risk");
    expect(score.warning).toBe(
      "Terminal Santos's weather delay claims were contradicted by " +
        "independent archive data 38% of the time (19 of 50 checks across 30 claims)."
    );
  });

  test("agent + position caution produces the agent NOR-position warning", () => {
    const score = scoreHonesty(
      row({
        subject_type: "agent",
        subject_key: "baltic chartering co",
        subject_label: "Baltic Chartering Co",
        check_type: "position",
        decisive_checks: 10,
        contradicted_checks: 2,
        corroborated_checks: 8,
        claims_covered: 7,
      })
    );
    expect(score.band).toBe("caution");
    expect(score.warning).toBe(
      "Agent Baltic Chartering Co's NOR position claims were contradicted by " +
        "independent AIS data 20% of the time (2 of 10 checks across 7 claims)."
    );
  });

  test("clean subjects carry no warning", () => {
    const score = scoreHonesty(
      row({ decisive_checks: 40, contradicted_checks: 2, corroborated_checks: 38 })
    );
    expect(score.band).toBe("clean");
    expect(score.warning).toBeNull();
  });
});

describe("scoreHonesty insufficient_data suppression", () => {
  test("suppresses rate and warning but keeps counts and identity fields", () => {
    const score = scoreHonesty(
      row({
        subject_type: "agent",
        subject_label: "Lone Voyage Agencies",
        check_type: "position",
        total_checks: 4,
        decisive_checks: 3,
        contradicted_checks: 3,
        corroborated_checks: 0,
        claims_covered: 2,
      })
    );
    expect(score.band).toBe("insufficient_data");
    expect(score.falseClaimRate).toBeNull();
    expect(score.warning).toBeNull();
    expect(score.decisiveChecks).toBe(3);
    expect(score.contradictedChecks).toBe(3);
    expect(score.claimsCovered).toBe(2);
    expect(score.subjectType).toBe("agent");
    expect(score.subjectLabel).toBe("Lone Voyage Agencies");
    expect(score.checkType).toBe("position");
  });

  test("zero decisive checks (all inconclusive/unavailable) is insufficient_data", () => {
    const score = scoreHonesty(
      row({
        total_checks: 12,
        decisive_checks: 0,
        contradicted_checks: 0,
        corroborated_checks: 0,
      })
    );
    expect(score.band).toBe("insufficient_data");
    expect(score.falseClaimRate).toBeNull();
    expect(score.warning).toBeNull();
  });
});
