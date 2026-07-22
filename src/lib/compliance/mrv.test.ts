import { describe, expect, test } from "bun:test";
import {
  buildMrvAnnualReport,
  co2FromFuel,
  EU_MRV_EMISSION_FACTORS,
  mrvVoyageProof,
  sealMrvReport,
  verifyMrvSeal,
  type MrvFuelEntry,
  type MrvVoyageInput,
} from "./mrv";
import { verifyMerkleProof } from "@/lib/legal/prosecution";

const AT = "2026-03-01T";

function voyage(over: Partial<MrvVoyageInput> = {}): MrvVoyageInput {
  return {
    claimId: "c1",
    voyageRef: "V-1",
    vessel: "MV IRON DUKE",
    vesselImo: "9123456",
    port: "Rotterdam",
    events: [
      { event_type: "NOR_TENDERED", occurred_at: `${AT}06:00:00Z` },
      { event_type: "BERTHED", occurred_at: `${AT}08:00:00Z`, ais_geofence_verified: true },
      { event_type: "ALL_FAST", occurred_at: `${AT}09:00:00Z`, ais_geofence_verified: true },
      { event_type: "COMPLETED_LOADING", occurred_at: `${AT}20:00:00Z` },
    ],
    ...over,
  };
}

// A fully-monitored voyage: every Reg 2015/757 field supplied.
const MEASURED_FUEL: MrvFuelEntry[] = [
  { fuelType: "HFO", tonnes: 10, phase: "at_sea", method: "FLOW_METERS" },
  { fuelType: "MDO/MGO", tonnes: 2, phase: "at_berth", method: "BDN_AND_TANK_STOCKTAKE" },
];

function fullyMonitored(over: Partial<MrvVoyageInput> = {}): MrvVoyageInput {
  return voyage({
    fuel: MEASURED_FUEL,
    eeaPort: true,
    distanceNm: 500,
    timeAtSeaHours: 48,
    cargoTonnes: 30_000,
    ...over,
  });
}

const BASE = { companyName: "Owner Ltd", reportingPeriod: 2026, generatedAt: new Date("2026-07-14T00:00:00Z") };

describe("co2FromFuel", () => {
  test("applies the Annex I emission factor per fuel type", () => {
    const r = co2FromFuel(MEASURED_FUEL);
    expect(r.atSea.toNumber()).toBeCloseTo(10 * EU_MRV_EMISSION_FACTORS.HFO, 6);
    expect(r.atBerth.toNumber()).toBeCloseTo(2 * EU_MRV_EMISSION_FACTORS["MDO/MGO"], 6);
    expect(r.total.toNumber()).toBeCloseTo(31.14 + 6.412, 6);
  });
});

// The reason this module exists. If any of these ever go green with a number,
// the report is inventing regulatory emissions data.
describe("buildMrvAnnualReport — refuses to fabricate", () => {
  test("emits no CO2 or fuel figure when no measured bunker data is supplied", () => {
    const r = buildMrvAnnualReport({ ...BASE, voyages: [voyage()] });
    const v = r.voyages[0];
    expect(v.co2Tonnes).toBeNull();
    expect(v.fuelTonnesByType).toBeNull();
    expect(r.aggregates.totalCo2Tonnes).toBeNull();
    expect(r.aggregates.totalFuelTonnes).toBeNull();
    expect(v.gaps.some((g) => g.includes("NOT MONITORED"))).toBe(true);
    expect(r.submittable).toBe(false);
  });

  test("does not total CO2 when only some voyages are measured", () => {
    const r = buildMrvAnnualReport({
      ...BASE,
      voyages: [fullyMonitored({ claimId: "measured" }), voyage({ claimId: "unmeasured" })],
    });
    expect(r.aggregates.voyagesWithMeasuredFuel).toBe(1);
    expect(r.aggregates.voyagesTotal).toBe(2);
    // A subset total would read as the period's emissions and understate them.
    expect(r.aggregates.totalCo2Tonnes).toBeNull();
  });

  test("totals only once every voyage carries measured fuel", () => {
    const r = buildMrvAnnualReport({
      ...BASE,
      voyages: [fullyMonitored({ claimId: "a" }), fullyMonitored({ claimId: "b" })],
    });
    expect(r.aggregates.totalCo2Tonnes).toBeCloseTo(2 * 37.552, 3);
    expect(r.aggregates.totalFuelTonnes).toBe(24);
    expect(r.aggregates.totalDistanceNm).toBe(1000);
    expect(r.aggregates.transportWorkTonneNm).toBe(30_000_000);
  });

  test("never self-certifies, whatever the inputs", () => {
    const r = buildMrvAnnualReport({ ...BASE, voyages: [fullyMonitored()] });
    expect(r.verification.status).toBe("unverified");
    expect(r.verification.verifier).toBeNull();
    expect(r.verification.statement).toContain("accredited");
    // A fully-monitored book still isn't submittable: the monitoring plan and
    // ship particulars are out of scope, and the report says so.
    expect(r.submittable).toBe(false);
    expect(r.dataGaps.some((g) => g.includes("Monitoring plan"))).toBe(true);
  });
});

describe("buildMrvAnnualReport — at-berth window", () => {
  test("derives the window from confirmed berthing and completion events", () => {
    const v = buildMrvAnnualReport({ ...BASE, voyages: [voyage()] }).voyages[0];
    expect(v.arrivalUtc).toBe(`${AT}08:00:00Z`);
    expect(v.departureUtc).toBe(`${AT}20:00:00Z`);
    expect(v.hoursAtBerth).toBe(12);
  });

  test("reports no window rather than a nonsense one when the chronology is broken", () => {
    const v = buildMrvAnnualReport({
      ...BASE,
      voyages: [
        voyage({
          events: [
            { event_type: "BERTHED", occurred_at: `${AT}20:00:00Z` },
            { event_type: "COMPLETED_LOADING", occurred_at: `${AT}08:00:00Z` },
          ],
        }),
      ],
    }).voyages[0];
    expect(v.hoursAtBerth).toBeNull();
  });

  test("reports no window when the completion event is missing", () => {
    const v = buildMrvAnnualReport({
      ...BASE,
      voyages: [voyage({ events: [{ event_type: "BERTHED", occurred_at: `${AT}08:00:00Z` }] })],
    }).voyages[0];
    expect(v.hoursAtBerth).toBeNull();
    expect(v.gaps.some((g) => g.includes("At-berth window"))).toBe(true);
  });
});

// Missing/contradicted AIS must degrade provenance, never silently pass.
describe("buildMrvAnnualReport — AIS edge cases", () => {
  test("marks the window corroborated when AIS backs every berthing event", () => {
    const v = buildMrvAnnualReport({ ...BASE, voyages: [voyage()] }).voyages[0];
    expect(v.berthProvenance).toBe("ais_corroborated");
    expect(v.gaps.some((g) => g.includes("AIS"))).toBe(false);
  });

  test("flags a gap when AIS is unavailable rather than assuming the SoF", () => {
    const v = buildMrvAnnualReport({
      ...BASE,
      voyages: [
        voyage({
          events: [
            { event_type: "BERTHED", occurred_at: `${AT}08:00:00Z`, ais_geofence_verified: null },
            { event_type: "COMPLETED_LOADING", occurred_at: `${AT}20:00:00Z` },
          ],
        }),
      ],
    }).voyages[0];
    expect(v.berthProvenance).toBe("ais_unavailable");
    expect(v.gaps.some((g) => g.includes("not independently corroborated"))).toBe(true);
    expect(v.submittable).toBe(false);
  });

  test("a contradicted berthing event blocks the voyage", () => {
    const v = buildMrvAnnualReport({
      ...BASE,
      voyages: [
        fullyMonitored({
          events: [
            { event_type: "BERTHED", occurred_at: `${AT}08:00:00Z`, ais_geofence_verified: false },
            { event_type: "COMPLETED_LOADING", occurred_at: `${AT}20:00:00Z` },
          ],
        }),
      ],
    }).voyages[0];
    expect(v.berthProvenance).toBe("ais_contradicted");
    expect(v.gaps.some((g) => g.includes("AIS contradicts"))).toBe(true);
    expect(v.submittable).toBe(false);
  });

  test("mixed AIS verdicts do not count as corroborated", () => {
    const v = buildMrvAnnualReport({
      ...BASE,
      voyages: [
        voyage({
          events: [
            { event_type: "BERTHED", occurred_at: `${AT}08:00:00Z`, ais_geofence_verified: true },
            { event_type: "ALL_FAST", occurred_at: `${AT}09:00:00Z`, ais_geofence_verified: null },
            { event_type: "COMPLETED_LOADING", occurred_at: `${AT}20:00:00Z` },
          ],
        }),
      ],
    }).voyages[0];
    expect(v.berthProvenance).toBe("ais_unavailable");
  });
});

describe("buildMrvAnnualReport — EEA scope", () => {
  test("will not guess whether a free-text port is in the EEA", () => {
    const v = buildMrvAnnualReport({
      ...BASE,
      voyages: [voyage({ port: "Port Hedland, AU" })],
    }).voyages[0];
    expect(v.eeaPort).toBeNull();
    expect(v.gaps.some((g) => g.includes("EEA port"))).toBe(true);
  });

  test("counts at-berth EEA CO2 only over known EEA calls with measured fuel", () => {
    const r = buildMrvAnnualReport({
      ...BASE,
      voyages: [
        fullyMonitored({ claimId: "eea", eeaPort: true }),
        fullyMonitored({ claimId: "non-eea", eeaPort: false }),
      ],
    });
    // Only the EEA call's at-berth slice: 2 t MDO/MGO x 3.206.
    expect(r.aggregates.totalCo2AtBerthEeaTonnes).toBeCloseTo(6.412, 3);
  });

  test("does not report EEA at-berth CO2 when any port's status is unknown", () => {
    const r = buildMrvAnnualReport({
      ...BASE,
      voyages: [fullyMonitored({ claimId: "known" }), fullyMonitored({ claimId: "unknown", eeaPort: undefined })],
    });
    expect(r.aggregates.totalCo2AtBerthEeaTonnes).toBeNull();
  });
});

describe("mrv sealing", () => {
  const report = buildMrvAnnualReport({ ...BASE, voyages: [fullyMonitored({ claimId: "a" }), voyage({ claimId: "b" })] });

  test("is deterministic and detects tampering", () => {
    const seal = sealMrvReport(report);
    expect(seal.merkleRoot).toBe(sealMrvReport(report).merkleRoot);
    expect(verifyMrvSeal(report, seal.merkleRoot)).toBe(true);

    const tampered = structuredClone(report);
    tampered.voyages[0].co2Tonnes = 1;
    expect(verifyMrvSeal(tampered, seal.merkleRoot)).toBe(false);
  });

  test("carries the unverified status inside the seal", () => {
    const seal = sealMrvReport(report);
    expect(seal.verificationStatus).toBe("unverified");
    expect(seal.submittable).toBe(false);
  });

  test("proves one voyage belongs to the root without the rest of the book", () => {
    const seal = sealMrvReport(report);
    const p = mrvVoyageProof(report, "a");
    expect(p).not.toBeNull();
    expect(verifyMerkleProof(p!.leaf.hash, p!.proof, seal.merkleRoot)).toBe(true);
  });

  test("returns no proof for a voyage that isn't in the report", () => {
    expect(mrvVoyageProof(report, "nope")).toBeNull();
  });

  test("sealing an unmonitored report still seals — it just seals the gaps", () => {
    const bare = buildMrvAnnualReport({ ...BASE, voyages: [voyage()] });
    const seal = sealMrvReport(bare);
    expect(seal.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyMrvSeal(bare, seal.merkleRoot)).toBe(true);
  });
});

describe("buildMrvAnnualReport — empty period", () => {
  test("an empty book is not a zero-emissions report", () => {
    const r = buildMrvAnnualReport({ ...BASE, voyages: [] });
    expect(r.aggregates.totalCo2Tonnes).toBeNull();
    expect(r.submittable).toBe(false);
    expect(r.dataGaps.some((g) => g.includes("No voyages"))).toBe(true);
  });
});
