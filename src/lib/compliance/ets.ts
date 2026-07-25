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

// EU ETS maritime phase-in (Dir. 2003/87/EC as amended by 2023/959, Art. 3ga):
// ships surrender allowances for a RISING share of their in-scope emissions —
// 2024 → 40%, 2025 → 70%, 2026 and after → 100%. Before 2024 shipping was
// outside the ETS entirely, so a delay then carried no EUA liability at all.
export const ETS_PHASE_IN: Record<number, number> = { 2024: 0.4, 2025: 0.7 };

export function etsPhaseInFactor(year: number): number {
  if (year < 2024) return 0; // shipping entered the maritime ETS in 2024
  return ETS_PHASE_IN[year] ?? 1; // 2026 onward: full phase-in
}

export interface EtsScope {
  // Fraction of the delay's at-berth CO2 that is actually surrenderable:
  // voyage-scope share (geography) × phase-in factor (year).
  share: number;
  phaseIn: number;
  // false when the port's EEA status is unknown — the share shown is then the
  // POTENTIAL exposure IF the port is in the EEA, not a settled liability.
  scopeCertain: boolean;
  note: string;
}

// The chargeable share of an AT-BERTH delay's emissions.
//
// EU ETS scope for emissions AT BERTH is all-or-nothing on geography: a call at
// an EEA port is 100% in scope; a call anywhere else is entirely outside it.
// (The 50% rule applies to the voyage LEG between an EEA and a non-EEA port,
// which a berth stay is not.) The phase-in factor then scales what is
// surrendered. This is why the old flat COVERAGE_PCT = 1.0 over-billed every
// non-EEA delay: at-berth burn in a non-EEA port is not an EUA liability.
export function etsChargeableShare(input: {
  eeaPort: boolean | null | undefined;
  year: number;
}): EtsScope {
  const phaseIn = etsPhaseInFactor(input.year);
  if (input.eeaPort === false) {
    return {
      share: 0,
      phaseIn,
      scopeCertain: true,
      note: "Non-EEA port: at-berth emissions are outside EU ETS scope — no EUA liability.",
    };
  }
  if (input.eeaPort === true) {
    return {
      share: phaseIn,
      phaseIn,
      scopeCertain: true,
      note: `EEA port: at-berth emissions 100% in scope, ${Math.round(phaseIn * 100)}% phase-in for ${input.year}.`,
    };
  }
  // Unknown — do NOT silently assume EEA (the same discipline mrv.ts applies to
  // a free-text port). Show the potential exposure, flagged as uncertain.
  return {
    share: phaseIn,
    phaseIn,
    scopeCertain: false,
    note: "EEA status of the port is unknown; shown as potential exposure IF it is an EEA call.",
  };
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
