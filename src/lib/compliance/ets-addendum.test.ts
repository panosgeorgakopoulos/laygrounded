import { describe, expect, test } from "bun:test";
import { buildCarbonCostOfDelay } from "@/lib/compliance/emissions";
import { buildEtsAddendum, type EtsAddendumInput } from "@/lib/compliance/ets-addendum";
import type { DataProvenance } from "@/lib/risk/provenance";

// The point of this module is legal correctness, so most of these tests are
// about what the document must NOT say.

const LIVE_PRICE: DataProvenance = {
  source: "live",
  provider: "ice",
  observedAt: "2026-07-31T00:00:00.000Z",
  label: "Live EUA spot price €82.40/tCO2 from ice (2026-07-31).",
};

function input(overrides: Partial<EtsAddendumInput> = {}): EtsAddendumInput {
  return {
    claim: {
      id: "c1",
      vessel: "MV Test",
      voyageRef: "V-1",
      port: "Rotterdam, NL",
      cargo: "Grain",
      charterer: "Acme Trading SA",
      owner: "Blue Sea Shipping Ltd",
    },
    carbonCost: buildCarbonCostOfDelay({
      delayHours: 72,
      eeaPort: true,
      year: 2026,
      demurrageAmount: 72000,
      currency: "USD",
    }),
    hasBimcoEtsClause: true,
    euaPriceEur: 82.4,
    euaPriceProvenance: LIVE_PRICE,
    etsScopeBasis: "NL is in the EEA.",
    issuedAtISO: "2026-07-31T09:00:00.000Z",
    ...overrides,
  };
}

describe("allocation follows the charterparty, not the arithmetic", () => {
  test("clause present → charterer liability, naming the charterer", () => {
    const a = buildEtsAddendum(input({ hasBimcoEtsClause: true }));
    expect(a.allocation).toBe("charterer_liability");
    expect(a.title).toContain("Charterer");
    expect(a.bearer).toBe("Acme Trading SA");
    expect(a.warning).toBeNull();
    expect(a.basis).toContain("Art. 3ga");
  });

  test("clause ABSENT → unrecovered owner cost, with a warning", () => {
    const a = buildEtsAddendum(input({ hasBimcoEtsClause: false }));
    expect(a.allocation).toBe("unrecovered_owner_cost");
    expect(a.bearer).toBe("Blue Sea Shipping Ltd");
    expect(a.title).toContain("unrecovered");
    expect(a.warning).toContain("no BIMCO ETS clause");
    // The document must NOT assert a charterer liability that has no basis.
    expect(a.title).not.toContain("Charterer Liability");
    expect(a.basis).toContain("no contractual route");
  });

  test("clause NOT RECORDED → unallocated, never defaulted either way", () => {
    // Defaulting to "charterer owes" would put a legally unsupported demand in
    // front of a counterparty; defaulting to "owner eats it" would understate a
    // claim the owner may be entitled to make.
    const a = buildEtsAddendum(input({ hasBimcoEtsClause: null }));
    expect(a.allocation).toBe("unallocated");
    expect(a.bearer).toBe("Not determined");
    expect(a.warning).toContain("has not been recorded");
  });

  test("every allocation states the surrender obligation sits with the shipping company", () => {
    for (const clause of [true, false, null]) {
      const a = buildEtsAddendum(input({ hasBimcoEtsClause: clause }));
      if (a.allocation !== "unallocated" || clause === null) {
        expect(a.basis).toContain("shipping company");
      }
    }
  });

  test("falls back to generic party names rather than printing 'null'", () => {
    const a = buildEtsAddendum(
      input({
        claim: { ...input().claim, charterer: null, owner: null },
        hasBimcoEtsClause: false,
      })
    );
    expect(a.bearer).toBe("the Owner");
    expect(a.basis).toContain("the Charterer");
    expect(JSON.stringify(a)).not.toContain("null,");
  });
});

describe("a non-EEA berth creates no liability to allocate", () => {
  const nonEea = () =>
    buildEtsAddendum(
      input({
        carbonCost: buildCarbonCostOfDelay({ delayHours: 72, eeaPort: false, year: 2026 }),
        hasBimcoEtsClause: true,
      })
    );

  test("amount is zero and nothing is allocated", () => {
    const a = nonEea();
    expect(a.amountEur).toBe(0);
    expect(a.allocation).toBe("unallocated");
    expect(a.bearer).toBe("No party");
  });

  test("does not say the charterer owes zero — that implies a claim exists", () => {
    const a = nonEea();
    expect(a.title).toContain("none arising");
    expect(a.title).not.toContain("Charterer");
  });

  test("a clause present does not manufacture a liability out of scope", () => {
    expect(nonEea().amountEur).toBe(0);
  });
});

describe("uncertainty is stated, not smoothed over", () => {
  test("an unknown EEA status is flagged as potential exposure", () => {
    const a = buildEtsAddendum(
      input({ carbonCost: buildCarbonCostOfDelay({ delayHours: 72, year: 2026 }) })
    );
    expect(a.footnotes[0]).toContain("POTENTIAL exposure");
    expect(a.decisionGrade).toBe(false);
  });

  test("a mock EUA price strips decision-grade status", () => {
    const a = buildEtsAddendum(
      input({
        euaPriceProvenance: {
          source: "mock",
          provider: "laygrounded-mock-eua",
          observedAt: null,
          label: "SYNTHETIC EUA price",
        },
      })
    );
    expect(a.decisionGrade).toBe(false);
    expect(a.footnotes.some((f) => f.includes("SYNTHETIC"))).toBe(true);
  });

  test("a live price on a certain scope IS decision-grade", () => {
    expect(buildEtsAddendum(input()).decisionGrade).toBe(true);
  });

  test("the price provenance always reaches the footnotes", () => {
    const a = buildEtsAddendum(input());
    expect(a.footnotes.some((f) => f.includes("ice"))).toBe(true);
  });

  test("states that CO2 is assumed, not measured", () => {
    const a = buildEtsAddendum(input());
    expect(a.footnotes.some((f) => f.includes("not from measured bunker data"))).toBe(true);
  });
});

describe("the figures", () => {
  test("the emphasised line is the allowance cost", () => {
    const a = buildEtsAddendum(input());
    const emphasised = a.lines.filter((l) => l.emphasis);
    expect(emphasised).toHaveLength(1);
    expect(emphasised[0].label).toBe("Allowance cost");
    expect(emphasised[0].value).toContain("EUR");
  });

  test("the amount matches the scoped carbon cost exactly", () => {
    const cc = buildCarbonCostOfDelay({ delayHours: 72, eeaPort: true, year: 2026 });
    const a = buildEtsAddendum(input({ carbonCost: cc }));
    expect(a.amountEur).toBeCloseTo(cc.etsCostEur, 2);
  });

  test("phase-in is shown so a 2024 figure is not mistaken for a 2026 one", () => {
    const a = buildEtsAddendum(
      input({ carbonCost: buildCarbonCostOfDelay({ delayHours: 72, eeaPort: true, year: 2024 }) })
    );
    expect(a.lines.find((l) => l.label.includes("chargeable share"))!.value).toContain("40%");
  });

  test("demurrage is shown beside the carbon when supplied", () => {
    const a = buildEtsAddendum(input());
    expect(a.lines.some((l) => l.label === "Demurrage claimed")).toBe(true);
  });

  test("is deterministic", () => {
    expect(JSON.stringify(buildEtsAddendum(input()))).toBe(
      JSON.stringify(buildEtsAddendum(input()))
    );
  });
});
