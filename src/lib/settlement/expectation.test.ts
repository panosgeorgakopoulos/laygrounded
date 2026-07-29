import { describe, expect, test } from "bun:test";
import {
  expectSettlement,
  postureFromVerdicts,
  MIN_SAMPLE_SETTLEMENTS,
  MIN_SAMPLE_COMPANIES,
  type ClaimProfile,
  type EvidencePosture,
  type SettlementObservation,
} from "./expectation";

const TARGET: ClaimProfile = {
  cpForm: "GENCON94",
  daysBasis: "SHINC",
  evidencePosture: "corroborated",
  contested: false,
};

function obs(over: Partial<SettlementObservation> = {}): SettlementObservation {
  return {
    companyId: "co-1",
    claimedAmount: 100_000,
    settledAmount: 70_000,
    daysToSettle: 40,
    profile: { ...TARGET },
    ...over,
  };
}

/** n observations from one company, all matching the target exactly. */
function sample(n: number, over: Partial<SettlementObservation> = {}) {
  return Array.from({ length: n }, () => obs(over));
}

describe("expectSettlement — sufficiency", () => {
  test("no history refuses with a reason rather than a number", () => {
    const r = expectSettlement(TARGET, []);
    expect(r.verdict).toBe("insufficient_data");
    expect(r.recoveryPct).toBeNull();
    expect(r.note).toContain("No settled claims yet");
    expect(r.methodology).not.toBe("");
  });

  test("below the floor refuses and says how short it is", () => {
    const r = expectSettlement(TARGET, sample(MIN_SAMPLE_SETTLEMENTS - 1));
    expect(r.verdict).toBe("insufficient_data");
    expect(r.sampleSize).toBe(MIN_SAMPLE_SETTLEMENTS - 1);
    expect(r.note).toContain(String(MIN_SAMPLE_SETTLEMENTS));
  });

  test("exactly at the floor reports", () => {
    const r = expectSettlement(TARGET, sample(MIN_SAMPLE_SETTLEMENTS));
    expect(r.verdict).toBe("estimated");
    expect(r.tier).toBe("exact");
  });

  test("a claim with nothing claimed cannot produce a ratio and is excluded", () => {
    const r = expectSettlement(TARGET, [
      ...sample(MIN_SAMPLE_SETTLEMENTS),
      obs({ claimedAmount: 0, settledAmount: 5_000 }),
    ]);
    expect(r.sampleSize).toBe(MIN_SAMPLE_SETTLEMENTS);
  });
});

describe("expectSettlement — k-anonymity", () => {
  test("a single-company sample is never blocked — that is the desk reading its own book", () => {
    const r = expectSettlement(TARGET, sample(6, { companyId: "co-1" }));
    expect(r.verdict).toBe("estimated");
    expect(r.sampleCompanies).toBe(1);
  });

  test("a two-company sample is refused at that tier", () => {
    // 5 observations but only 2 companies: below MIN_SAMPLE_COMPANIES, and no
    // wider tier can help because every row already matches exactly.
    const rows = [
      ...sample(3, { companyId: "co-1" }),
      ...sample(2, { companyId: "co-2" }),
    ];
    expect(MIN_SAMPLE_COMPANIES).toBeGreaterThan(2);
    const r = expectSettlement(TARGET, rows);
    expect(r.verdict).toBe("insufficient_data");
  });

  test("enough distinct companies unblocks it", () => {
    const rows = Array.from({ length: MIN_SAMPLE_COMPANIES + 2 }, (_, i) =>
      obs({ companyId: `co-${i}` })
    );
    const r = expectSettlement(TARGET, rows);
    expect(r.verdict).toBe("estimated");
    expect(r.sampleCompanies).toBeGreaterThanOrEqual(MIN_SAMPLE_COMPANIES);
  });
});

describe("expectSettlement — tiering", () => {
  const wrongBasis: ClaimProfile = { ...TARGET, daysBasis: "SHEX" };
  const wrongForm: ClaimProfile = { ...TARGET, cpForm: "ASBATANKVOY" };
  const wrongPosture: ClaimProfile = { ...TARGET, evidencePosture: "contradicted" };

  test("falls back to posture when the exact profile is too thin", () => {
    const r = expectSettlement(TARGET, sample(5, { profile: wrongBasis }));
    expect(r.verdict).toBe("estimated");
    expect(r.tier).toBe("posture");
  });

  test("falls back to CP form when the posture differs too", () => {
    const r = expectSettlement(TARGET, sample(5, { profile: wrongPosture }));
    expect(r.tier).toBe("form");
  });

  test("falls back to the whole book when even the form differs", () => {
    const r = expectSettlement(TARGET, sample(5, { profile: wrongForm }));
    expect(r.tier).toBe("all");
  });

  test("prefers the exact tier when it is available, even though wider samples exist", () => {
    const r = expectSettlement(TARGET, [
      ...sample(MIN_SAMPLE_SETTLEMENTS, { settledAmount: 90_000 }),
      ...sample(20, { profile: wrongForm, settledAmount: 10_000 }),
    ]);
    expect(r.tier).toBe("exact");
    // 90% from the exact sample, not diluted by the 10% outsiders.
    expect(r.recoveryPct!.median).toBe(90);
  });

  test("the tier is always disclosed in the note", () => {
    const r = expectSettlement(TARGET, sample(5, { profile: wrongForm }));
    expect(r.note).toContain("all settled claims");
  });
});

describe("expectSettlement — figures", () => {
  test("median recovery is the middle of the sample, not the mean", () => {
    const rows = [
      obs({ settledAmount: 10_000 }),
      obs({ settledAmount: 50_000 }),
      obs({ settledAmount: 60_000 }),
      obs({ settledAmount: 100_000 }),
    ];
    const r = expectSettlement(TARGET, rows);
    // Ratios 10/50/60/100 → median 55, mean would be 55 too; use a skewed set
    // to separate them properly below.
    expect(r.recoveryPct!.median).toBe(55);
  });

  test("a skewed sample shows the median, which the mean would misreport", () => {
    const rows = [
      obs({ settledAmount: 10_000 }),
      obs({ settledAmount: 20_000 }),
      obs({ settledAmount: 30_000 }),
      obs({ settledAmount: 100_000 }),
    ];
    const r = expectSettlement(TARGET, rows);
    expect(r.recoveryPct!.median).toBe(25); // mean would be 40
  });

  test("reports a p25–p75 band, ordered", () => {
    const rows = [
      obs({ settledAmount: 20_000 }),
      obs({ settledAmount: 40_000 }),
      obs({ settledAmount: 60_000 }),
      obs({ settledAmount: 80_000 }),
    ];
    const b = expectSettlement(TARGET, rows).recoveryPct!;
    expect(b.p25).toBeLessThanOrEqual(b.median);
    expect(b.median).toBeLessThanOrEqual(b.p75);
  });

  test("days-to-settle ignores rows that never recorded one", () => {
    const rows = [
      obs({ daysToSettle: 10 }),
      obs({ daysToSettle: 20 }),
      obs({ daysToSettle: 30 }),
      obs({ daysToSettle: null }),
    ];
    const r = expectSettlement(TARGET, rows);
    expect(r.daysToSettle!.median).toBe(20);
    expect(r.sampleSize).toBe(4); // the null row still counts toward recovery
  });

  test("a sample with no recorded durations omits the days band rather than inventing one", () => {
    const r = expectSettlement(TARGET, sample(5, { daysToSettle: null }));
    expect(r.daysToSettle).toBeNull();
    expect(r.note).not.toContain("days");
  });

  test("a fully-paid history reads as 100%", () => {
    const r = expectSettlement(TARGET, sample(5, { settledAmount: 100_000 }));
    expect(r.recoveryPct!.median).toBe(100);
  });
});

describe("postureFromVerdicts", () => {
  const cases: Array<{ name: string; verdicts: string[]; expected: EvidencePosture }> = [
    { name: "nothing checked", verdicts: [], expected: "unverified" },
    { name: "only inconclusive/unavailable", verdicts: ["inconclusive", "unavailable"], expected: "unverified" },
    { name: "all corroborated", verdicts: ["corroborated", "corroborated"], expected: "corroborated" },
    { name: "all contradicted", verdicts: ["contradicted"], expected: "contradicted" },
    { name: "mixed", verdicts: ["corroborated", "contradicted"], expected: "mixed" },
    { name: "decisive plus noise", verdicts: ["corroborated", "unavailable"], expected: "corroborated" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(postureFromVerdicts(c.verdicts)).toBe(c.expected);
    });
  }

  test("unverified is distinct from corroborated so an unchecked claim cannot borrow a verified one's history", () => {
    expect(postureFromVerdicts([])).not.toBe(postureFromVerdicts(["corroborated"]));
  });
});
