import { describe, expect, test } from "bun:test";
import {
  buildCounterpartyProfile,
  MIN_OBSERVATIONS,
  type CounterpartyClaimRecord,
  type SanctionsSnapshot,
} from "./counterparty";

function rec(over: Partial<CounterpartyClaimRecord> = {}): CounterpartyClaimRecord {
  return {
    claimId: "c1",
    claimedAmount: 100_000,
    settledAmount: 95_000,
    daysToSettle: 30,
    evidenceVerdicts: ["corroborated"],
    proposalsRaised: 0,
    proposalsRejected: 0,
    timeBarExpired: false,
    ...over,
  };
}

const CLEAR: SanctionsSnapshot = {
  verdict: "clear",
  checkedAt: "2026-07-01T00:00:00Z",
  source: "opensanctions",
};

function profile(claims: CounterpartyClaimRecord[], sanctions: SanctionsSnapshot | null = CLEAR) {
  return buildCounterpartyProfile({ counterpartyName: "Test Chartering", claims, sanctions });
}

const signal = (p: ReturnType<typeof profile>, key: string) =>
  p.signals.find((s) => s.key === key)!;

describe("buildCounterpartyProfile — thin history", () => {
  test("no claims is unrated, not low risk", () => {
    const p = profile([]);
    expect(p.band).toBe("unrated");
    expect(p.totalClaims).toBe(0);
    expect(p.drivers[0]).toContain("Not enough history");
  });

  test("every signal below the floor reports insufficient_data with a reason", () => {
    const p = profile([rec()]);
    for (const s of p.signals) {
      expect(s.verdict).toBe("insufficient_data");
      expect(s.value).toBeNull();
      expect(s.detail).toContain(String(MIN_OBSERVATIONS));
    }
    expect(p.band).toBe("unrated");
  });

  test("insufficient signals are ignored rather than averaged into 'moderate'", () => {
    // Two claims: enough to be tempting, not enough to rate. A model that
    // scored unknowns as neutral would return a confident middling band here.
    const p = profile([rec(), rec()]);
    expect(p.band).toBe("unrated");
  });
});

describe("buildCounterpartyProfile — signals", () => {
  test("a good payer reads favourable across the board and bands low", () => {
    const p = profile(Array.from({ length: 4 }, () => rec()));
    expect(signal(p, "recovery").verdict).toBe("favourable");
    expect(signal(p, "cycle").verdict).toBe("favourable");
    expect(signal(p, "evidence").verdict).toBe("favourable");
    expect(signal(p, "disputes").verdict).toBe("favourable");
    expect(p.band).toBe("low");
  });

  test("recovery is measured against what was claimed", () => {
    const p = profile([
      rec({ claimedAmount: 100_000, settledAmount: 50_000 }),
      rec({ claimedAmount: 200_000, settledAmount: 100_000 }),
      rec({ claimedAmount: 50_000, settledAmount: 25_000 }),
    ]);
    const s = signal(p, "recovery");
    expect(s.value).toBe(50);
    expect(s.verdict).toBe("adverse");
    expect(s.observations).toBe(3);
  });

  test("unsettled claims are excluded from recovery, not counted as zero", () => {
    const p = profile([
      rec({ settledAmount: 100_000 }),
      rec({ settledAmount: 100_000 }),
      rec({ settledAmount: 100_000 }),
      rec({ settledAmount: null }),
    ]);
    // Three settled at 100%; the unsettled row must not drag it to 75%.
    expect(signal(p, "recovery").value).toBe(100);
    expect(signal(p, "recovery").observations).toBe(3);
  });

  test("a slow payer is adverse on cycle time even while paying in full", () => {
    const p = profile(Array.from({ length: 3 }, () => rec({ daysToSettle: 120 })));
    expect(signal(p, "cycle").verdict).toBe("adverse");
    expect(signal(p, "recovery").verdict).toBe("favourable");
  });

  test("contradiction rate counts claims, not individual verdicts", () => {
    const p = profile([
      rec({ evidenceVerdicts: ["contradicted", "contradicted", "corroborated"] }),
      rec({ evidenceVerdicts: ["corroborated"] }),
      rec({ evidenceVerdicts: ["corroborated"] }),
      rec({ evidenceVerdicts: ["corroborated"] }),
    ]);
    // One of four verified claims had a contradiction → 25%, not 2/6.
    expect(signal(p, "evidence").value).toBe(25);
  });

  test("claims with no decisive verdict are excluded from the evidence signal", () => {
    const p = profile([
      rec({ evidenceVerdicts: ["inconclusive"] }),
      rec({ evidenceVerdicts: ["unavailable"] }),
      rec({ evidenceVerdicts: [] }),
    ]);
    expect(signal(p, "evidence").verdict).toBe("insufficient_data");
    expect(signal(p, "evidence").observations).toBe(0);
  });

  test("the evidence wording does not accuse", () => {
    const p = profile(Array.from({ length: 3 }, () => rec({ evidenceVerdicts: ["contradicted"] })));
    const detail = signal(p, "evidence").detail;
    expect(detail).toContain("not a judgement about the counterparty");
    expect(detail.toLowerCase()).not.toContain("fraud");
    expect(detail.toLowerCase()).not.toContain("dishonest");
  });

  test("a heavy amender is adverse and the rejected count is reported", () => {
    const p = profile(
      Array.from({ length: 3 }, () => rec({ proposalsRaised: 4, proposalsRejected: 3 }))
    );
    const s = signal(p, "disputes");
    expect(s.verdict).toBe("adverse");
    // Totals across the history, not per-claim: 3 claims x 4 raised / 3 rejected.
    expect(s.value).toBe(4); // per claim
    expect(s.detail).toContain("12 amendments");
    expect(s.detail).toContain("9 rejected");
  });
});

describe("buildCounterpartyProfile — banding", () => {
  test("one adverse signal is moderate", () => {
    const p = profile(Array.from({ length: 3 }, () => rec({ daysToSettle: 200 })));
    expect(p.band).toBe("moderate");
    expect(p.drivers).toEqual(["Time to settle"]);
  });

  test("two adverse signals are elevated, and both are named", () => {
    const p = profile(
      Array.from({ length: 3 }, () => rec({ daysToSettle: 200, settledAmount: 20_000 }))
    );
    expect(p.band).toBe("elevated");
    expect(p.drivers).toContain("Time to settle");
    expect(p.drivers).toContain("Recovery on settled claims");
  });

  test("the band names its drivers so the reasoning can be checked", () => {
    const p = profile(Array.from({ length: 4 }, () => rec()));
    expect(p.drivers.length).toBeGreaterThan(0);
  });
});

describe("buildCounterpartyProfile — sanctions", () => {
  test("a match forces elevated regardless of a spotless trading record", () => {
    const clean = Array.from({ length: 4 }, () => rec());
    expect(profile(clean).band).toBe("low");

    const p = profile(clean, { ...CLEAR, verdict: "match" });
    expect(p.band).toBe("elevated");
    expect(p.drivers[0]).toContain("Sanctions screening returned a match");
  });

  test("a possible match is elevated too, and says it needs review", () => {
    const p = profile(Array.from({ length: 4 }, () => rec()), {
      ...CLEAR,
      verdict: "possible_match",
    });
    expect(p.band).toBe("elevated");
    expect(p.drivers[0]).toContain("review");
  });

  test("unavailable screening does not create risk out of nothing", () => {
    const p = profile(Array.from({ length: 4 }, () => rec()), {
      ...CLEAR,
      verdict: "unavailable",
    });
    expect(p.band).toBe("low");
  });

  test("sanctions is reported verbatim, never folded into a signal", () => {
    const p = profile(Array.from({ length: 4 }, () => rec()), { ...CLEAR, verdict: "match" });
    expect(p.sanctions!.verdict).toBe("match");
    expect(p.signals.map((s) => s.key)).not.toContain("sanctions");
  });

  test("no screening on file is reported as absent, not as clear", () => {
    const p = profile(Array.from({ length: 4 }, () => rec()), null);
    expect(p.sanctions).toBeNull();
    expect(p.band).toBe("low");
  });
});

describe("buildCounterpartyProfile — disclosure", () => {
  test("methodology states the own-book-only scope", () => {
    const p = profile([rec()]);
    expect(p.methodology).toContain("your own company's claims");
    expect(p.methodology).toContain("No data from other LayGrounded customers");
  });

  test("a correction path is always present", () => {
    expect(profile([]).correctionPath).toContain("correct the underlying claim");
  });

  test("every signal carries its own sample size, so no figure is unattributable", () => {
    const p = profile(Array.from({ length: 4 }, () => rec()));
    for (const s of p.signals) {
      expect(typeof s.observations).toBe("number");
      expect(s.detail.length).toBeGreaterThan(0);
    }
  });
});
