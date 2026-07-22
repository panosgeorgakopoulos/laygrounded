// EU MRV annual report — the format, without the fabrication.
//
// Regulation (EU) 2015/757 reports per-voyage FUEL CONSUMPTION, measured by
// one of four approved monitoring methods (Annex I Part B): bunker delivery
// notes with periodic tank stocktakes, on-board tank monitoring, flow meters,
// or direct CO2 measurement. From that it derives CO2, and pairs it with
// distance, time at sea, cargo carried and transport work.
//
// This system holds none of that. It holds laytime events and an *assumed*
// auxiliary burn rate (ets.ts, 4 t/day by default) whose own header says it
// is "an estimate for exposure awareness — not a verified MRV figure". So
// this module's central rule:
//
//   A CO2 or fuel figure is emitted ONLY where measured fuel was supplied.
//   Nothing is ever inferred from the assumed burn rate. A field we cannot
//   monitor is reported as NOT MONITORED — never as zero, never as an
//   estimate wearing a regulatory format.
//
// What the report therefore does: emits the real Annex I/II structure, fills
// what the SoF genuinely evidences (port call, at-berth window, and its AIS
// provenance), names every gap precisely, and computes `submittable` — which
// is false until the gaps are closed. It is a map of the distance to a
// submittable report, not a substitute for one.
//
// It never self-certifies. Only an accredited verifier can verify an MRV
// report, and submission goes through THETIS-MRV; `verification.status` is
// hard-coded "unverified" and there is no code path that sets it otherwise.
//
// Pure module: no I/O. The route owns loading and sealing.

import { Decimal } from "decimal.js";
import {
  buildMerkleLevels,
  leafMaterial,
  sha256Hex,
  SNAPSHOT_ALGO,
  type MerkleProofStep,
  merkleProof,
} from "@/lib/legal/prosecution";
import type { EventTypeEnum } from "@/lib/laytime/types";

// Reg (EU) 2015/757 Annex I, Part A — CO2 emission factors (tCO2 per t fuel).
// Tank-to-wake, the basis MRV reports on.
export const EU_MRV_EMISSION_FACTORS = {
  HFO: 3.114,
  LFO: 3.151,
  "MDO/MGO": 3.206,
  "LPG-propane": 3.0,
  "LPG-butane": 3.03,
  LNG: 2.75,
  methanol: 1.375,
  ethanol: 1.913,
} as const;

export type MrvFuelType = keyof typeof EU_MRV_EMISSION_FACTORS;

// Annex I Part B monitoring methods. A measured figure must say how it was
// measured — an unattributed number is not monitoring data.
export type MrvMonitoringMethod =
  | "BDN_AND_TANK_STOCKTAKE"
  | "ON_BOARD_TANK_MONITORING"
  | "FLOW_METERS"
  | "DIRECT_CO2_MEASUREMENT";

export interface MrvFuelEntry {
  fuelType: MrvFuelType;
  tonnes: number;
  phase: "at_sea" | "at_berth";
  method: MrvMonitoringMethod;
}

// Provenance of the at-berth window — the one quantity the SoF evidences.
// AIS is what makes it independently corroborated; its absence is a stated
// gap, not a silent pass (mirrors the geofence three-state posture).
export type BerthProvenance =
  | "ais_corroborated"
  | "ais_contradicted"
  | "ais_unavailable"
  | "no_confirmed_events";

export interface MrvVoyageInput {
  claimId: string;
  voyageRef: string;
  vessel: string;
  vesselImo: string | null;
  port: string;
  // Confirmed events only: an unreviewed event cannot evidence a regulatory
  // figure.
  events: Array<{ event_type: EventTypeEnum; occurred_at: string; ais_geofence_verified?: boolean | null }>;
  // Measured bunker data. Absent → fuel and CO2 stay NOT MONITORED.
  fuel?: MrvFuelEntry[];
  // Whether the port of call is in the EEA. EU ETS at-berth liability only
  // arises in an EEA port; `port` is free text here ("Port Hedland, AU"), so
  // this cannot be derived and is an explicit input. Undefined → unknown, and
  // no liability is asserted either way.
  eeaPort?: boolean;
  // Reg 2015/757 requires these per voyage; nothing in this system measures
  // them, but the seams exist so a tenant feeding real data gets real rows.
  distanceNm?: number;
  timeAtSeaHours?: number;
  cargoTonnes?: number;
}

export type FieldStatus = "monitored" | "not_monitored";

export interface MrvFieldReport {
  field: string;
  status: FieldStatus;
  // Why it isn't monitored, in terms an auditor or an engineer can act on.
  note: string;
}

export interface MrvVoyageRow {
  claimId: string;
  voyageRef: string;
  vessel: string;
  vesselImo: string | null;
  portOfCall: string;
  eeaPort: boolean | null;
  arrivalUtc: string | null;
  departureUtc: string | null;
  hoursAtBerth: number | null;
  berthProvenance: BerthProvenance;
  // Present only when measured fuel was supplied.
  fuelTonnesByType: Partial<Record<MrvFuelType, number>> | null;
  co2Tonnes: number | null;
  co2AtBerthTonnes: number | null;
  co2AtSeaTonnes: number | null;
  monitoringMethods: MrvMonitoringMethod[];
  distanceNm: number | null;
  timeAtSeaHours: number | null;
  cargoTonnes: number | null;
  transportWorkTonneNm: number | null;
  gaps: string[];
  submittable: boolean;
}

export interface MrvAnnualReport {
  regulation: string;
  reportingPeriod: number;
  generatedAt: string;
  company: { name: string };
  ships: Array<{
    vessel: string;
    vesselImo: string | null;
    grossTonnage: number | null;
    iceClass: string | null;
    voyageCount: number;
  }>;
  voyages: MrvVoyageRow[];
  aggregates: {
    // Null unless EVERY voyage in the period carries measured fuel: a total
    // over a subset would read as the period's emissions and be wrong.
    totalFuelTonnes: number | null;
    totalCo2Tonnes: number | null;
    totalCo2AtBerthEeaTonnes: number | null;
    totalDistanceNm: number | null;
    totalTimeAtSeaHours: number | null;
    transportWorkTonneNm: number | null;
    co2PerDistance: number | null;
    voyagesWithMeasuredFuel: number;
    voyagesTotal: number;
  };
  monitoring: MrvFieldReport[];
  dataGaps: string[];
  // False until every required field is monitored for every voyage. There is
  // no input that forces this true.
  submittable: boolean;
  verification: {
    status: "unverified";
    verifier: null;
    statement: string;
  };
}

export const MRV_UNVERIFIED_STATEMENT =
  "This report has NOT been verified. Under Regulation (EU) 2015/757 an emissions report must be assessed by an accredited MRV verifier, who issues the verification statement, before submission via THETIS-MRV. Cryptographic sealing proves this document has not been altered since it was generated; it is not verification and confers no regulatory standing.";

const BERTH_START: EventTypeEnum[] = ["ALL_FAST", "BERTHED"];
const BERTH_END: EventTypeEnum[] = ["COMPLETED_LOADING", "COMPLETED_DISCHARGE"];

function ts(iso: string): number {
  return new Date(iso).getTime();
}

// The at-berth window from confirmed events: first made-fast/berthed to last
// cargo completion. This is the one quantity the SoF genuinely evidences.
function berthWindow(events: MrvVoyageInput["events"]): {
  arrival: string | null;
  departure: string | null;
  hours: number | null;
} {
  const valid = events.filter((e) => !Number.isNaN(ts(e.occurred_at)));
  const starts = valid
    .filter((e) => BERTH_START.includes(e.event_type))
    .sort((a, b) => ts(a.occurred_at) - ts(b.occurred_at));
  const ends = valid
    .filter((e) => BERTH_END.includes(e.event_type))
    .sort((a, b) => ts(a.occurred_at) - ts(b.occurred_at));

  const arrival = starts[0]?.occurred_at ?? null;
  const departure = ends[ends.length - 1]?.occurred_at ?? null;
  if (!arrival || !departure) return { arrival, departure, hours: null };

  const hours = (ts(departure) - ts(arrival)) / 3600_000;
  // A negative window means the chronology is broken; report no figure rather
  // than a nonsense one.
  return { arrival, departure, hours: hours >= 0 ? round(hours, 2) : null };
}

function provenanceOf(events: MrvVoyageInput["events"]): BerthProvenance {
  const positional = events.filter((e) => BERTH_START.includes(e.event_type));
  if (positional.length === 0) return "no_confirmed_events";
  if (positional.some((e) => e.ais_geofence_verified === false)) return "ais_contradicted";
  if (positional.every((e) => e.ais_geofence_verified === true)) return "ais_corroborated";
  return "ais_unavailable";
}

function round(n: Decimal.Value, dp = 3): number {
  return new Decimal(n).toDecimalPlaces(dp).toNumber();
}

export function co2FromFuel(entries: MrvFuelEntry[]): {
  total: Decimal;
  atBerth: Decimal;
  atSea: Decimal;
} {
  let total = new Decimal(0);
  let atBerth = new Decimal(0);
  let atSea = new Decimal(0);
  for (const e of entries) {
    const factor = EU_MRV_EMISSION_FACTORS[e.fuelType];
    const co2 = new Decimal(e.tonnes).mul(factor);
    total = total.add(co2);
    if (e.phase === "at_berth") atBerth = atBerth.add(co2);
    else atSea = atSea.add(co2);
  }
  return { total, atBerth, atSea };
}

function buildVoyageRow(v: MrvVoyageInput): MrvVoyageRow {
  const { arrival, departure, hours } = berthWindow(v.events);
  const berthProvenance = provenanceOf(v.events);
  const gaps: string[] = [];

  if (!v.vesselImo) gaps.push("Ship IMO number is missing — MRV data is reported per ship by IMO.");
  if (hours === null) {
    gaps.push(
      "At-berth window could not be derived from confirmed events (need a berthing/all-fast event and a cargo completion event)."
    );
  }
  if (berthProvenance === "ais_contradicted") {
    gaps.push(
      "AIS contradicts the berthing events underlying the at-berth window — the port call boundaries are disputed and must be resolved before the figure is reportable."
    );
  } else if (berthProvenance === "ais_unavailable") {
    gaps.push(
      "No AIS corroboration for the port call: the at-berth window rests on the Statement of Facts alone and is not independently corroborated."
    );
  }
  if (v.eeaPort === undefined) {
    gaps.push(
      `Cannot determine whether "${v.port}" is an EEA port. EU ETS at-berth liability and MRV scope depend on it; the port field is free text, so this must be supplied.`
    );
  }

  const measured = v.fuel && v.fuel.length > 0 ? v.fuel : null;
  let fuelTonnesByType: MrvVoyageRow["fuelTonnesByType"] = null;
  let co2Tonnes: number | null = null;
  let co2AtBerthTonnes: number | null = null;
  let co2AtSeaTonnes: number | null = null;
  let monitoringMethods: MrvMonitoringMethod[] = [];

  if (measured) {
    fuelTonnesByType = {};
    for (const e of measured) {
      fuelTonnesByType[e.fuelType] = round(
        new Decimal(fuelTonnesByType[e.fuelType] ?? 0).add(e.tonnes)
      );
    }
    const co2 = co2FromFuel(measured);
    co2Tonnes = round(co2.total);
    co2AtBerthTonnes = round(co2.atBerth);
    co2AtSeaTonnes = round(co2.atSea);
    monitoringMethods = [...new Set(measured.map((e) => e.method))];
  } else {
    // The central refusal. An estimate from the assumed burn rate would fill
    // this field and make the report look complete; it would also be a number
    // nobody measured, presented as a regulatory emissions figure.
    gaps.push(
      "Fuel consumption is NOT MONITORED: no measured bunker data supplied. Reg (EU) 2015/757 Annex I Part B requires BDN with tank stocktakes, tank monitoring, flow meters, or direct CO2 measurement. This system's at-berth burn rate is an assumption and is deliberately not used here."
    );
  }

  if (v.distanceNm === undefined) gaps.push("Distance travelled is NOT MONITORED.");
  if (v.timeAtSeaHours === undefined) gaps.push("Time at sea is NOT MONITORED.");
  if (v.cargoTonnes === undefined) gaps.push("Cargo carried is NOT MONITORED.");

  const transportWork =
    v.cargoTonnes !== undefined && v.distanceNm !== undefined
      ? round(new Decimal(v.cargoTonnes).mul(v.distanceNm))
      : null;

  return {
    claimId: v.claimId,
    voyageRef: v.voyageRef,
    vessel: v.vessel,
    vesselImo: v.vesselImo,
    portOfCall: v.port,
    eeaPort: v.eeaPort ?? null,
    arrivalUtc: arrival,
    departureUtc: departure,
    hoursAtBerth: hours,
    berthProvenance,
    fuelTonnesByType,
    co2Tonnes,
    co2AtBerthTonnes,
    co2AtSeaTonnes,
    monitoringMethods,
    distanceNm: v.distanceNm ?? null,
    timeAtSeaHours: v.timeAtSeaHours ?? null,
    cargoTonnes: v.cargoTonnes ?? null,
    transportWorkTonneNm: transportWork,
    gaps,
    submittable: gaps.length === 0,
  };
}

export interface MrvReportInput {
  companyName: string;
  reportingPeriod: number;
  voyages: MrvVoyageInput[];
  generatedAt?: Date;
}

export function buildMrvAnnualReport(input: MrvReportInput): MrvAnnualReport {
  const generatedAt = input.generatedAt ?? new Date();
  const voyages = input.voyages.map(buildVoyageRow);

  const byShip = new Map<string, MrvAnnualReport["ships"][number]>();
  for (const v of voyages) {
    const key = v.vesselImo ?? v.vessel;
    const s = byShip.get(key) ?? {
      vessel: v.vessel,
      vesselImo: v.vesselImo,
      // Ship particulars are not held by this system. Null means "not
      // monitored" — never 0, which would read as a measured gross tonnage.
      grossTonnage: null,
      iceClass: null,
      voyageCount: 0,
    };
    s.voyageCount++;
    byShip.set(key, s);
  }

  const measuredVoyages = voyages.filter((v) => v.co2Tonnes !== null);
  const allMeasured = voyages.length > 0 && measuredVoyages.length === voyages.length;

  // Totals only when every voyage is measured. A total over the measured
  // subset would be read as the period's emissions — understating them by
  // exactly the part nobody monitored.
  const sum = (pick: (v: MrvVoyageRow) => number | null): number | null => {
    if (!allMeasured) return null;
    let acc = new Decimal(0);
    for (const v of voyages) {
      const n = pick(v);
      if (n === null) return null;
      acc = acc.add(n);
    }
    return round(acc);
  };

  const totalCo2 = sum((v) => v.co2Tonnes);
  const totalFuel = allMeasured
    ? sum((v) =>
        v.fuelTonnesByType
          ? round(Object.values(v.fuelTonnesByType).reduce((a, b) => a + (b ?? 0), 0))
          : null
      )
    : null;
  const totalDistance = voyages.every((v) => v.distanceNm !== null) && voyages.length > 0
    ? sum((v) => v.distanceNm)
    : null;
  const totalTimeAtSea = voyages.every((v) => v.timeAtSeaHours !== null) && voyages.length > 0
    ? sum((v) => v.timeAtSeaHours)
    : null;
  const transportWork = voyages.every((v) => v.transportWorkTonneNm !== null) && voyages.length > 0
    ? sum((v) => v.transportWorkTonneNm)
    : null;

  // EEA at-berth CO2: only over voyages known to be EEA calls AND measured.
  const eeaKnown = voyages.every((v) => v.eeaPort !== null);
  const totalCo2AtBerthEea =
    allMeasured && eeaKnown && voyages.length > 0
      ? round(
          voyages
            .filter((v) => v.eeaPort === true)
            .reduce((acc, v) => acc.add(v.co2AtBerthTonnes ?? 0), new Decimal(0))
        )
      : null;

  const monitoring: MrvFieldReport[] = [
    {
      field: "Port of call and at-berth window",
      status: voyages.some((v) => v.hoursAtBerth !== null) ? "monitored" : "not_monitored",
      note: "Derived from confirmed Statement of Facts events; corroborated by AIS where a track is available.",
    },
    {
      field: "Fuel consumption by type (Annex I Part B)",
      status: allMeasured ? "monitored" : "not_monitored",
      note: allMeasured
        ? "Measured bunker data supplied for every voyage in the period."
        : `Measured for ${measuredVoyages.length} of ${voyages.length} voyage(s). No figure is derived from the system's assumed at-berth burn rate.`,
    },
    {
      field: "CO2 emitted",
      status: allMeasured ? "monitored" : "not_monitored",
      note: allMeasured
        ? "Computed from measured fuel using Reg (EU) 2015/757 Annex I emission factors."
        : "Cannot be reported without measured fuel consumption for every voyage.",
    },
    {
      field: "Distance travelled",
      status: totalDistance !== null ? "monitored" : "not_monitored",
      note: "Not held by this system; supply per voyage to populate.",
    },
    {
      field: "Time at sea",
      status: totalTimeAtSea !== null ? "monitored" : "not_monitored",
      note: "Not held by this system; supply per voyage to populate.",
    },
    {
      field: "Cargo carried and transport work",
      status: transportWork !== null ? "monitored" : "not_monitored",
      note: "Not held by this system; the cargo field is free-text description, not a monitored mass.",
    },
    {
      field: "Gross tonnage / ice class / technical efficiency",
      status: "not_monitored",
      note: "Ship particulars are not held by this system.",
    },
    {
      field: "Monitoring plan assessed by an accredited verifier",
      status: "not_monitored",
      note: "A monitoring plan is a precondition of MRV reporting and is out of scope of this system.",
    },
  ];

  const dataGaps: string[] = [];
  for (const f of monitoring) {
    if (f.status === "not_monitored") dataGaps.push(`${f.field}: ${f.note}`);
  }
  if (voyages.length === 0) {
    dataGaps.push(`No voyages with confirmed completion events fall in reporting period ${input.reportingPeriod}.`);
  }

  return {
    regulation: "Regulation (EU) 2015/757 (as amended by (EU) 2023/957)",
    reportingPeriod: input.reportingPeriod,
    generatedAt: generatedAt.toISOString(),
    company: { name: input.companyName },
    ships: [...byShip.values()],
    voyages,
    aggregates: {
      totalFuelTonnes: totalFuel,
      totalCo2Tonnes: totalCo2,
      totalCo2AtBerthEeaTonnes: totalCo2AtBerthEea,
      totalDistanceNm: totalDistance,
      totalTimeAtSeaHours: totalTimeAtSea,
      transportWorkTonneNm: transportWork,
      co2PerDistance:
        totalCo2 !== null && totalDistance !== null && totalDistance > 0
          ? round(new Decimal(totalCo2).div(totalDistance), 6)
          : null,
      voyagesWithMeasuredFuel: measuredVoyages.length,
      voyagesTotal: voyages.length,
    },
    monitoring,
    dataGaps,
    submittable: voyages.length > 0 && voyages.every((v) => v.submittable) && dataGaps.length === 0,
    verification: {
      status: "unverified",
      verifier: null,
      statement: MRV_UNVERIFIED_STATEMENT,
    },
  };
}

// === Cryptographic sealing ===
//
// What this does and does not do, stated once so it cannot be oversold: the
// Merkle root proves the sealed report has not been altered since `asOf`, and
// a per-leaf proof shows any single voyage row belongs to that root without
// disclosing the rest. That is integrity and selective disclosure.
//
// It is NOT verification, and it does not make the report audit-proof. It
// says nothing about whether the figures were measured correctly, or at all —
// an unmonitored field seals exactly as well as a monitored one. Sealing a
// report whose fuel is NOT MONITORED yields a tamper-evident record of the
// fact that it is not monitored.

export interface MrvSealLeaf {
  index: number;
  kind: "header" | "ship" | "voyage" | "aggregates" | "monitoring" | "verification";
  ref: string;
  hash: string;
}

export interface MrvSeal {
  algo: typeof SNAPSHOT_ALGO;
  asOf: string;
  reportingPeriod: number;
  merkleRoot: string;
  leafCount: number;
  leaves: MrvSealLeaf[];
  // Restated inside the seal so a detached root can never be presented as
  // proof of a verified report.
  submittable: boolean;
  verificationStatus: "unverified";
}

export function sealMrvReport(report: MrvAnnualReport): MrvSeal {
  const specs: Array<{ kind: MrvSealLeaf["kind"]; ref: string; body: unknown }> = [
    {
      kind: "header",
      ref: `${report.company.name}|${report.reportingPeriod}`,
      body: {
        regulation: report.regulation,
        reporting_period: report.reportingPeriod,
        company: report.company.name,
        as_of: report.generatedAt,
        algo: SNAPSHOT_ALGO,
      },
    },
    ...report.ships.map((s) => ({
      kind: "ship" as const,
      ref: s.vesselImo ?? s.vessel,
      body: s,
    })),
    ...report.voyages.map((v) => ({ kind: "voyage" as const, ref: v.claimId, body: v })),
    { kind: "aggregates", ref: "aggregates", body: report.aggregates },
    { kind: "monitoring", ref: "monitoring", body: report.monitoring },
    {
      kind: "verification",
      ref: "verification",
      body: { ...report.verification, submittable: report.submittable },
    },
  ];

  const leaves: MrvSealLeaf[] = specs.map((s, index) => ({
    index,
    kind: s.kind,
    ref: s.ref,
    hash: sha256Hex(leafMaterial(s.kind, s.ref, s.body)),
  }));
  const levels = buildMerkleLevels(leaves.map((l) => l.hash));

  return {
    algo: SNAPSHOT_ALGO,
    asOf: report.generatedAt,
    reportingPeriod: report.reportingPeriod,
    merkleRoot: levels[levels.length - 1][0],
    leafCount: leaves.length,
    leaves,
    submittable: report.submittable,
    verificationStatus: "unverified",
  };
}

// True iff the report as supplied still hashes to the sealed root.
export function verifyMrvSeal(report: MrvAnnualReport, expectedRoot: string): boolean {
  return sealMrvReport(report).merkleRoot === expectedRoot;
}

// Inclusion proof for one voyage row — lets a tenant disclose a single port
// call to a counterparty or authority without revealing the rest of the book.
export function mrvVoyageProof(
  report: MrvAnnualReport,
  claimId: string
): { leaf: MrvSealLeaf; proof: MerkleProofStep[] } | null {
  const seal = sealMrvReport(report);
  const leaf = seal.leaves.find((l) => l.kind === "voyage" && l.ref === claimId);
  if (!leaf) return null;
  return {
    leaf,
    proof: merkleProof(
      seal.leaves.map((l) => l.hash),
      leaf.index
    ),
  };
}
