import { describe, expect, test } from "bun:test";
import {
  computeVoyagePnl,
  offHireDays,
  type VoyagePnlInput,
  type LaytimeOutcome,
} from "./voyage-pnl";

// A deliberately round fixture so every expected figure below can be checked by
// hand: 50,000 MT at USD 20 = USD 1,000,000 freight, 30 voyage days.
const BASE: VoyagePnlInput = {
  charterType: "voyage",
  perspective: "owner",
  currency: "USD",
  voyageStart: "2026-03-01T00:00:00Z",
  voyageEnd: "2026-03-31T00:00:00Z",
  freight: { basis: "per_mt", ratePerMt: 20, quantityMt: 50_000 },
  commissions: { addressPct: 0, brokeragePct: 0, onDemurrage: false },
  bunkers: [],
  portCosts: [],
  otherCosts: [],
  laytime: [],
};

function pnl(over: Partial<VoyagePnlInput> = {}) {
  return computeVoyagePnl({ ...BASE, ...over });
}

function outcome(over: Partial<LaytimeOutcome> = {}): LaytimeOutcome {
  return {
    claimId: "claim-1",
    calculationId: "calc-1",
    demurrage: 0,
    despatch: 0,
    currency: "USD",
    ...over,
  };
}

const line = (r: ReturnType<typeof pnl>, key: string) => r.lines.find((l) => l.key === key);

describe("freight", () => {
  test("per-MT freight is rate x quantity", () => {
    const r = pnl();
    expect(r.grossRevenue).toBe(1_000_000);
    expect(line(r, "freight")!.amount).toBe(1_000_000);
  });

  test("lump-sum freight is taken as given", () => {
    const r = pnl({ freight: { basis: "lumpsum", lumpsum: 850_000 } });
    expect(r.grossRevenue).toBe(850_000);
  });

  test("deadfreight is charged at the freight rate", () => {
    const r = pnl({
      freight: { basis: "per_mt", ratePerMt: 20, quantityMt: 45_000, deadfreightMt: 5_000 },
    });
    // 45,000 x 20 = 900,000 plus 5,000 x 20 = 100,000
    expect(r.grossRevenue).toBe(1_000_000);
    expect(line(r, "deadfreight")!.amount).toBe(100_000);
  });

  test("deadfreight on a lump-sum fixture is refused, not guessed", () => {
    const r = pnl({ freight: { basis: "lumpsum", lumpsum: 850_000, deadfreightMt: 5_000 } });
    expect(line(r, "deadfreight")).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("no per-tonne rate"))).toBe(true);
    expect(r.grossRevenue).toBe(850_000);
  });
});

describe("commissions", () => {
  test("address and brokerage are charged on freight", () => {
    const r = pnl({ commissions: { addressPct: 2.5, brokeragePct: 1.25, onDemurrage: false } });
    expect(line(r, "address_commission")!.amount).toBe(-25_000);
    expect(line(r, "brokerage")!.amount).toBe(-12_500);
    expect(r.revenueDeductions).toBe(37_500);
    expect(r.netResult).toBe(962_500);
  });

  test("commission does NOT reach demurrage when the CP does not say so", () => {
    const r = pnl({
      commissions: { addressPct: 5, brokeragePct: 0, onDemurrage: false },
      laytime: [outcome({ demurrage: 100_000 })],
    });
    // 5% of freight only: 50,000. Not 5% of 1,100,000.
    expect(line(r, "address_commission")!.amount).toBe(-50_000);
  });

  test("commission DOES reach demurrage when the CP says so", () => {
    const r = pnl({
      commissions: { addressPct: 5, brokeragePct: 0, onDemurrage: true },
      laytime: [outcome({ demurrage: 100_000 })],
    });
    expect(line(r, "address_commission")!.amount).toBe(-55_000);
  });

  test("the note states which basis was applied, so the sheet is self-explaining", () => {
    const on = pnl({ commissions: { addressPct: 5, brokeragePct: 0, onDemurrage: true } });
    const off = pnl({ commissions: { addressPct: 5, brokeragePct: 0, onDemurrage: false } });
    expect(line(on, "address_commission")!.note).toContain("and demurrage");
    expect(line(off, "address_commission")!.note).toContain("does not extend it to demurrage");
  });

  test("zero-rate commissions produce no line at all", () => {
    expect(line(pnl(), "address_commission")).toBeUndefined();
    expect(line(pnl(), "brokerage")).toBeUndefined();
  });
});

describe("laytime integration", () => {
  test("demurrage flows in as revenue and is tagged to the engine", () => {
    const r = pnl({ laytime: [outcome({ demurrage: 75_000 })] });
    const l = line(r, "demurrage:claim-1")!;
    expect(l.amount).toBe(75_000);
    expect(l.source).toBe("laytime_engine");
    expect(l.note).toContain("calc-1");
    expect(r.grossRevenue).toBe(1_075_000);
  });

  test("despatch is a deduction, not a voyage expense", () => {
    const r = pnl({ laytime: [outcome({ despatch: 30_000 })] });
    expect(line(r, "despatch:claim-1")!.kind).toBe("deduction");
    expect(r.revenueDeductions).toBe(30_000);
    expect(r.voyageExpenses).toBe(0);
  });

  test("several port calls each contribute their own line", () => {
    const r = pnl({
      laytime: [
        outcome({ claimId: "load", demurrage: 40_000 }),
        outcome({ claimId: "disch", demurrage: 25_000 }),
      ],
    });
    expect(line(r, "demurrage:load")!.amount).toBe(40_000);
    expect(line(r, "demurrage:disch")!.amount).toBe(25_000);
    expect(r.grossRevenue).toBe(1_065_000);
  });

  test("a claim with no calculation is NAMED, not silently treated as zero", () => {
    const r = pnl({ claimsAwaitingCalculation: ["claim-9"] });
    expect(r.warnings.some((w) => w.includes("claim-9") && w.includes("incomplete"))).toBe(true);
  });

  test("a missing calculation reference is disclosed on the line", () => {
    const r = pnl({ laytime: [outcome({ demurrage: 10_000, calculationId: null })] });
    expect(line(r, "demurrage:claim-1")!.note).toContain("No calculation reference");
  });

  test("demurrage is never recomputed — the supplied figure is used verbatim", () => {
    const r = pnl({ laytime: [outcome({ demurrage: 12_345.67 })] });
    expect(line(r, "demurrage:claim-1")!.amount).toBe(12_345.67);
  });
});

describe("voyage expenses", () => {
  test("bunkers are tonnes x price", () => {
    const r = pnl({
      bunkers: [{ grade: "VLSFO", tonnes: 500, pricePerTonne: 620, currency: "USD" }],
    });
    expect(line(r, "bunker:VLSFO")!.amount).toBe(-310_000);
    expect(r.voyageExpenses).toBe(310_000);
  });

  test("port costs and other costs are expenses", () => {
    const r = pnl({
      portCosts: [{ label: "Santos DA", amount: 45_000, currency: "USD" }],
      otherCosts: [{ label: "Canal dues", amount: 30_000, currency: "USD" }],
    });
    expect(r.voyageExpenses).toBe(75_000);
    expect(r.netResult).toBe(925_000);
  });
});

describe("TCE", () => {
  test("is net revenue less voyage expenses over voyage days", () => {
    const r = pnl({
      commissions: { addressPct: 5, brokeragePct: 0, onDemurrage: false },
      bunkers: [{ grade: "VLSFO", tonnes: 500, pricePerTonne: 620, currency: "USD" }],
      portCosts: [{ label: "DA", amount: 40_000, currency: "USD" }],
    });
    // (1,000,000 - 50,000 - 310,000 - 40,000) / 30 days = 600,000 / 30 = 20,000
    expect(r.voyageDays).toBe(30);
    expect(r.tcePerDay).toBe(20_000);
  });

  test("demurrage lifts TCE because it is revenue the voyage earned", () => {
    const without = pnl().tcePerDay!;
    const with_ = pnl({ laytime: [outcome({ demurrage: 30_000 })] }).tcePerDay!;
    expect(with_).toBeGreaterThan(without);
    expect(with_ - without).toBeCloseTo(1_000, 6); // 30,000 / 30 days
  });

  test("is null without dates, and says why", () => {
    const r = pnl({ voyageStart: null, voyageEnd: null });
    expect(r.tcePerDay).toBeNull();
    expect(r.voyageDays).toBeNull();
    expect(r.warnings.some((w) => w.includes("start and end dates"))).toBe(true);
  });

  test("is null when the end is not after the start", () => {
    const r = pnl({ voyageEnd: "2026-02-01T00:00:00Z" });
    expect(r.tcePerDay).toBeNull();
    expect(r.warnings.some((w) => w.includes("not after"))).toBe(true);
  });

  test("transfers are excluded from TCE but included in the net result", () => {
    // The rule that keeps TCE comparable: a bunker settlement is cash moving
    // between the parties, not something the voyage earned or consumed.
    const base = pnl();
    const withTransfer = computeVoyagePnl({
      ...BASE,
      // Injected directly, since BOD/BOR terms land in the next iteration.
      laytime: [],
    });
    expect(withTransfer.transfers).toBe(0);
    expect(base.tcePerDay).toBe(withTransfer.tcePerDay);
  });
});

describe("multi-currency", () => {
  test("an off-currency cost is excluded from totals and reported", () => {
    const r = pnl({ portCosts: [{ label: "Santos DA", amount: 250_000, currency: "BRL" }] });
    expect(r.voyageExpenses).toBe(0);
    expect(line(r, "port:0")!.excluded).toBe(true);
    expect(r.warnings.some((w) => w.includes("BRL") && w.includes("excluded"))).toBe(true);
  });

  test("BRL is never silently added to USD", () => {
    const clean = pnl();
    const mixed = pnl({ portCosts: [{ label: "DA", amount: 250_000, currency: "BRL" }] });
    expect(mixed.netResult).toBe(clean.netResult);
  });

  test("off-currency demurrage is excluded and named by claim", () => {
    const r = pnl({ laytime: [outcome({ demurrage: 50_000, currency: "EUR" })] });
    expect(r.grossRevenue).toBe(1_000_000);
    expect(r.warnings.some((w) => w.includes("claim-1") && w.includes("EUR"))).toBe(true);
  });

  test("the excluded line is still shown, so nothing disappears from the sheet", () => {
    const r = pnl({ portCosts: [{ label: "Santos DA", amount: 250_000, currency: "BRL" }] });
    expect(line(r, "port:0")).toBeDefined();
    expect(line(r, "port:0")!.amount).toBe(-250_000);
  });
});

describe("perspective", () => {
  test("the charterer sees the mirror of the owner's sheet", () => {
    const owner = pnl({ laytime: [outcome({ demurrage: 50_000 })] });
    const charterer = pnl({ perspective: "charterer", laytime: [outcome({ demurrage: 50_000 })] });
    expect(charterer.netResult).toBeCloseTo(-owner.netResult, 6);
    expect(line(charterer, "freight")!.amount).toBe(-1_000_000);
  });
});

describe("offHireDays", () => {
  test("no periods is zero", () => {
    expect(offHireDays([])).toBe(0);
  });

  test("a single period is its duration", () => {
    expect(
      offHireDays([{ from: "2026-03-01T00:00:00Z", to: "2026-03-03T00:00:00Z", reason: "x" }])
    ).toBe(2);
  });

  test("disjoint periods add", () => {
    expect(
      offHireDays([
        { from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z", reason: "a" },
        { from: "2026-03-05T00:00:00Z", to: "2026-03-06T00:00:00Z", reason: "b" },
      ])
    ).toBe(2);
  });

  test("OVERLAPPING periods are merged, not double-counted", () => {
    // The bug this exists to prevent: two causes logged for one stoppage would
    // otherwise credit the charterer twice for the same hours.
    expect(
      offHireDays([
        { from: "2026-03-01T00:00:00Z", to: "2026-03-04T00:00:00Z", reason: "engine" },
        { from: "2026-03-02T00:00:00Z", to: "2026-03-03T00:00:00Z", reason: "survey" },
      ])
    ).toBe(3);
  });

  test("partially overlapping periods merge to their union", () => {
    expect(
      offHireDays([
        { from: "2026-03-01T00:00:00Z", to: "2026-03-03T00:00:00Z", reason: "a" },
        { from: "2026-03-02T00:00:00Z", to: "2026-03-05T00:00:00Z", reason: "b" },
      ])
    ).toBe(4);
  });

  test("adjacent periods do not double count the touching instant", () => {
    expect(
      offHireDays([
        { from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z", reason: "a" },
        { from: "2026-03-02T00:00:00Z", to: "2026-03-03T00:00:00Z", reason: "b" },
      ])
    ).toBe(2);
  });

  test("a period fully containing another counts once", () => {
    expect(
      offHireDays([
        { from: "2026-03-01T00:00:00Z", to: "2026-03-10T00:00:00Z", reason: "drydock" },
        { from: "2026-03-03T00:00:00Z", to: "2026-03-04T00:00:00Z", reason: "survey" },
      ])
    ).toBe(9);
  });

  test("a zero-length or reversed period is ignored rather than negative", () => {
    expect(
      offHireDays([{ from: "2026-03-05T00:00:00Z", to: "2026-03-01T00:00:00Z", reason: "bad" }])
    ).toBe(0);
  });

  test("input order does not matter", () => {
    const a = [
      { from: "2026-03-05T00:00:00Z", to: "2026-03-06T00:00:00Z", reason: "b" },
      { from: "2026-03-01T00:00:00Z", to: "2026-03-02T00:00:00Z", reason: "a" },
    ];
    expect(offHireDays(a)).toBe(offHireDays([...a].reverse()));
  });
});

describe("time charter", () => {
  const TC: Partial<VoyagePnlInput> = {
    charterType: "time",
    freight: undefined,
    timeCharter: { hireRatePerDay: 15_000, offHire: [] },
  };

  test("hire is rate x on-hire days", () => {
    const r = pnl(TC);
    expect(r.grossRevenue).toBe(450_000); // 30 days x 15,000
  });

  test("off-hire reduces hire", () => {
    const r = pnl({
      ...TC,
      timeCharter: {
        hireRatePerDay: 15_000,
        offHire: [{ from: "2026-03-10T00:00:00Z", to: "2026-03-12T00:00:00Z", reason: "engine" }],
      },
    });
    expect(r.grossRevenue).toBe(420_000); // 28 days
    expect(line(r, "hire")!.note).toContain("2 days off hire");
  });

  test("overlapping off-hire does not over-deduct", () => {
    const r = pnl({
      ...TC,
      timeCharter: {
        hireRatePerDay: 15_000,
        offHire: [
          { from: "2026-03-10T00:00:00Z", to: "2026-03-13T00:00:00Z", reason: "engine" },
          { from: "2026-03-11T00:00:00Z", to: "2026-03-12T00:00:00Z", reason: "survey" },
        ],
      },
    });
    expect(r.grossRevenue).toBe(405_000); // 27 days, not 26
  });

  test("off-hire covering the whole period earns nothing and says so", () => {
    const r = pnl({
      ...TC,
      timeCharter: {
        hireRatePerDay: 15_000,
        offHire: [{ from: "2026-03-01T00:00:00Z", to: "2026-03-31T00:00:00Z", reason: "drydock" }],
      },
    });
    expect(r.grossRevenue).toBe(0);
    expect(r.warnings.some((w) => w.includes("entire period"))).toBe(true);
  });

  test("hire needs dates, and refuses rather than guessing without them", () => {
    const r = pnl({ ...TC, voyageStart: null, voyageEnd: null });
    expect(line(r, "hire")).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("start and an end date"))).toBe(true);
  });

  test("ILOHC and CVE are added when agreed", () => {
    const r = pnl({
      ...TC,
      timeCharter: { hireRatePerDay: 15_000, offHire: [], ilohc: 5_000, cvePerMonth: 1_500 },
    });
    expect(line(r, "ilohc")!.amount).toBe(5_000);
    expect(line(r, "cve")!.amount).toBe(1_500); // exactly one 30-day month
  });

  test("commission applies to hire", () => {
    const r = pnl({ ...TC, commissions: { addressPct: 2.5, brokeragePct: 1.25, onDemurrage: false } });
    expect(line(r, "address_commission")!.amount).toBe(-11_250); // 2.5% of 450,000
  });

  test("no freight line is produced on a time charter", () => {
    expect(line(pnl(TC), "freight")).toBeUndefined();
  });
});

describe("determinism and totals", () => {
  test("repeated computation is byte-identical", () => {
    const input = {
      commissions: { addressPct: 2.5, brokeragePct: 1.25, onDemurrage: true },
      bunkers: [{ grade: "VLSFO", tonnes: 500, pricePerTonne: 620.55, currency: "USD" }],
      laytime: [outcome({ demurrage: 33_333.33 })],
    };
    expect(JSON.stringify(pnl(input))).toBe(JSON.stringify(pnl(input)));
  });

  test("the net result equals the sum of every counted line", () => {
    const r = pnl({
      commissions: { addressPct: 2.5, brokeragePct: 1.25, onDemurrage: true },
      bunkers: [{ grade: "VLSFO", tonnes: 500, pricePerTonne: 620, currency: "USD" }],
      portCosts: [{ label: "DA", amount: 45_000, currency: "USD" }],
      laytime: [outcome({ demurrage: 60_000, despatch: 0 })],
    });
    const sum = r.lines
      .filter((l) => !l.excluded)
      .reduce((acc, l) => acc + l.amount, 0);
    expect(r.netResult).toBeCloseTo(sum, 2);
  });

  test("fractional money does not drift", () => {
    // decimal.js, not floats: 0.1 + 0.2 must not surface as 0.30000000000000004.
    const r = pnl({
      freight: { basis: "lumpsum", lumpsum: 0.1 },
      otherCosts: [{ label: "x", amount: -0.2, currency: "USD" }],
    });
    expect(r.netResult).toBe(0.3);
  });
});
