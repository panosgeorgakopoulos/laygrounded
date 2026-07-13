import { describe, expect, test } from "bun:test";
import type { OracleVoyageStat } from "@/lib/oracle/pricing";
import {
  computeRoiSnapshot,
  computeShockIndex,
  evaluateClauseScenario,
  getPreFixtureIntelligence,
  rankEarlyWarnings,
  type ClauseScenario,
  type PortResilienceSnapshot,
  type RoiClaimInput,
} from "./predictive";

const sample = (usedHours: number, verified = true): OracleVoyageStat => ({
  month: 6,
  weatherDelayHours: 0,
  usedHours,
  allowedHours: 72,
  excessHours: Math.max(usedHours - 72, 0),
  verified,
});

const SAMPLES = [sample(60), sample(96), sample(120), sample(150)];

const SHINC_72: ClauseScenario = {
  label: "SHINC, 72h",
  daysBasis: "SHINC",
  laytimeAllowedHours: 72,
  demurrageRatePerDay: 24_000,
  turnTimeHours: 0,
};

describe("evaluateClauseScenario", () => {
  test("SHINC replay prices each voyage's excess at the daily rate", () => {
    const r = evaluateClauseScenario(SAMPLES, SHINC_72);
    expect(r.expectedLosses).toEqual([0, 24_000, 48_000, 78_000]);
    expect(r.meanLoss).toBe(37_500);
    expect(r.medianLoss).toBe(36_000);
    expect(r.p90Loss).toBe(69_000);
    expect(r.worstLoss).toBe(78_000);
    expect(r.demurrageProbability).toBe(0.75);
  });

  test("SSHEX excludes weekend share and cuts counted hours", () => {
    const r = evaluateClauseScenario(SAMPLES, { ...SHINC_72, label: "SSHEX", daysBasis: "SSHEX" });
    // counted = used × 0.71: [42.6, 68.16, 85.2, 106.5]
    expect(r.expectedLosses).toEqual([0, 0, 13_200, 34_500]);
    expect(r.meanLoss).toBe(11_925);
  });

  test("turn time is deducted before the allowance bites", () => {
    const r = evaluateClauseScenario(SAMPLES, { ...SHINC_72, turnTimeHours: 12 });
    expect(r.expectedLosses).toEqual([0, 12_000, 36_000, 66_000]);
  });

  test("empty sample yields zeroes, not NaN", () => {
    const r = evaluateClauseScenario([], SHINC_72);
    expect(r.meanLoss).toBe(0);
    expect(r.demurrageProbability).toBe(0);
  });
});

describe("computeShockIndex", () => {
  const res = (over: Partial<PortResilienceSnapshot>): PortResilienceSnapshot => ({
    portKey: "santos",
    month: 6,
    weatherContradictionRate: null,
    weatherDecisiveChecks: 0,
    medianCongestionDelayHours: null,
    p90CongestionDelayHours: null,
    voyagesObserved: 0,
    ...over,
  });

  test("blends congestion (60%) and honesty (40%)", () => {
    const idx = computeShockIndex(
      res({ medianCongestionDelayHours: 36, weatherContradictionRate: 0.25 })
    );
    expect(idx.score).toBe(40);
    expect(idx.band).toBe("moderate");
  });

  test("a missing component redistributes its weight", () => {
    const idx = computeShockIndex(res({ medianCongestionDelayHours: 36 }));
    expect(idx.score).toBe(50);
    expect(idx.band).toBe("strained");
  });

  test("congestion saturates at 72h and the worst case is critical", () => {
    const idx = computeShockIndex(
      res({ medianCongestionDelayHours: 200, weatherContradictionRate: 1 })
    );
    expect(idx.score).toBe(100);
    expect(idx.band).toBe("critical");
  });

  test("no data → insufficient_data, never a fake zero", () => {
    expect(computeShockIndex(null).band).toBe("insufficient_data");
    expect(computeShockIndex(res({})).score).toBeNull();
  });
});

describe("getPreFixtureIntelligence", () => {
  test("charterer perspective: recommends the cheaper basis with a quantified saving", () => {
    const intel = getPreFixtureIntelligence(SAMPLES, SHINC_72, { perspective: "charterer" });
    const sshexSwap = intel.clauseSwaps.find((s) => s.to === "SSHEX basis");
    expect(sshexSwap).toBeDefined();
    // mean 37,500 (SHINC) − 11,925 (SSHEX) = 25,575 saved per voyage
    expect(sshexSwap!.expectedSaving).toBe(25_575);
    expect(intel.recommendation).toContain("push for");
  });

  test("owner perspective mirrors the sign: tighter allowance earns more", () => {
    const intel = getPreFixtureIntelligence(SAMPLES, SHINC_72, { perspective: "owner" });
    const tighter = intel.clauseSwaps.find((s) => s.to === "allowance -24h");
    expect(tighter).toBeDefined();
    expect(tighter!.expectedSaving).toBe(21_000);
    const sshex = intel.clauseSwaps.find((s) => s.to === "SSHEX basis");
    expect(sshex!.expectedSaving).toBe(-25_575);
  });

  test("immaterial swaps are filtered", () => {
    const intel = getPreFixtureIntelligence(SAMPLES, SHINC_72, {
      materialityFloor: 1_000_000,
    });
    expect(intel.clauseSwaps).toHaveLength(0);
    expect(intel.recommendation).toContain("already the strongest");
  });

  test("thin history refuses to price", () => {
    expect(() => getPreFixtureIntelligence([sample(90), sample(100)], SHINC_72)).toThrow(
      "INSUFFICIENT_DATA"
    );
  });
});

describe("computeRoiSnapshot", () => {
  const NOW = new Date("2026-07-14T00:00:00Z");
  const claim = (over: Partial<RoiClaimInput>): RoiClaimInput => ({
    id: crypto.randomUUID(),
    demurrageAmount: null,
    settledAmount: null,
    settledAt: null,
    completionAt: null,
    timeBarDays: 90,
    hasCalculation: true,
    ...over,
  });

  test("maps expired value, at-risk value and settlement shortfall", () => {
    const roi = computeRoiSnapshot(
      [
        claim({ demurrageAmount: 50_000, completionAt: "2026-01-01T00:00:00Z" }), // expired
        claim({
          demurrageAmount: 30_000,
          settledAmount: 24_000,
          settledAt: "2026-06-01T00:00:00Z",
        }),
        claim({ demurrageAmount: 20_000, completionAt: "2026-04-25T00:00:00Z" }), // 10 days left
        claim({ hasCalculation: false }),
      ],
      NOW
    );
    expect(roi.totalClaimedValue).toBe(100_000);
    expect(roi.timeBarExpiredValue).toBe(50_000);
    expect(roi.atRiskValue).toBe(20_000);
    expect(roi.recoveredValue).toBe(24_000);
    expect(roi.recoveryRate).toBe(0.8);
    expect(roi.settledShortfall).toBe(6_000);
    expect(roi.estimatedLeakage).toBe(56_000);
    expect(roi.unquantifiedClaimCount).toBe(1);
    expect(roi.narrative).toContain("nobody has counted");
  });

  test("empty book gets the onboarding narrative, not zero-division", () => {
    const roi = computeRoiSnapshot([], NOW);
    expect(roi.claimCount).toBe(0);
    expect(roi.recoveryRate).toBeNull();
    expect(roi.narrative).toContain("No claims on the book yet");
  });
});

describe("rankEarlyWarnings", () => {
  test("expired high-value claims outrank pending-proposal noise; settled are skipped", () => {
    const warnings = rankEarlyWarnings([
      {
        id: "a",
        vessel: "MV ALPHA",
        voyageRef: "V1",
        demurrageAmount: 120_000,
        daysToDeadline: -3,
        contradictedEvidenceCount: 0,
        pendingProposalCount: 0,
        settled: false,
      },
      {
        id: "b",
        vessel: "MV BETA",
        voyageRef: "V2",
        demurrageAmount: 10_000,
        daysToDeadline: 60,
        contradictedEvidenceCount: 0,
        pendingProposalCount: 2,
        settled: false,
      },
      {
        id: "c",
        vessel: "MV GAMMA",
        voyageRef: "V3",
        demurrageAmount: 500_000,
        daysToDeadline: 2,
        contradictedEvidenceCount: 1,
        pendingProposalCount: 0,
        settled: true,
      },
    ]);
    expect(warnings.map((w) => w.claimId)).toEqual(["a", "b"]);
    expect(warnings[0].score).toBe(65);
    expect(warnings[0].reasons[0]).toContain("EXPIRED");
  });

  test("a quiet claim produces no warning at all", () => {
    const warnings = rankEarlyWarnings([
      {
        id: "quiet",
        vessel: "MV QUIET",
        voyageRef: "V9",
        demurrageAmount: 5_000,
        daysToDeadline: 80,
        contradictedEvidenceCount: 0,
        pendingProposalCount: 0,
        settled: false,
      },
    ]);
    expect(warnings).toHaveLength(0);
  });
});
