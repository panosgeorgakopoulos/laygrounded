import { describe, expect, test } from "bun:test";
import { analyzeCpRisk, MIN_PRICING_SAMPLE, type CpRiskInput } from "./risk";
import type { CpTerms } from "@/lib/laytime/types";
import type { OracleVoyageStat } from "@/lib/oracle/pricing";

const SAFE_TERMS: CpTerms = {
  cp_form: "GENCON94",
  laytime_allowed_hours: 120,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "WWDSHEX-EIU",
  demurrage_rate: 24_000,
  despatch_rate: 12_000,
  currency: "USD",
  port_timezone: "UTC",
};

function stat(over: Partial<OracleVoyageStat> = {}): OracleVoyageStat {
  return {
    month: 6,
    weatherDelayHours: 4,
    usedHours: 80,
    allowedHours: 120,
    excessHours: 0,
    verified: true,
    ...over,
  };
}

/** A sample big enough to price against. */
const SAMPLES = Array.from({ length: 10 }, () => stat());

function run(over: Partial<CpRiskInput> = {}) {
  return analyzeCpRisk({ terms: SAFE_TERMS, samples: SAMPLES, ...over });
}

const keys = (r: ReturnType<typeof run>) => r.risks.map((x) => x.key);
const risk = (r: ReturnType<typeof run>, key: string) => r.risks.find((x) => x.key === key);

describe("analyzeCpRisk — clean terms", () => {
  test("well-drafted terms on a comfortable route raise nothing structural", () => {
    const r = run();
    expect(keys(r)).not.toContain("no_turn_time");
    expect(keys(r)).not.toContain("no_weather_exception");
    expect(keys(r)).not.toContain("no_demurrage_rate");
    expect(keys(r)).not.toContain("allowance_below_history");
  });

  test("the currency is carried from the terms", () => {
    expect(run({ terms: { ...SAFE_TERMS, currency: "EUR" } }).currency).toBe("EUR");
  });
});

describe("analyzeCpRisk — structural findings", () => {
  test("no turn time is high severity and priced against a 6-hour alternative", () => {
    const r = run({ terms: { ...SAFE_TERMS, turn_time_hours: 0 } });
    const t = risk(r, "no_turn_time")!;
    expect(t.severity).toBe("high");
    expect(t.expectedCost).not.toBeNull();
    expect(t.recommendation).toContain("6 hours");
  });

  test("a missing demurrage rate is critical and explicitly unpriceable", () => {
    const r = run({ terms: { ...SAFE_TERMS, demurrage_rate: 0 } });
    const t = risk(r, "no_demurrage_rate")!;
    expect(t.severity).toBe("critical");
    expect(t.expectedCost).toBeNull();
    expect(t.costBasis).toContain("no rate to price with");
  });

  test("despatch above demurrage is flagged as a probable drafting error", () => {
    const r = run({ terms: { ...SAFE_TERMS, despatch_rate: 50_000 } });
    expect(risk(r, "despatch_exceeds_demurrage")).toBeDefined();
  });

  test("a weather-excluding basis raises no weather finding", () => {
    for (const basis of ["WWDSHEX-EIU", "WWDSSHEX-EIU"] as const) {
      const r = run({ terms: { ...SAFE_TERMS, days_basis: basis } });
      expect(keys(r)).not.toContain("no_weather_exception");
    }
  });

  test("a non-weather basis raises the weather finding", () => {
    const r = run({ terms: { ...SAFE_TERMS, days_basis: "SHINC" } });
    expect(risk(r, "no_weather_exception")).toBeDefined();
  });
});

describe("analyzeCpRisk — pricing", () => {
  test("SHINC is priced against SHEX and costs money", () => {
    const r = run({ terms: { ...SAFE_TERMS, days_basis: "SHINC", laytime_allowed_hours: 60 } });
    const t = risk(r, "days_basis")!;
    expect(t.expectedCost).not.toBeNull();
    expect(t.expectedCost!).toBeGreaterThan(0);
    expect(t.recommendation).toContain("SHEX");
  });

  test("an allowance below what the route historically takes is critical and quantified", () => {
    const r = run({
      terms: { ...SAFE_TERMS, laytime_allowed_hours: 40 },
      samples: Array.from({ length: 10 }, () => stat({ usedHours: 100 })),
    });
    const t = risk(r, "allowance_below_history")!;
    expect(t.severity).toBe("critical");
    expect(t.detail).toContain("100");
    expect(t.expectedCost).not.toBeNull();
    expect(t.recommendation).toContain("100");
  });

  test("an allowance above the route's history is not flagged", () => {
    const r = run({
      terms: { ...SAFE_TERMS, laytime_allowed_hours: 200 },
      samples: Array.from({ length: 10 }, () => stat({ usedHours: 80 })),
    });
    expect(keys(r)).not.toContain("allowance_below_history");
  });

  test("the total sums only the priced risks", () => {
    const r = run({ terms: { ...SAFE_TERMS, days_basis: "SHINC", turn_time_hours: 0 } });
    const priced = r.risks.map((x) => x.expectedCost).filter((c): c is number => c !== null);
    expect(r.totalExpectedCost).toBeCloseTo(
      priced.reduce((a, b) => a + b, 0),
      2
    );
  });

  test("the weather finding is deliberately unpriced so money is not double-counted", () => {
    // Its monetary effect is the same swap the days_basis risk already prices.
    const r = run({ terms: { ...SAFE_TERMS, days_basis: "SHINC" } });
    expect(risk(r, "no_weather_exception")!.expectedCost).toBeNull();
  });
});

describe("analyzeCpRisk — thin or absent history", () => {
  test("no samples still returns structural findings, unpriced", () => {
    const r = run({ terms: { ...SAFE_TERMS, turn_time_hours: 0 }, samples: [] });
    expect(risk(r, "no_turn_time")).toBeDefined();
    expect(risk(r, "no_turn_time")!.expectedCost).toBeNull();
    expect(r.totalExpectedCost).toBeNull();
    expect(r.limitations[0]).toContain("No historical voyages");
  });

  test("below the pricing floor nothing is priced and the shortfall is stated", () => {
    const r = run({ samples: Array.from({ length: MIN_PRICING_SAMPLE - 1 }, () => stat()) });
    expect(r.sampleSize).toBe(MIN_PRICING_SAMPLE - 1);
    expect(r.limitations[0]).toContain(String(MIN_PRICING_SAMPLE));
    for (const x of r.risks) expect(x.expectedCost).toBeNull();
  });

  test("a risky clause is still reported when it cannot be priced", () => {
    // The failure mode this guards: silently dropping findings on a new route.
    const r = run({ terms: { ...SAFE_TERMS, days_basis: "SHINC" }, samples: [] });
    expect(keys(r)).toContain("days_basis");
    expect(risk(r, "days_basis")!.costBasis).toContain("insufficient historical voyages");
  });

  test("exactly at the pricing floor prices", () => {
    const r = run({
      terms: { ...SAFE_TERMS, turn_time_hours: 0 },
      samples: Array.from({ length: MIN_PRICING_SAMPLE }, () => stat({ usedHours: 200 })),
    });
    expect(risk(r, "no_turn_time")!.expectedCost).not.toBeNull();
  });
});

describe("analyzeCpRisk — missing fields", () => {
  test("a field the extractor never found is reported separately from a bad term", () => {
    const r = run({ missingFields: ["demurrage_rate"] });
    const t = risk(r, "missing_demurrage_rate")!;
    expect(t.expectedCost).toBeNull();
    expect(t.detail).toContain("fell back to a default");
    // Distinct from the "rate is zero" finding, which is a contractual problem.
    expect(keys(r)).not.toContain("no_demurrage_rate");
  });

  test("missing fields do not suppress the structural analysis", () => {
    const r = run({ terms: { ...SAFE_TERMS, turn_time_hours: 0 }, missingFields: ["nor_variant"] });
    expect(keys(r)).toContain("no_turn_time");
    expect(keys(r)).toContain("missing_nor_variant");
  });
});

describe("analyzeCpRisk — ordering and disclosure", () => {
  test("critical findings sort above high, high above medium", () => {
    const r = run({
      terms: { ...SAFE_TERMS, demurrage_rate: 0, turn_time_hours: 0, days_basis: "SHINC" },
    });
    const rank = { critical: 4, high: 3, medium: 2, low: 1 } as const;
    const ranks = r.risks.map((x) => rank[x.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  test("every risk carries a cost basis, priced or not", () => {
    const r = run({ terms: { ...SAFE_TERMS, days_basis: "SHINC", turn_time_hours: 0 } });
    for (const x of r.risks) {
      expect(x.costBasis.length).toBeGreaterThan(0);
      expect(x.recommendation.length).toBeGreaterThan(0);
    }
  });

  test("engine clause references are attached where they exist", () => {
    // A biting allowance, so the basis swap is material enough to be raised.
    const r = run({ terms: { ...SAFE_TERMS, days_basis: "SHINC", laytime_allowed_hours: 60 } });
    expect(risk(r, "days_basis")!.clauseRef).toBe("GENCON94-6");
    expect(risk(r, "no_weather_exception")!.clauseRef).toBe("GENCON94-6c");
  });

  test("an immaterial clause swap is not raised at all", () => {
    // 120h allowance against a route that historically uses 80h: SHINC costs
    // the same as SHEX because neither reaches demurrage. Reporting it would
    // train the reader to ignore the list.
    const r = run({ terms: { ...SAFE_TERMS, days_basis: "SHINC" } });
    expect(keys(r)).not.toContain("days_basis");
    // The structural weather finding still stands — it does not depend on money.
    expect(keys(r)).toContain("no_weather_exception");
  });

  test("a finding with no knowledge anchor says so rather than inventing one", () => {
    const r = run({ missingFields: ["cargo"] });
    expect(risk(r, "missing_cargo")!.clauseRef).toBeNull();
  });

  test("a mixed report warns that the total excludes structural findings", () => {
    const r = run({ terms: { ...SAFE_TERMS, days_basis: "SHINC", laytime_allowed_hours: 60 } });
    expect(r.totalExpectedCost).not.toBeNull();
    expect(r.limitations.some((l) => l.includes("priced risks only"))).toBe(true);
  });
});
