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
import {
  computeEtsEstimate,
  defaultEuaPriceEur,
  etsChargeableShare,
  ETS_DEFAULTS,
  type EtsScope,
} from "./ets";
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

/**
 * Year used when a caller does not state one.
 *
 * 2026 is the first year of full (100%) EU ETS phase-in for shipping, so this
 * is the conservative default: it never understates a liability. It is a
 * constant rather than a clock read because this module is pure.
 */
export const FULLY_PHASED_IN_YEAR = 2026;

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
  /**
   * Whether the call is at an EEA port, and the year it happened in.
   *
   * EU ETS scope for AT-BERTH emissions is all-or-nothing on geography — an
   * EEA call is fully in scope, anywhere else is entirely outside it — and the
   * phase-in then scales what must actually be surrendered (2024 40%, 2025
   * 70%, 2026 onward 100%).
   *
   * This used to be ignored entirely: the EUA figure was computed at a flat
   * 100% coverage regardless of where the ship was, so every non-EEA delay was
   * billed a liability that does not exist. `etsChargeableShare` was written to
   * fix exactly that and was never wired in here.
   *
   * `undefined`/`null` for `eeaPort` means UNKNOWN, and is deliberately not
   * treated as EEA — the result is flagged `scopeCertain: false` and described
   * as potential exposure, never as a settled liability.
   */
  eeaPort?: boolean | null;
  year?: number;
}

export interface CarbonCostOfDelay {
  emissions: DelayEmissions;
  etsCostEur: number;
  euaPriceEur: number;
  /** The scope actually applied: geography × phase-in. */
  etsScope: EtsScope;
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

  // Geography x phase-in, rather than the flat 100% this used to assume. A
  // delay at a non-EEA berth carries NO EUA liability, and saying otherwise
  // invents money the charterer does not owe.
  const etsScope = etsChargeableShare({
    eeaPort: input.eeaPort,
    // Named constant, not `new Date().getFullYear()`: this module is pure and
    // must not read a clock, or the same delay would price differently across
    // a New Year boundary. Callers pass the claim's own year; the fallback is
    // the fully-phased-in era, which is the conservative reading.
    year: input.year ?? FULLY_PHASED_IN_YEAR,
  });

  const ets = computeEtsEstimate({
    delayHours: emissions.delayHours,
    fuelTonnesPerDay: input.fuelTonnesPerDay,
    co2PerTonneFuel: profile.co2PerTonne,
    euaPriceEur: input.euaPriceEur,
    coveragePct: etsScope.share,
  });

  const currency = input.currency ?? null;
  const demurrageAmount = input.demurrageAmount ?? null;
  const money =
    demurrageAmount != null ? `${currency ?? "USD"} ${fmt(demurrageAmount)} in demurrage and ` : "";
  const headline =
    `This ${emissions.delayHours}h delay cost ${money}emitted ` +
    `${fmt(emissions.co2Tonnes)} tCO2, ${fmt(emissions.noxKg)} kg NOx and ` +
    `${fmt(emissions.soxKg)} kg SOx` +
    (etsScope.share > 0
      ? ` (~€${fmt(ets.estimatedCostEur)} EU-ETS at €${ets.euaPriceEur}/tCO2` +
        `${etsScope.scopeCertain ? "" : ", IF this is an EEA call"}).`
      : " (no EU-ETS liability — non-EEA berth).");

  const evidence: CarbonEvidence[] = [
    {
      clause_ref: "EU-MRV-2015/757",
      finding: `${emissions.delayHours}h at berth burned ${fmt(emissions.fuelTonnes)} t ${profile.label} → ${fmt(emissions.co2Tonnes)} tCO2 (TtW).`,
      quantum: { value: emissions.co2Tonnes, unit: "tCO2" },
    },
    {
      clause_ref: "EU-ETS-2003/87-Art3ga",
      finding:
        etsScope.share > 0
          ? `EUA surrender liability ~€${fmt(ets.estimatedCostEur)} at €${ets.euaPriceEur}/tCO2. ${etsScope.note}`
          : `No EUA surrender liability. ${etsScope.note}`,
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
    etsScope,
    demurrageAmount,
    currency,
    headline,
    evidence,
  };
}
