import { describe, expect, test } from "bun:test";
import type { CpTerms } from "@/lib/laytime/types";
import { makeRng } from "@/lib/risk/prng";
import type { StoppageTrajectory, TrialInputs } from "@/lib/risk/trial";
import {
  clusterByWeatherSystem,
  simulatePortfolio,
  DEFAULT_CLUSTERING,
  type PortfolioVoyage,
} from "@/lib/risk/portfolio-var";

// The claim this module makes is quantitative, so the tests are quantitative.
// The headline property — correlation fattens the tail — is checked as
// CORRELATED vs INDEPENDENT, which is the comparison that isolates dependence.
// The "sum of individual P90s" comparison is checked separately, because it
// measures aggregation under skew and is NOT caused by correlation.

const CP_TERMS: CpTerms = {
  laytime_allowed_hours: 96,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "WWDSHEX-EIU",
  demurrage_rate: 24000,
  despatch_rate: 0,
  currency: "USD",
  port_timezone: "UTC",
} as CpTerms;

/**
 * Trajectories with a controllable storm rate.
 *
 * Storms arrive in BLOCKS so the synthetic weather is autocorrelated like the
 * real thing; independent hourly flags would never assemble the long stoppages
 * that generate demurrage, and the fixture would not exercise the tail.
 */
function trajectories(
  kind: "ensemble" | "climatology",
  count: number,
  stormRate: number,
  seed: string
): StoppageTrajectory[] {
  return Array.from({ length: count }, (_, i) => {
    const rng = makeRng(`${seed}:${i}`);
    const flags: boolean[] = [];
    let storm = 0;
    for (let h = 0; h < 400; h++) {
      if (storm > 0) {
        flags.push(true);
        storm--;
      } else if (rng.next() < stormRate) {
        storm = 8 + Math.floor(rng.next() * 24);
        flags.push(true);
        storm--;
      } else flags.push(false);
    }
    return { kind, id: `${kind}-${i}`, flags };
  });
}

/**
 * A shared pool, so member k means the same weather for every vessel using it —
 * which is exactly the physical fact the CRN design rests on.
 */
const SHARED_ENSEMBLE = trajectories("ensemble", 30, 0.03, "shared-ens");
const SHARED_CLIMATOLOGY = trajectories("climatology", 8, 0.03, "shared-clim");

function inputs(overrides: Partial<TrialInputs> = {}): TrialInputs {
  return {
    cpTerms: CP_TERMS,
    opsDurationHours: 96,
    berthToOpsHours: 1,
    referenceStartISO: "2026-09-01T00:00:00.000Z",
    etaISO: "2026-09-01T06:00:00.000Z",
    etaErrorHours: { min: -12, mode: 0, max: 24 },
    waitingHoursSorted: [0, 2, 4, 8, 12, 24],
    ensemblePool: SHARED_ENSEMBLE,
    climatologyPool: SHARED_CLIMATOLOGY,
    ensembleWeight: 1,
    ...overrides,
  };
}

/** Five vessels in one weather system — the US Gulf hurricane case. */
function gulfFleet(): PortfolioVoyage[] {
  const ports: Array<[string, number, number]> = [
    ["Houston", 29.75, -95.35],
    ["Galveston", 29.30, -94.79],
    ["Port Arthur", 29.87, -93.93],
    ["Lake Charles", 30.22, -93.22],
    ["New Orleans", 29.95, -90.07],
  ];
  return ports.map(([label, lat, lon], i) => ({
    id: `v${i}`,
    label,
    position: { lat, lon },
    inputs: inputs(),
  }));
}

/** The same five vessels scattered across oceans — no shared weather. */
function scatteredFleet(): PortfolioVoyage[] {
  const ports: Array<[string, number, number]> = [
    ["Rotterdam", 51.95, 4.14],
    ["Santos", -23.96, -46.33],
    ["Newcastle AU", -32.93, 151.78],
    ["Vancouver", 49.28, -123.12],
    ["Durban", -29.86, 31.03],
  ];
  return ports.map(([label, lat, lon], i) => ({
    id: `v${i}`,
    label,
    position: { lat, lon },
    inputs: inputs(),
  }));
}

describe("clusterByWeatherSystem", () => {
  test("groups a US Gulf fleet into one system", () => {
    const clusters = clusterByWeatherSystem(gulfFleet());
    expect(clusters).toHaveLength(1);
    expect(clusters[0].voyageIds).toHaveLength(5);
  });

  test("keeps vessels on different oceans apart", () => {
    const clusters = clusterByWeatherSystem(scatteredFleet());
    expect(clusters).toHaveLength(5);
    expect(clusters.every((c) => c.voyageIds.length === 1)).toBe(true);
  });

  test("chains through an intermediate port (single linkage)", () => {
    // A—B 400 km, B—C 400 km, A—C 800 km. One synoptic system genuinely spans
    // the chain, so all three belong together even though A and C are beyond
    // the radius of each other.
    const mk = (id: string, lat: number): PortfolioVoyage => ({
      id, label: id, position: { lat, lon: 0 }, inputs: inputs(),
    });
    const clusters = clusterByWeatherSystem([mk("a", 0), mk("b", 3.6), mk("c", 7.2)]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].voyageIds.sort()).toEqual(["a", "b", "c"]);
  });

  test("separates vessels at one port whose windows do not overlap in time", () => {
    // Same berth, two months apart: a shared climate, not a shared storm.
    const a: PortfolioVoyage = {
      id: "a", label: "Houston", position: { lat: 29.75, lon: -95.35 }, inputs: inputs(),
    };
    const b: PortfolioVoyage = {
      ...a, id: "b",
      inputs: inputs({ etaISO: "2026-11-01T06:00:00.000Z" }),
    };
    expect(clusterByWeatherSystem([a, b])).toHaveLength(2);
  });

  test("ignores time when told to", () => {
    const a: PortfolioVoyage = {
      id: "a", label: "Houston", position: { lat: 29.75, lon: -95.35 }, inputs: inputs(),
    };
    const b: PortfolioVoyage = {
      ...a, id: "b", inputs: inputs({ etaISO: "2026-11-01T06:00:00.000Z" }),
    };
    const clusters = clusterByWeatherSystem([a, b], {
      ...DEFAULT_CLUSTERING,
      requireTimeOverlap: false,
    });
    expect(clusters).toHaveLength(1);
  });

  test("a lone voyage is its own system", () => {
    expect(clusterByWeatherSystem([gulfFleet()[0]])).toHaveLength(1);
  });
});

describe("correlation fattens the tail — THE headline property", () => {
  const report = simulatePortfolio(gulfFleet(), { seed: "gulf", trials: 4000 });

  test("the fleet is recognised as one weather system", () => {
    expect(report.clusters).toHaveLength(1);
  });

  test("correlated P90 exceeds independent P90", () => {
    // Five vessels meeting the SAME hurricane lose together. Simulating them
    // as if each had private weather understates the bad case — this is the
    // number a treasurer would provision against.
    expect(report.correlated.p90Cost.value).toBeGreaterThan(
      report.independent.p90Cost.value
    );
    expect(report.correlationUplift).toBeGreaterThan(0);
  });

  test("correlated Expected Shortfall exceeds independent", () => {
    // ES is coherent where VaR is not, so if correlation is real it must show
    // here too. If VaR moved and ES did not, the VaR move would be an artefact.
    expect(report.correlated.expectedShortfall90.value).toBeGreaterThan(
      report.independent.expectedShortfall90.value
    );
  });

  test("the effect is larger than Monte Carlo error", () => {
    // Significance is tested on EXPECTED SHORTFALL, not on the P90. ES is a
    // mean, so it has a proper standard error; a sample quantile's error bar is
    // wide enough at these trial counts to swamp a real effect. Testing the
    // noisier statistic and calling the result insignificant would be a
    // measurement failure, not a finding.
    const se = Math.hypot(
      report.correlated.expectedShortfall90.standardError,
      report.independent.expectedShortfall90.standardError
    );
    const uplift =
      report.correlated.expectedShortfall90.value -
      report.independent.expectedShortfall90.value;
    expect(uplift).toBeGreaterThan(2 * se);
  }, 30_000);

  test("correlation does not move the MEAN, only the tail", () => {
    // The expectation of a sum is the sum of expectations whatever the
    // dependence. If the means diverged, the simulation would be wrong.
    const se = Math.hypot(
      report.correlated.expectedCost.standardError,
      report.independent.expectedCost.standardError
    );
    expect(
      Math.abs(report.correlated.expectedCost.value - report.independent.expectedCost.value)
    ).toBeLessThan(4 * se + 1);
  });

  test("a scattered fleet shows little or no uplift", () => {
    // The control. Without a shared system there is nothing for correlation to
    // do, and the two runs must agree within noise.
    const scattered = simulatePortfolio(scatteredFleet(), { seed: "scattered", trials: 4000 });
    expect(scattered.clusters).toHaveLength(5);
    const se = Math.hypot(
      scattered.correlated.p90Cost.standardError,
      scattered.independent.p90Cost.standardError
    );
    expect(Math.abs(scattered.correlationUplift)).toBeLessThan(4 * se + 1);
  }, 30_000);

  test("uplift grows with the size of the exposed cluster", () => {
    const two = simulatePortfolio(gulfFleet().slice(0, 2), { seed: "n", trials: 4000 });
    const five = simulatePortfolio(gulfFleet(), { seed: "n", trials: 4000 });
    expect(five.correlationUplift).toBeGreaterThan(two.correlationUplift);
  }, 30_000);
});

describe("VaR is not subadditive — the metric that is easy to misread", () => {
  test("under GENUINE comonotonicity, VaR is additive", () => {
    // The mathematical fact, tested on a fixture that actually satisfies it.
    //
    // The Gulf fleet does NOT: those vessels share weather but draw their own
    // ETA error and queue, so they are only partially dependent — and partial
    // dependence over zero-inflated marginals produces SUPERadditive VaR (the
    // next test). To isolate comonotonicity the idiosyncratic dimensions are
    // made degenerate, so the shared weather draw is the only randomness left
    // and every vessel moves in lockstep.
    const degenerate = (id: string): PortfolioVoyage => ({
      id,
      label: `Houston ${id}`,
      position: { lat: 29.75, lon: -95.35 },
      inputs: inputs({
        etaErrorHours: { min: 0, mode: 0, max: 0 },
        waitingHoursSorted: [6],
      }),
    });

    const report = simulatePortfolio([degenerate("a"), degenerate("b"), degenerate("c")], {
      seed: "comono",
      trials: 3000,
    });

    expect(report.clusters).toHaveLength(1);
    // Comonotonic VaR is exactly additive: the portfolio percentile equals the
    // sum of the marginal percentiles, so diversification is neither a benefit
    // nor a penalty.
    expect(report.correlated.p90Cost.value).toBeCloseTo(report.sumOfIndividualP90, 6);
    expect(report.diversificationVerdict).toBe("neutral");
  }, 30_000);

  test("partial dependence over skewed marginals IS superadditive, and is labelled so", () => {
    // The Gulf fleet: shared weather, private queues, zero-inflated outcomes.
    // The portfolio P90 legitimately exceeds the sum of the individual P90s —
    // and the module must attribute that to skew rather than let a reader
    // credit it to correlation.
    const report = simulatePortfolio(gulfFleet(), { seed: "superadd", trials: 3000 });
    expect(report.correlated.p90Cost.value).toBeGreaterThan(report.sumOfIndividualP90);
    expect(report.diversificationVerdict).toBe("penalty");
    expect(report.notes.some((n) => n.includes("NOT caused by correlation"))).toBe(true);
  }, 30_000);

  test("zero-inflation CAN push the portfolio P90 above the sum of individual P90s", () => {
    // Each vessel is individually unlikely to go on demurrage, so its own P90
    // sits at or below zero — but the book has a real chance of at least one
    // bad call. Sum of (near) zeros is beaten by the portfolio.
    const calm = trajectories("ensemble", 30, 0.002, "calm-pool");
    const unlikely = scatteredFleet().map((v) => ({
      ...v,
      inputs: inputs({
        ensemblePool: calm,
        climatologyPool: calm,
        cpTerms: { ...CP_TERMS, laytime_allowed_hours: 200 } as CpTerms,
      }),
    }));

    const report = simulatePortfolio(unlikely, { seed: "skew", trials: 3000 });
    const individualsAtOrBelowZero = report.perVoyage.filter((p) => p.p90Cost.value <= 0);
    expect(individualsAtOrBelowZero.length).toBeGreaterThan(0);

    // And the module must SAY so rather than leaving the reader to infer it.
    if (report.diversification > 0) {
      expect(report.diversificationVerdict).toBe("penalty");
      expect(report.notes.some((n) => n.includes("NOT caused by correlation"))).toBe(true);
    }
  }, 30_000);

  test("the diversification figure is exactly portfolio P90 minus the sum", () => {
    const report = simulatePortfolio(gulfFleet(), { seed: "div", trials: 3000 });
    expect(report.diversification).toBeCloseTo(
      report.correlated.p90Cost.value - report.sumOfIndividualP90,
      6
    );
  }, 30_000);
});

describe("tail decomposition", () => {
  const report = simulatePortfolio(gulfFleet(), { seed: "decomp", trials: 3000 });

  test("contributions cover the whole tail", () => {
    const total = report.perVoyage.reduce((a, p) => a + p.tailContributionShare, 0);
    expect(total).toBeCloseTo(1, 2);
  }, 30_000);

  test("names a voyage for every fixture in the book", () => {
    expect(report.perVoyage).toHaveLength(5);
    expect(report.perVoyage.map((p) => p.label)).toContain("Houston");
  });

  test("a dominant fixture shows the largest tail share", () => {
    // One vessel on a far tighter fixture should drive the book's bad case.
    const fleet = gulfFleet();
    fleet[0] = {
      ...fleet[0],
      inputs: inputs({ cpTerms: { ...CP_TERMS, laytime_allowed_hours: 24 } as CpTerms }),
    };
    const r = simulatePortfolio(fleet, { seed: "dominant", trials: 3000 });
    const top = [...r.perVoyage].sort((a, b) => b.tailContributionShare - a.tailContributionShare)[0];
    expect(top.voyageId).toBe("v0");
  }, 30_000);
});

describe("reproducibility and refusals", () => {
  test("the same seed reproduces the report exactly", () => {
    const a = simulatePortfolio(gulfFleet(), { seed: "audit", trials: 2000 });
    const b = simulatePortfolio(gulfFleet(), { seed: "audit", trials: 2000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 30_000);

  test("an empty book is an error, not an empty report", () => {
    expect(() => simulatePortfolio([], { seed: "x" })).toThrow("NO_VOYAGES");
  });

  test("duplicate voyage ids are refused", () => {
    // They would silently collide in the per-voyage cost map and corrupt the
    // decomposition rather than failing loudly.
    const fleet = gulfFleet();
    fleet[1] = { ...fleet[1], id: fleet[0].id };
    expect(() => simulatePortfolio(fleet, { seed: "dup" })).toThrow("DUPLICATE_VOYAGE_ID");
  });

  test("a single-voyage book still produces a coherent report", () => {
    const r = simulatePortfolio([gulfFleet()[0]], { seed: "one", trials: 1000 });
    expect(r.voyageCount).toBe(1);
    expect(r.perVoyage).toHaveLength(1);
    expect(r.correlated.p90Cost.value).toBeCloseTo(r.sumOfIndividualP90, 6);
  });

  test("antithetic pairing keeps the trial count exact", () => {
    expect(simulatePortfolio(gulfFleet(), { seed: "odd", trials: 1001 }).trials).toBe(1001);
  }, 30_000);
});
