// EU ETS exposure estimator for port delays.
//
// Since 2026, maritime EU ETS coverage is at 100% phase-in: emissions at berth
// in EU ports are fully surrenderable. A demurrage delay therefore carries a
// hidden carbon cost on top of the demurrage itself:
//
//   CO2 = delay_days × auxiliary fuel burn (t/day) × CO2 factor (tCO2/t fuel)
//   cost = CO2 × EUA price × coverage
//
// Pure function; every input is overridable and every default is documented,
// because this is an estimate for exposure awareness — not a verified MRV
// figure — and the UI says so.

import { Decimal } from "decimal.js";

export const ETS_DEFAULTS = {
  // Auxiliary engines + boiler at berth for a typical handysize/supramax bulker.
  FUEL_TONNES_PER_DAY: 4.0,
  // IMO CO2 conversion factor for HFO (tCO2 per tonne fuel).
  CO2_PER_TONNE_FUEL: 3.114,
  // 2026: 100% of at-berth emissions in EU ports are covered.
  COVERAGE_PCT: 1.0,
  // Fallback EUA price when neither the env override nor an explicit input is
  // given (EUR per tCO2).
  EUA_PRICE_EUR: 75,
} as const;

export function defaultEuaPriceEur(): number {
  const fromEnv = parseFloat(process.env.ETS_EUA_PRICE_EUR ?? "");
  return isNaN(fromEnv) || fromEnv <= 0 ? ETS_DEFAULTS.EUA_PRICE_EUR : fromEnv;
}

export interface EtsInputs {
  delayHours: number;
  fuelTonnesPerDay?: number;
  co2PerTonneFuel?: number;
  euaPriceEur?: number;
  coveragePct?: number;
}

export interface EtsEstimate {
  delayHours: number;
  fuelTonnesPerDay: number;
  co2PerTonneFuel: number;
  euaPriceEur: number;
  coveragePct: number;
  co2Tonnes: number;
  estimatedCostEur: number;
}

export function computeEtsEstimate(inputs: EtsInputs): EtsEstimate {
  const delayHours = Math.max(0, inputs.delayHours);
  const fuelTonnesPerDay = inputs.fuelTonnesPerDay ?? ETS_DEFAULTS.FUEL_TONNES_PER_DAY;
  const co2PerTonneFuel = inputs.co2PerTonneFuel ?? ETS_DEFAULTS.CO2_PER_TONNE_FUEL;
  const euaPriceEur = inputs.euaPriceEur ?? defaultEuaPriceEur();
  const coveragePct = inputs.coveragePct ?? ETS_DEFAULTS.COVERAGE_PCT;

  const co2Tonnes = new Decimal(delayHours)
    .div(24)
    .mul(fuelTonnesPerDay)
    .mul(co2PerTonneFuel)
    .toDecimalPlaces(3);

  const estimatedCostEur = co2Tonnes
    .mul(euaPriceEur)
    .mul(coveragePct)
    .toDecimalPlaces(2);

  return {
    delayHours,
    fuelTonnesPerDay,
    co2PerTonneFuel,
    euaPriceEur,
    coveragePct,
    co2Tonnes: co2Tonnes.toNumber(),
    estimatedCostEur: estimatedCostEur.toNumber(),
  };
}
