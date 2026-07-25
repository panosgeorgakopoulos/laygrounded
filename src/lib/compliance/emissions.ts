// Multi-pollutant delay emissions + the "carbon cost of delay" report.
//
// The ETS module (ets.ts) prices the CO2 of an at-berth delay. This module
// adds the other two regulated pollutants a MARPOL Annex VI report needs —
// NOx (Reg. 13, engine/tier driven) and SOx (Reg. 14, fuel-sulphur driven) —
// and assembles the ESG-facing statement that pairs the financial demurrage
// with its environmental footprint: "this delay cost $X AND emitted Y tCO2,
// Z kg NOx, W kg SOx."
//
// Same discipline as the rest of src/lib: pure TypeScript, deterministic, all
// mass/money arithmetic through decimal.js, every default documented and
// overridable, every finding carrying the regulation it rests on. The factors
// are documented heuristics for exposure/ESG awareness — not verified MRV
// figures (measured bunker data is required for that; see mrv.ts / AD-028).

import { Decimal } from "decimal.js";
import { computeEtsEstimate, defaultEuaPriceEur, ETS_DEFAULTS } from "./ets";
import type { CarbonEvidence } from "./carbon";

export type MarineFuel = "HFO" | "VLSFO" | "MGO" | "LNG";
export type EngineTier = "tier_i" | "tier_ii" | "tier_iii";

export interface FuelProfile {
  // IMO MEPC tank-to-wake CO2 conversion factor (tCO2 per tonne fuel).
  co2PerTonne: number;
  // Fuel sulphur content by mass (%), which sets the SOx (as SO2) output.
  sulphurPct: number;
  label: string;
}

// IMO CO2 factors + the sulphur ceilings each grade is bunkered to under the
// 2020 global 0.50% cap (MARPOL Annex VI Reg. 14) / 0.10% ECA limit.
export const MARINE_FUELS: Record<MarineFuel, FuelProfile> = {
  HFO: { co2PerTonne: 3.114, sulphurPct: 3.5, label: "Heavy Fuel Oil (pre-2020 sulphur)" },
  VLSFO: { co2PerTonne: 3.151, sulphurPct: 0.5, label: "Very Low Sulphur Fuel Oil (0.50% cap)" },
  MGO: { co2PerTonne: 3.206, sulphurPct: 0.1, label: "Marine Gas Oil (ECA distillate)" },
  LNG: { co2PerTonne: 2.75, sulphurPct: 0.004, label: "Liquefied Natural Gas" },
};

// Fuel-based NOx factors (kg NOx per tonne fuel) for medium-speed auxiliary
// diesels, from the EMEP/EEA Air Pollutant Emission Inventory Guidebook and
// the IMO Fourth GHG Study (2020). Tier is set by MARPOL Annex VI Reg. 13 by
// keel-laid date; Tier III applies inside a NOx Emission Control Area.
export const NOX_KG_PER_TONNE_FUEL: Record<EngineTier, number> = {
  tier_i: 87, // keel < 2011
  tier_ii: 78, // 2011+
  tier_iii: 16, // 2016+ inside a NECA (~80% reduction)
};

export const DEFAULT_FUEL: MarineFuel = "VLSFO";
export const DEFAULT_ENGINE_TIER: EngineTier = "tier_ii";

// Elemental sulphur → sulphur dioxide, by mass (SO2 molar 64 / S molar 32).
const SULPHUR_TO_SO2 = 2;

const d = (n: number | Decimal) => new Decimal(n);
const mass = (x: Decimal) => x.toDecimalPlaces(3).toNumber();
const round2 = (x: Decimal) => x.toDecimalPlaces(2).toNumber();
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export interface DelayEmissionsInput {
  delayHours: number;
  fuel?: MarineFuel;
  engineTier?: EngineTier;
  // At-berth auxiliary + boiler burn (t/day); defaults to the ETS assumption.
  fuelTonnesPerDay?: number;
}

export interface DelayEmissions {
  delayHours: number;
  fuel: MarineFuel;
  engineTier: EngineTier;
  fuelTonnesPerDay: number;
  fuelTonnes: number;
  co2Tonnes: number;
  noxKg: number;
  soxKg: number;
}

// CO2 from the fuel's carbon factor, NOx from the engine tier, SOx from the
// fuel's sulphur content — three independent drivers, one fuel mass.
export function computeDelayEmissions(input: DelayEmissionsInput): DelayEmissions {
  const delayHours = Math.max(0, input.delayHours);
  const fuel = input.fuel ?? DEFAULT_FUEL;
  const engineTier = input.engineTier ?? DEFAULT_ENGINE_TIER;
  const fuelTonnesPerDay = input.fuelTonnesPerDay ?? ETS_DEFAULTS.FUEL_TONNES_PER_DAY;
  const profile = MARINE_FUELS[fuel];

  const fuelTonnes = d(delayHours).div(24).mul(fuelTonnesPerDay);
  const co2 = fuelTonnes.mul(profile.co2PerTonne);
  const noxKg = fuelTonnes.mul(NOX_KG_PER_TONNE_FUEL[engineTier]);
  const soxKg = fuelTonnes.mul(profile.sulphurPct).div(100).mul(SULPHUR_TO_SO2).mul(1000);

  return {
    delayHours,
    fuel,
    engineTier,
    fuelTonnesPerDay,
    fuelTonnes: mass(fuelTonnes),
    co2Tonnes: mass(co2),
    noxKg: round2(noxKg),
    soxKg: round2(soxKg),
  };
}

export interface CarbonCostOfDelayInput extends DelayEmissionsInput {
  euaPriceEur?: number;
  // The financial side, so the report can pair "$ AND tonnes". Optional — the
  // report stands as an emissions statement without it.
  demurrageAmount?: number;
  currency?: string;
}

export interface CarbonCostOfDelay {
  emissions: DelayEmissions;
  etsCostEur: number;
  euaPriceEur: number;
  demurrageAmount: number | null;
  currency: string | null;
  headline: string;
  evidence: CarbonEvidence[];
}

// The A7 ESG report: the delay's full environmental footprint (CO2/NOx/SOx),
// its EU-ETS surrender cost, and — when supplied — the demurrage it cost in the
// same breath, so a delay reads as both a commercial and a climate event.
export function buildCarbonCostOfDelay(input: CarbonCostOfDelayInput): CarbonCostOfDelay {
  const emissions = computeDelayEmissions(input);
  const fuel = input.fuel ?? DEFAULT_FUEL;
  const profile = MARINE_FUELS[fuel];

  const ets = computeEtsEstimate({
    delayHours: emissions.delayHours,
    fuelTonnesPerDay: input.fuelTonnesPerDay,
    co2PerTonneFuel: profile.co2PerTonne,
    euaPriceEur: input.euaPriceEur,
  });

  const currency = input.currency ?? null;
  const demurrageAmount = input.demurrageAmount ?? null;
  const money =
    demurrageAmount != null ? `${currency ?? "USD"} ${fmt(demurrageAmount)} in demurrage and ` : "";
  const headline =
    `This ${emissions.delayHours}h delay cost ${money}emitted ` +
    `${fmt(emissions.co2Tonnes)} tCO2, ${fmt(emissions.noxKg)} kg NOx and ` +
    `${fmt(emissions.soxKg)} kg SOx (~€${fmt(ets.estimatedCostEur)} EU-ETS at ` +
    `€${ets.euaPriceEur}/tCO2).`;

  const evidence: CarbonEvidence[] = [
    {
      clause_ref: "EU-MRV-2015/757",
      finding: `${emissions.delayHours}h at berth burned ${fmt(emissions.fuelTonnes)} t ${profile.label} → ${fmt(emissions.co2Tonnes)} tCO2 (TtW).`,
      quantum: { value: emissions.co2Tonnes, unit: "tCO2" },
    },
    {
      clause_ref: "EU-ETS-2003/87-Art3ga",
      finding: `EUA surrender liability ~€${fmt(ets.estimatedCostEur)} at €${ets.euaPriceEur}/tCO2, ${ets.coveragePct * 100}% at-berth coverage.`,
      quantum: { value: ets.estimatedCostEur, unit: "EUR" },
    },
    {
      clause_ref: "MARPOL-VI-Reg13",
      finding: `NOx ${fmt(emissions.noxKg)} kg at ${NOX_KG_PER_TONNE_FUEL[emissions.engineTier]} kg/t (${emissions.engineTier.replace("_", " ").toUpperCase()}, EMEP/EEA + IMO 4th GHG Study).`,
      quantum: { value: emissions.noxKg, unit: "kg NOx" },
    },
    {
      clause_ref: "MARPOL-VI-Reg14",
      finding: `SOx ${fmt(emissions.soxKg)} kg as SO2 from ${profile.sulphurPct}% fuel sulphur.`,
      quantum: { value: emissions.soxKg, unit: "kg SOx" },
    },
  ];

  return {
    emissions,
    etsCostEur: ets.estimatedCostEur,
    euaPriceEur: ets.euaPriceEur,
    demurrageAmount,
    currency,
    headline,
    evidence,
  };
}
