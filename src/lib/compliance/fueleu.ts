// FuelEU Maritime — Regulation (EU) 2023/1805, in force from 1 January 2025.
//
// Where EU ETS (ets.ts) puts a PRICE on a ship's CO2, FuelEU puts a LIMIT on
// the greenhouse-gas INTENSITY of the energy it uses — grams of CO2-equivalent
// per megajoule, well-to-wake — tightening on a fixed trajectory out to 2050.
// A ship whose yearly energy mix is dirtier than the limit runs a compliance
// DEFICIT and pays a penalty; a cleaner mix banks a surplus. This module
// computes that balance and penalty from a fuel mix, so an operator can weigh a
// fixture's FuelEU exposure the same way they weigh its ETS exposure.
//
// Same discipline as the rest of src/lib/compliance: pure, deterministic, all
// mass/intensity/money arithmetic through decimal.js, every constant cited —
// and, crucially, it REFUSES to invent a well-to-wake factor for a fuel whose
// value depends on its production pathway (bio-/e-methanol spans ~90 → ~0
// gCO2eq/MJ). Those must be supplied per entry, exactly as mrv.ts will not
// guess a free-text port's country.

import { Decimal } from "decimal.js";
import type { CarbonEvidence } from "./carbon";

// The MRV fuel vocabulary (mrv.ts EU_MRV_EMISSION_FACTORS), kept in step so the
// two EU modules speak one fuel language. Declared locally rather than imported
// to avoid coupling to the Merkle-sealed MRV report.
export type FuelEuFuel =
  | "HFO"
  | "LFO"
  | "MDO/MGO"
  | "LNG"
  | "LPG-propane"
  | "LPG-butane"
  | "methanol"
  | "ethanol";

// Lower calorific value, MJ per tonne (FuelEU Annex I / Reg. 2015/757 Annex I).
export const FUELEU_LCV_MJ_PER_TONNE: Record<FuelEuFuel, number> = {
  HFO: 40_500,
  LFO: 41_000,
  "MDO/MGO": 42_700,
  LNG: 49_100,
  "LPG-propane": 46_000,
  "LPG-butane": 45_700,
  methanol: 19_900,
  ethanol: 26_800,
};

// Well-to-wake GHG intensity, gCO2eq/MJ — FOSSIL default pathways (Annex II).
// ONLY fuels whose fossil default is unambiguous are listed. A fuel absent here
// (LPG, methanol, ethanol) is pathway-dependent — its intensity swings with how
// it was produced — so computeFuelEu requires the value to be supplied per
// entry rather than fabricating one.
export const FUELEU_WTW_DEFAULT: Partial<Record<FuelEuFuel, number>> = {
  HFO: 91.6,
  LFO: 91.6,
  "MDO/MGO": 90.6,
  // LNG here is Otto-cycle, medium-speed dual-fuel on the fossil pathway. Other
  // LNG engine classes carry more methane slip and a HIGHER effective
  // intensity — supply wtwIntensity for those.
  LNG: 76.08,
};

// Penalty conversion (Annex IV): the deficit is expressed in tonnes of
// VLSFO-equivalent ENERGY and charged at a fixed rate.
const VLSFO_LCV_MJ_PER_TONNE = 41_000; // LCV of VLSFO
const PENALTY_EUR_PER_VLSFO_TONNE = 2400; // EUR per tonne VLSFOe

// 2020 fleet-average baseline (gCO2eq/MJ) and the reduction trajectory the
// yearly limit follows (Art. 4(2)).
export const FUELEU_BASELINE = 91.16;
const FUELEU_REDUCTIONS: ReadonlyArray<readonly [number, number]> = [
  [2025, 0.02],
  [2030, 0.06],
  [2035, 0.145],
  [2040, 0.31],
  [2045, 0.62],
  [2050, 0.8],
];

/** The reduction fraction applied to the baseline for a given year. */
export function fuelEuReduction(year: number): number {
  let reduction = 0;
  for (const [from, r] of FUELEU_REDUCTIONS) if (year >= from) reduction = r;
  return reduction;
}

/** The GHG-intensity limit (gCO2eq/MJ) for a year, or null before FuelEU applies. */
export function fuelEuLimit(year: number): number | null {
  if (year < 2025) return null; // the regulation applies from 2025
  return new Decimal(FUELEU_BASELINE)
    .mul(1 - fuelEuReduction(year))
    .toDecimalPlaces(4)
    .toNumber();
}

export interface FuelEuFuelEntry {
  fuel: FuelEuFuel;
  tonnes: number;
  // Override the well-to-wake GHG intensity (gCO2eq/MJ). REQUIRED for
  // pathway-dependent fuels (LPG/methanol/ethanol), and the way to declare a
  // certified bio-/e-fuel value for any fuel.
  wtwIntensity?: number;
}

export interface FuelEuInput {
  year: number;
  fuels: FuelEuFuelEntry[];
  // Override the €2400/t Annex IV rate should it be revised.
  penaltyEurPerTonne?: number;
}

export interface FuelEuFuelBreakdown {
  fuel: FuelEuFuel;
  tonnes: number;
  energyMJ: number;
  wtwIntensity: number;
  source: "default" | "supplied";
}

export interface FuelEuResult {
  year: number;
  limit: number; // target GHG intensity, gCO2eq/MJ
  reductionPct: number; // vs the 91.16 baseline, as a percentage
  attainedIntensity: number; // energy-weighted well-to-wake, gCO2eq/MJ
  totalEnergyMJ: number;
  complianceBalanceGco2eq: number; // > 0 surplus, < 0 deficit
  compliant: boolean;
  vlsfoEquivalentTonnes: number; // the deficit as tonnes of VLSFO-equivalent
  penaltyEur: number; // 0 when compliant
  breakdown: FuelEuFuelBreakdown[];
  evidence: CarbonEvidence[];
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Computes a fuel mix's FuelEU Maritime compliance balance and, on a deficit,
 * the Annex IV penalty. Throws a sentinel for the cases the regulation makes
 * ill-defined rather than guessing:
 *   FUELEU_NOT_IN_FORCE      — year < 2025
 *   FUELEU_NO_FUEL / _NO_ENERGY — nothing to assess
 *   FUELEU_INTENSITY_REQUIRED — a pathway-dependent fuel with no supplied value
 */
export function computeFuelEu(input: FuelEuInput): FuelEuResult {
  const limit = fuelEuLimit(input.year);
  if (limit === null) throw new Error("FUELEU_NOT_IN_FORCE");
  if (!input.fuels.length) throw new Error("FUELEU_NO_FUEL");

  const breakdown = input.fuels.map((e) => {
    const lcv = FUELEU_LCV_MJ_PER_TONNE[e.fuel];
    if (lcv === undefined) throw new Error(`FUELEU_UNKNOWN_FUEL: ${e.fuel}`);
    const tonnes = Math.max(0, e.tonnes);
    const supplied = e.wtwIntensity !== undefined;
    const wtw = supplied ? (e.wtwIntensity as number) : FUELEU_WTW_DEFAULT[e.fuel];
    if (wtw === undefined) {
      throw new Error(
        `FUELEU_INTENSITY_REQUIRED: ${e.fuel} well-to-wake intensity is pathway-dependent; supply wtwIntensity in gCO2eq/MJ.`
      );
    }
    return {
      fuel: e.fuel,
      tonnes,
      energyMJ: new Decimal(tonnes).mul(lcv),
      wtwIntensity: wtw,
      source: (supplied ? "supplied" : "default") as "default" | "supplied",
    };
  });

  const totalEnergy = breakdown.reduce((a, b) => a.add(b.energyMJ), new Decimal(0));
  if (totalEnergy.lte(0)) throw new Error("FUELEU_NO_ENERGY");

  // Energy-weighted attained WtW intensity: Σ(Eᵢ·Iᵢ) / Σ Eᵢ.
  const weighted = breakdown.reduce((a, b) => a.add(b.energyMJ.mul(b.wtwIntensity)), new Decimal(0));
  const attained = weighted.div(totalEnergy);

  // Compliance balance (Art. 4, Annex IV): (limit − attained) × total energy,
  // in gCO2eq. Positive is a surplus; negative is a deficit.
  const balance = new Decimal(limit).minus(attained).mul(totalEnergy);
  const compliant = balance.gte(0);

  const penaltyRate = input.penaltyEurPerTonne ?? PENALTY_EUR_PER_VLSFO_TONNE;
  let vlsfoEqTonnes = new Decimal(0);
  let penalty = new Decimal(0);
  if (!compliant) {
    // Annex IV: |CB| / (attained × 41000) × 2400.
    vlsfoEqTonnes = balance.abs().div(attained.mul(VLSFO_LCV_MJ_PER_TONNE));
    penalty = vlsfoEqTonnes.mul(penaltyRate);
  }

  const attainedNum = attained.toDecimalPlaces(4).toNumber();
  const balanceNum = balance.toDecimalPlaces(0).toNumber();
  const penaltyNum = penalty.toDecimalPlaces(2).toNumber();
  const reductionPct = new Decimal(fuelEuReduction(input.year)).mul(100).toDecimalPlaces(1).toNumber();

  const evidence: CarbonEvidence[] = [
    {
      clause_ref: "FuelEU-2023/1805-Art4",
      finding: `Attained well-to-wake GHG intensity ${fmt(attainedNum)} gCO2eq/MJ vs the ${input.year} limit ${fmt(limit)} gCO2eq/MJ (91.16 baseline − ${fmt(reductionPct)}%).`,
      quantum: { value: attainedNum, unit: "gCO2eq/MJ" },
    },
    {
      clause_ref: "FuelEU-2023/1805-Art4",
      finding: compliant
        ? `Compliant: surplus of ${fmt(balanceNum)} gCO2eq over ${fmt(totalEnergy.toNumber())} MJ of energy.`
        : `Deficit of ${fmt(Math.abs(balanceNum))} gCO2eq over ${fmt(totalEnergy.toNumber())} MJ of energy.`,
      quantum: { value: balanceNum, unit: "gCO2eq" },
    },
  ];
  if (!compliant) {
    evidence.push({
      clause_ref: "FuelEU-2023/1805-Annex-IV",
      finding: `Penalty €${fmt(penaltyNum)} = ${fmt(vlsfoEqTonnes.toDecimalPlaces(3).toNumber())} t VLSFO-equivalent × €${fmt(penaltyRate)}/t.`,
      quantum: { value: penaltyNum, unit: "EUR" },
    });
  }

  return {
    year: input.year,
    limit,
    reductionPct,
    attainedIntensity: attainedNum,
    totalEnergyMJ: totalEnergy.toDecimalPlaces(0).toNumber(),
    complianceBalanceGco2eq: balanceNum,
    compliant,
    vlsfoEquivalentTonnes: vlsfoEqTonnes.toDecimalPlaces(3).toNumber(),
    penaltyEur: penaltyNum,
    breakdown: breakdown.map((b) => ({
      fuel: b.fuel,
      tonnes: b.tonnes,
      energyMJ: b.energyMJ.toDecimalPlaces(0).toNumber(),
      wtwIntensity: b.wtwIntensity,
      source: b.source,
    })),
    evidence,
  };
}
