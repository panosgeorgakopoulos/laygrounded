// Maritime carbon & asset-liability engine.
//
// Consolidates five environmental modules behind one pure surface:
//   * CII asset degradation  — how a port delay's auxiliary fuel burn moves
//     the vessel's annual Carbon Intensity Indicator and whether the rating
//     band drops (MARPOL Annex VI Reg. 28, IMO MEPC.353/354/355(78));
//   * predictive biofouling  — idle days in warm water grow hull drag, which
//     taxes every future sea day in fuel, cash and CO2;
//   * SFTW emissions arbiter — isolates Sail-Fast-Then-Wait waste: the fuel a
//     sprint into known congestion burned versus a just-in-time arrival;
//   * MRV/ETS ledger entries — audited at-berth emission rows for the
//     compliance_ledger (signed downstream by the legal notary);
//   * green performance twin — the counterfactual "clean" voyage, aggregating
//     the avoidable levers above into one savings statement.
//
// Same discipline as the laytime engine: pure TypeScript, no I/O, no AI, no
// Supabase; deterministic for identical inputs. All fuel-mass and money
// arithmetic runs through decimal.js — carbon balances compound across
// voyages and must not accumulate float error. Every result carries an
// `evidence` array citing the regulation or clause it rests on, mirroring
// the engine's clause_ref convention.

import { Decimal } from "decimal.js";
import { computeEtsEstimate, defaultEuaPriceEur, ETS_DEFAULTS } from "./ets";
import type { EtsEstimate } from "./ets";

// === Defaults (every value documented and overridable) ===
export const CARBON_DEFAULTS = {
  // IMO TtW (tank-to-wake) CO2 factor for HFO — shared with the ETS module.
  CO2_PER_TONNE_FUEL: ETS_DEFAULTS.CO2_PER_TONNE_FUEL,
  // WtT (well-to-tank / upstream) CO2e per tonne HFO: WtW 3.89 − TtW 3.114.
  // This is the Scope 3 slice a charterer reports on top of the MRV figure.
  SCOPE3_CO2_PER_TONNE_FUEL: 0.776,
  // VLSFO bunker price used when the caller has no live quote (USD/t).
  FUEL_PRICE_USD_PER_TONNE: 620,
  // Assumed annual charter-desirability discount per CII band dropped (EUR):
  // a D or E rated vessel takes a hire/utilization haircut and must file a
  // corrective action plan. Deliberately conservative; override per fleet.
  DOWNGRADE_LIABILITY_EUR_PER_BAND: 150_000,
  // Biofouling growth model (documented heuristic, not a CFD result):
  // hull drag grows linearly with idle days at the reference temperature and
  // doubles per +10°C of sea-surface temperature (marine growth kinetics),
  // capped at a heavily-fouled ceiling.
  FOULING_DRAG_PCT_PER_IDLE_DAY: 0.12,
  FOULING_REFERENCE_TEMP_C: 15,
  FOULING_TEMP_DOUBLING_C: 10,
  FOULING_MAX_DRAG_PCT: 40,
  // Forward horizon over which a fouled hull taxes fuel before the next
  // scheduled cleaning (sea days, not calendar days).
  FORWARD_SEA_DAYS: 180,
  // In-water hull cleaning: dive team + one off-hire day, all-in (USD).
  HULL_CLEANING_COST_USD: 45_000,
  // EU ETS coverage applied to at-sea emissions (voyage-mix assumption:
  // 100% intra-EU / 50% in-out averages to ~0.5; at-berth coverage stays
  // 1.0 via the ETS module).
  AT_SEA_ETS_COVERAGE: 0.5,
  // SFTW detection: waits shorter than this are ordinary port friction, not
  // a sprint into known congestion.
  SFTW_MIN_CONGESTION_HOURS: 6,
  // Slowest commercially plausible steaming speed for the JIT counterfactual.
  MIN_STEAMING_SPEED_KNOTS: 8,
} as const;

// IMO MEPC.354(78) dd rating boundaries for bulk carriers, expressed as
// attained/required CII ratios: ≤d1 → A, ≤d2 → B, ≤d3 → C, ≤d4 → D, else E.
export const CII_RATING_BOUNDARIES = { d1: 0.86, d2: 0.94, d3: 1.06, d4: 1.18 } as const;

export type CiiRating = "A" | "B" | "C" | "D" | "E";
const CII_RATING_ORDER: CiiRating[] = ["A", "B", "C", "D", "E"];

export interface CarbonEvidence {
  clause_ref: string;
  finding: string;
  quantum?: { value: number; unit: string };
}

// Shape of vessel_analytics_profiles.consumption_curve (jsonb).
export interface ConsumptionCurve {
  at_berth_aux_tonnes_per_day: number;
  sea_curve: Array<{ speed_knots: number; tonnes_per_day: number }>;
}

const d = (n: number | Decimal) => new Decimal(n);
const money = (x: Decimal) => x.toDecimalPlaces(2).toNumber();
const mass = (x: Decimal) => x.toDecimalPlaces(3).toNumber();

// Propulsion fuel at an arbitrary speed via the admiralty cube law anchored
// to the nearest measured point on the vessel's curve:
//   cons(v) = cons(v0) × (v / v0)³
export function seaConsumptionTpd(curve: ConsumptionCurve, speedKnots: number): Decimal {
  if (!curve.sea_curve.length) throw new Error("INVALID_CONSUMPTION_CURVE");
  if (speedKnots <= 0) throw new Error("INVALID_SPEED");
  const anchor = curve.sea_curve.reduce((best, p) =>
    Math.abs(p.speed_knots - speedKnots) < Math.abs(best.speed_knots - speedKnots) ? p : best
  );
  return d(anchor.tonnes_per_day).mul(d(speedKnots).div(anchor.speed_knots).pow(3));
}

export function ciiRatingFromRatio(attainedOverRequired: Decimal): CiiRating {
  const b = CII_RATING_BOUNDARIES;
  if (attainedOverRequired.lte(b.d1)) return "A";
  if (attainedOverRequired.lte(b.d2)) return "B";
  if (attainedOverRequired.lte(b.d3)) return "C";
  if (attainedOverRequired.lte(b.d4)) return "D";
  return "E";
}

// === 1. CII asset degradation ===

export interface CiiBaseline {
  attainedCii: number; // gCO2 / dwt·nm, before this delay
  requiredCii: number; // gCO2 / dwt·nm for the compliance year
  dwt: number;
  annualDistanceNm: number;
}

export interface CiiDegradationInput {
  delayHours: number;
  baseCii: CiiBaseline;
  consumptionCurve: ConsumptionCurve;
  co2PerTonneFuel?: number;
  downgradeLiabilityEurPerBand?: number;
}

export interface CiiDegradationResult {
  extraFuelTonnes: number;
  extraCo2Tonnes: number;
  attainedCiiBefore: number;
  attainedCiiAfter: number;
  ratingBefore: CiiRating;
  ratingAfter: CiiRating;
  ratingDropped: boolean;
  bandsDropped: number;
  carbonDowngradeLiabilityEur: number;
  evidence: CarbonEvidence[];
}

// A delay at berth adds auxiliary-engine CO2 to the numerator of the annual
// CII while adding zero transport work to the denominator — attained CII can
// only rise. When the rise crosses a MEPC.354(78) band boundary, the vessel
// itself has been financially degraded and a Carbon Downgrade Liability is
// emitted as a claimable quantum.
export function calculateCiiDegradation(input: CiiDegradationInput): CiiDegradationResult {
  const { baseCii, consumptionCurve } = input;
  if (baseCii.dwt <= 0 || baseCii.annualDistanceNm <= 0 || baseCii.requiredCii <= 0) {
    throw new Error("INVALID_CII_BASELINE");
  }
  const delayHours = Math.max(0, input.delayHours);
  const co2Factor = input.co2PerTonneFuel ?? CARBON_DEFAULTS.CO2_PER_TONNE_FUEL;
  const liabilityPerBand =
    input.downgradeLiabilityEurPerBand ?? CARBON_DEFAULTS.DOWNGRADE_LIABILITY_EUR_PER_BAND;

  const extraFuel = d(delayHours).div(24).mul(consumptionCurve.at_berth_aux_tonnes_per_day);
  const extraCo2 = extraFuel.mul(co2Factor);
  // grams over annual transport work (dwt·nm)
  const deltaCii = extraCo2.mul(1e6).div(d(baseCii.dwt).mul(baseCii.annualDistanceNm));

  const attainedBefore = d(baseCii.attainedCii);
  const attainedAfter = attainedBefore.add(deltaCii);
  const ratingBefore = ciiRatingFromRatio(attainedBefore.div(baseCii.requiredCii));
  const ratingAfter = ciiRatingFromRatio(attainedAfter.div(baseCii.requiredCii));
  const bandsDropped = Math.max(
    0,
    CII_RATING_ORDER.indexOf(ratingAfter) - CII_RATING_ORDER.indexOf(ratingBefore)
  );
  const liability = d(bandsDropped).mul(liabilityPerBand);

  const evidence: CarbonEvidence[] = [
    {
      clause_ref: "MARPOL-VI-Reg28",
      finding: `${delayHours}h at berth burned ${mass(extraFuel)} t auxiliary fuel with zero transport work, raising attained CII from ${attainedBefore.toDecimalPlaces(4)} to ${attainedAfter.toDecimalPlaces(4)} gCO2/dwt·nm.`,
      quantum: { value: mass(extraCo2), unit: "tCO2" },
    },
    {
      clause_ref: "IMO-MEPC.354(78)",
      finding: `Rating band ${ratingBefore} → ${ratingAfter} against required CII ${baseCii.requiredCii} (boundaries d1–d4 = ${Object.values(CII_RATING_BOUNDARIES).join("/")}).`,
    },
  ];
  if (bandsDropped > 0) {
    evidence.push({
      clause_ref: "CII-DOWNGRADE-LIABILITY",
      finding: `Carbon Downgrade Liability: ${bandsDropped} band(s) lost at an assumed ${liabilityPerBand} EUR/band annual charter-desirability discount.`,
      quantum: { value: money(liability), unit: "EUR" },
    });
  }

  return {
    extraFuelTonnes: mass(extraFuel),
    extraCo2Tonnes: mass(extraCo2),
    attainedCiiBefore: attainedBefore.toDecimalPlaces(4).toNumber(),
    attainedCiiAfter: attainedAfter.toDecimalPlaces(4).toNumber(),
    ratingBefore,
    ratingAfter,
    ratingDropped: bandsDropped > 0,
    bandsDropped,
    carbonDowngradeLiabilityEur: money(liability),
    evidence,
  };
}

// === 2. Predictive biofouling ===

export interface BiofoulingInput {
  portLabel: string;
  idleDays: number;
  // Local sea-surface temperature during the idle window — the caller looks
  // this up (Open-Meteo marine archive / port table); the model stays pure.
  seaSurfaceTempC: number;
  consumptionCurve: ConsumptionCurve;
  serviceSpeedKnots: number;
  forwardSeaDays?: number;
  fuelPriceUsdPerTonne?: number;
  euaPriceEur?: number;
  hullCleaningCostUsd?: number;
}

export interface BiofoulingResult {
  dragIncreasePct: number;
  extraFuelTonnes: number;
  extraFuelCostUsd: number;
  extraCo2Tonnes: number;
  etsLiabilityEur: number;
  cleaningRecommended: boolean;
  netSavingIfCleanedUsdEquivalent: number;
  evidence: CarbonEvidence[];
}

// Idle days at anchor grow a fouling layer whose hydrodynamic drag taxes
// every future sea day. Growth model (documented heuristic): drag rises
// FOULING_DRAG_PCT_PER_IDLE_DAY per idle day at 15°C, doubling per +10°C of
// local water temperature (clamped ×0.25–×4), capped at the heavily-fouled
// ceiling. Added drag converts ~1:1 into added propulsion fuel at constant
// speed (deliberate first-order simplification).
export function calculateBiofoulingPenalty(input: BiofoulingInput): BiofoulingResult {
  const idleDays = Math.max(0, input.idleDays);
  const fuelPrice = input.fuelPriceUsdPerTonne ?? CARBON_DEFAULTS.FUEL_PRICE_USD_PER_TONNE;
  const euaPrice = input.euaPriceEur ?? defaultEuaPriceEur();
  const cleaningCost = input.hullCleaningCostUsd ?? CARBON_DEFAULTS.HULL_CLEANING_COST_USD;
  const horizon = input.forwardSeaDays ?? CARBON_DEFAULTS.FORWARD_SEA_DAYS;

  const tempFactor = Decimal.min(
    Decimal.max(
      d(2).pow(
        d(input.seaSurfaceTempC)
          .sub(CARBON_DEFAULTS.FOULING_REFERENCE_TEMP_C)
          .div(CARBON_DEFAULTS.FOULING_TEMP_DOUBLING_C)
      ),
      0.25
    ),
    4
  );
  const dragPct = Decimal.min(
    d(idleDays).mul(CARBON_DEFAULTS.FOULING_DRAG_PCT_PER_IDLE_DAY).mul(tempFactor),
    CARBON_DEFAULTS.FOULING_MAX_DRAG_PCT
  );

  const baseTpd = seaConsumptionTpd(input.consumptionCurve, input.serviceSpeedKnots);
  const extraFuel = baseTpd.mul(dragPct).div(100).mul(horizon);
  const extraFuelCost = extraFuel.mul(fuelPrice);
  const extraCo2 = extraFuel.mul(CARBON_DEFAULTS.CO2_PER_TONNE_FUEL);
  const etsLiability = extraCo2.mul(euaPrice).mul(CARBON_DEFAULTS.AT_SEA_ETS_COVERAGE);

  // EUR/USD deliberately not converted (pure module, no FX feed): the
  // recommendation treats them as commensurable order-of-magnitude costs and
  // says so in the evidence.
  const netSaving = extraFuelCost.add(etsLiability).sub(cleaningCost);
  const cleaningRecommended = idleDays > 0 && netSaving.gt(0);

  const evidence: CarbonEvidence[] = [
    {
      clause_ref: "IMO-MEPC.378(80)",
      finding: `${idleDays} idle day(s) at ${input.portLabel} in ${input.seaSurfaceTempC}°C water predicts +${dragPct.toDecimalPlaces(2)}% hull drag (growth ×${tempFactor.toDecimalPlaces(2)} vs ${CARBON_DEFAULTS.FOULING_REFERENCE_TEMP_C}°C reference).`,
    },
    {
      clause_ref: "BIOFOULING-FUEL-PENALTY",
      finding: `Over the next ${horizon} sea days at ${input.serviceSpeedKnots} kn this drag costs ${mass(extraFuel)} t fuel (${money(extraFuelCost)} USD) and ${mass(extraCo2)} tCO2 (${money(etsLiability)} EUR ETS at ${CARBON_DEFAULTS.AT_SEA_ETS_COVERAGE * 100}% coverage).`,
      quantum: { value: mass(extraFuel), unit: "t fuel" },
    },
    {
      clause_ref: "HULL-CLEANING-ECONOMICS",
      finding: cleaningRecommended
        ? `In-water cleaning at ~${cleaningCost} USD is justified: net saving ≈ ${money(netSaving)} (USD-equivalent, ETS EUR uncoverted).`
        : `Predicted penalty does not yet justify a ~${cleaningCost} USD cleaning.`,
    },
  ];

  return {
    dragIncreasePct: dragPct.toDecimalPlaces(2).toNumber(),
    extraFuelTonnes: mass(extraFuel),
    extraFuelCostUsd: money(extraFuelCost),
    extraCo2Tonnes: mass(extraCo2),
    etsLiabilityEur: money(etsLiability),
    cleaningRecommended,
    netSavingIfCleanedUsdEquivalent: money(netSaving),
    evidence,
  };
}

// === 3. Sail-Fast-Then-Wait emissions arbiter ===

export interface SftwInput {
  distanceNm: number;
  actualSpeedKnots: number;
  // CP service/economical speed — the performance-warranty baseline.
  baseSpeedKnots: number;
  chartererOrders?: { orderedSpeedKnots?: number };
  // Hours the vessel then sat waiting on arrival (anchorage before NOR/berth).
  congestionHours: number;
  consumptionCurve: ConsumptionCurve;
  fuelPriceUsdPerTonne?: number;
  euaPriceEur?: number;
}

export interface SftwRestitutionClaim {
  headline: string;
  amountUsd: number;
  etsAmountEur: number;
  wastedFuelTonnes: number;
  wastedCo2Tonnes: number;
  basis: string[];
}

export interface SftwResult {
  detected: boolean;
  actualSpeedKnots: number;
  jitSpeedKnots: number;
  fuelActualTonnes: number;
  fuelWaitingTonnes: number;
  fuelJitTonnes: number;
  wastedFuelTonnes: number;
  wastedCo2Tonnes: number;
  restitutionClaim: SftwRestitutionClaim | null;
  evidence: CarbonEvidence[];
}

// Compares the leg as sailed (sprint + wait at anchor) against the just-in-
// time counterfactual: the slower speed that would have consumed the whole
// congestion window in transit and arrived as the berth opened. Cube-law
// fuel at both speeds plus auxiliary burn while waiting; the difference is
// fuel bought for nothing — the restitution quantum.
export function arbitrateSftw(input: SftwInput): SftwResult {
  if (input.distanceNm <= 0 || input.actualSpeedKnots <= 0) {
    throw new Error("INVALID_SFTW_INPUT");
  }
  const fuelPrice = input.fuelPriceUsdPerTonne ?? CARBON_DEFAULTS.FUEL_PRICE_USD_PER_TONNE;
  const euaPrice = input.euaPriceEur ?? defaultEuaPriceEur();
  const congestionHours = Math.max(0, input.congestionHours);

  const hoursActual = d(input.distanceNm).div(input.actualSpeedKnots);
  const hoursAvailable = hoursActual.add(congestionHours);
  const jitSpeed = Decimal.max(
    d(input.distanceNm).div(hoursAvailable),
    CARBON_DEFAULTS.MIN_STEAMING_SPEED_KNOTS
  );

  const fuelActual = seaConsumptionTpd(input.consumptionCurve, input.actualSpeedKnots)
    .mul(hoursActual)
    .div(24);
  const fuelWaiting = d(input.consumptionCurve.at_berth_aux_tonnes_per_day)
    .mul(congestionHours)
    .div(24);
  const hoursJit = d(input.distanceNm).div(jitSpeed);
  const fuelJit = seaConsumptionTpd(input.consumptionCurve, jitSpeed.toNumber())
    .mul(hoursJit)
    .div(24);

  const wastedFuel = Decimal.max(fuelActual.add(fuelWaiting).sub(fuelJit), 0);
  const wastedCo2 = wastedFuel.mul(CARBON_DEFAULTS.CO2_PER_TONNE_FUEL);
  const detected =
    congestionHours >= CARBON_DEFAULTS.SFTW_MIN_CONGESTION_HOURS && wastedFuel.gt(0.05);

  const evidence: CarbonEvidence[] = [
    {
      clause_ref: "CP-UTMOST-DESPATCH",
      finding: `Vessel steamed ${input.distanceNm} nm at ${input.actualSpeedKnots} kn then waited ${congestionHours}h; a just-in-time arrival needed only ${jitSpeed.toDecimalPlaces(2)} kn.`,
    },
    {
      clause_ref: "EU-MRV-2015/757",
      finding: `Sprint + anchorage burn ${mass(fuelActual.add(fuelWaiting))} t vs JIT ${mass(fuelJit)} t — ${mass(wastedFuel)} t fuel (${mass(wastedCo2)} tCO2) attributable to sailing fast into known congestion.`,
      quantum: { value: mass(wastedCo2), unit: "tCO2" },
    },
  ];

  const ordered = input.chartererOrders?.orderedSpeedKnots;
  if (ordered !== undefined && input.actualSpeedKnots > ordered) {
    evidence.push({
      clause_ref: "CP-SPEED-ORDERS",
      finding: `Actual speed ${input.actualSpeedKnots} kn exceeded the charterer's ordered ${ordered} kn — the excess burn is outside orders.`,
    });
  }

  let restitutionClaim: SftwRestitutionClaim | null = null;
  if (detected) {
    const amountUsd = wastedFuel.mul(fuelPrice);
    const etsEur = wastedCo2.mul(euaPrice).mul(CARBON_DEFAULTS.AT_SEA_ETS_COVERAGE);
    restitutionClaim = {
      headline: `Restitution for Sail-Fast-Then-Wait waste: ${mass(wastedFuel)} t fuel / ${mass(wastedCo2)} tCO2`,
      amountUsd: money(amountUsd),
      etsAmountEur: money(etsEur),
      wastedFuelTonnes: mass(wastedFuel),
      wastedCo2Tonnes: mass(wastedCo2),
      basis: evidence.map((e) => `${e.clause_ref}: ${e.finding}`),
    };
  }

  return {
    detected,
    actualSpeedKnots: input.actualSpeedKnots,
    jitSpeedKnots: jitSpeed.toDecimalPlaces(2).toNumber(),
    fuelActualTonnes: mass(fuelActual),
    fuelWaitingTonnes: mass(fuelWaiting),
    fuelJitTonnes: mass(fuelJit),
    wastedFuelTonnes: mass(wastedFuel),
    wastedCo2Tonnes: mass(wastedCo2),
    restitutionClaim,
    evidence,
  };
}

// === 4. MRV/ETS compliance-ledger entries ===

export interface MrvLedgerInput {
  delayHours: number;
  fuelTonnesPerDay?: number;
  euaPriceEur?: number;
}

// Payload for a compliance_ledger row (unsigned — the legal notary in
// src/lib/legal/prosecution.ts computes cryptographic_signature over it).
export interface MrvLedgerEntry {
  entry_kind: "mrv_ets";
  mrv_co2_tonnes: number;
  scope3_co2_tonnes: number;
  eua_liability_eur: number;
  details: {
    delay_hours: number;
    fuel_tonnes: number;
    ets: EtsEstimate;
  };
  evidence: CarbonEvidence[];
}

export function buildMrvLedgerEntry(input: MrvLedgerInput): MrvLedgerEntry {
  const ets = computeEtsEstimate({
    delayHours: input.delayHours,
    fuelTonnesPerDay: input.fuelTonnesPerDay,
    euaPriceEur: input.euaPriceEur,
  });
  const fuelTonnes = d(ets.delayHours).div(24).mul(ets.fuelTonnesPerDay);
  const scope3 = fuelTonnes.mul(CARBON_DEFAULTS.SCOPE3_CO2_PER_TONNE_FUEL);

  return {
    entry_kind: "mrv_ets",
    mrv_co2_tonnes: ets.co2Tonnes,
    scope3_co2_tonnes: mass(scope3),
    eua_liability_eur: ets.estimatedCostEur,
    details: {
      delay_hours: ets.delayHours,
      fuel_tonnes: mass(fuelTonnes),
      ets,
    },
    evidence: [
      {
        clause_ref: "EU-MRV-2015/757",
        finding: `${ets.delayHours}h at berth → ${mass(fuelTonnes)} t fuel → ${ets.co2Tonnes} tCO2 (TtW) reportable under MRV.`,
        quantum: { value: ets.co2Tonnes, unit: "tCO2" },
      },
      {
        clause_ref: "EU-ETS-2003/87-Art3ga",
        finding: `EUA surrender liability ${ets.estimatedCostEur} EUR at ${ets.euaPriceEur} EUR/tCO2, ${ets.coveragePct * 100}% at-berth coverage.`,
        quantum: { value: ets.estimatedCostEur, unit: "EUR" },
      },
      {
        clause_ref: "GHG-PROTOCOL-SCOPE3",
        finding: `Upstream (well-to-tank) slice ${mass(scope3)} tCO2e at ${CARBON_DEFAULTS.SCOPE3_CO2_PER_TONNE_FUEL} tCO2e/t fuel.`,
        quantum: { value: mass(scope3), unit: "tCO2e" },
      },
    ],
  };
}

// === 5. Green performance twin ===

export interface GreenTwinInput {
  cii?: CiiDegradationResult;
  biofouling?: BiofoulingResult;
  sftw?: SftwResult;
  mrv?: MrvLedgerEntry;
}

export interface GreenTwinLever {
  lever: string;
  avoidableCo2Tonnes: number;
  avoidableCostUsdEquivalent: number;
}

export interface GreenTwinResult {
  totalAvoidableCo2Tonnes: number;
  totalAvoidableCostUsdEquivalent: number;
  levers: GreenTwinLever[]; // ranked, largest cost first
  evidence: CarbonEvidence[];
}

// The "twin" is the same voyage with every avoidable lever pulled: no sprint,
// clean hull, delay-free berth stay. Aggregation only — each component keeps
// its own model assumptions and evidence.
export function computeGreenTwin(input: GreenTwinInput): GreenTwinResult {
  const levers: GreenTwinLever[] = [];
  const evidence: CarbonEvidence[] = [];

  if (input.sftw?.detected && input.sftw.restitutionClaim) {
    levers.push({
      lever: "eliminate_sftw_sprint",
      avoidableCo2Tonnes: input.sftw.wastedCo2Tonnes,
      avoidableCostUsdEquivalent: input.sftw.restitutionClaim.amountUsd,
    });
    evidence.push(...input.sftw.evidence);
  }
  if (input.biofouling && input.biofouling.extraCo2Tonnes > 0) {
    levers.push({
      lever: "clean_hull_before_next_voyage",
      avoidableCo2Tonnes: input.biofouling.extraCo2Tonnes,
      avoidableCostUsdEquivalent: input.biofouling.extraFuelCostUsd,
    });
    evidence.push(...input.biofouling.evidence);
  }
  if (input.mrv && input.mrv.mrv_co2_tonnes > 0) {
    levers.push({
      lever: "cut_at_berth_delay",
      avoidableCo2Tonnes: input.mrv.mrv_co2_tonnes,
      avoidableCostUsdEquivalent: input.mrv.eua_liability_eur,
    });
    evidence.push(...input.mrv.evidence);
  }
  if (input.cii?.ratingDropped) {
    levers.push({
      lever: "protect_cii_rating",
      avoidableCo2Tonnes: input.cii.extraCo2Tonnes,
      avoidableCostUsdEquivalent: input.cii.carbonDowngradeLiabilityEur,
    });
    evidence.push(...input.cii.evidence);
  }

  levers.sort((a, b) => b.avoidableCostUsdEquivalent - a.avoidableCostUsdEquivalent);
  const totalCo2 = levers.reduce((acc, l) => acc.add(l.avoidableCo2Tonnes), d(0));
  const totalCost = levers.reduce((acc, l) => acc.add(l.avoidableCostUsdEquivalent), d(0));

  return {
    totalAvoidableCo2Tonnes: mass(totalCo2),
    totalAvoidableCostUsdEquivalent: money(totalCost),
    levers,
    evidence,
  };
}

// === Facade ===
// Stateless facade over the pure functions above; construct once with fleet
// overrides (fuel price desk quote, liability policy) and reuse.
export class MaritimeCarbonEngine {
  constructor(
    private readonly overrides: {
      fuelPriceUsdPerTonne?: number;
      euaPriceEur?: number;
      downgradeLiabilityEurPerBand?: number;
    } = {}
  ) {}

  calculateCiiDegradation(input: CiiDegradationInput): CiiDegradationResult {
    return calculateCiiDegradation({
      downgradeLiabilityEurPerBand: this.overrides.downgradeLiabilityEurPerBand,
      ...input,
    });
  }

  calculateBiofoulingPenalty(input: BiofoulingInput): BiofoulingResult {
    return calculateBiofoulingPenalty({
      fuelPriceUsdPerTonne: this.overrides.fuelPriceUsdPerTonne,
      euaPriceEur: this.overrides.euaPriceEur,
      ...input,
    });
  }

  arbitrateSftw(input: SftwInput): SftwResult {
    return arbitrateSftw({
      fuelPriceUsdPerTonne: this.overrides.fuelPriceUsdPerTonne,
      euaPriceEur: this.overrides.euaPriceEur,
      ...input,
    });
  }

  buildMrvLedgerEntry(input: MrvLedgerInput): MrvLedgerEntry {
    return buildMrvLedgerEntry({ euaPriceEur: this.overrides.euaPriceEur, ...input });
  }

  computeGreenTwin(input: GreenTwinInput): GreenTwinResult {
    return computeGreenTwin(input);
  }
}
