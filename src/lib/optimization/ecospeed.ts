// Dynamic eco-speed voyage optimizer.
//
// Given where the vessel is (telemetry), what the port queue looks like
// (predicted congestion), and how the hull burns fuel (the vessel's
// consumption curve, admiralty cube law via carbon.ts), price every arrival
// speed and recommend the cheapest one:
//
//   total(v) = sea fuel + at-sea ETS
//            + anchorage waiting (aux fuel + at-berth ETS)
//            + demurrage exposure while waiting
//            + laycan penalty if the ETA misses the cancelling date
//
// Sailing faster into a known queue buys nothing but bunker bills and EUAs
// (the SFTW waste carbon.ts arbitrates after the fact — this module prevents
// it before it happens); sailing slower than the laycan allows costs the
// fixture. The optimum is wherever those curves cross.
//
// Same discipline as the engine: pure TypeScript, no I/O, no clock reads
// (`nowISO` is an input), deterministic for identical inputs; all money and
// fuel-mass arithmetic through decimal.js. Results carry an `evidence` array
// citing the clause or regulation each cost leg rests on.

import { Decimal } from "decimal.js";
import {
  CARBON_DEFAULTS,
  seaConsumptionTpd,
  type CarbonEvidence,
  type ConsumptionCurve,
} from "@/lib/compliance/carbon";
import { ETS_DEFAULTS } from "@/lib/compliance/ets";

export const ECOSPEED_DEFAULTS = {
  SPEED_STEP_KNOTS: 0.5,
  // Waiting happens at anchorage inside the port area → at-berth ETS
  // treatment (100% coverage); the passage leg uses the voyage-mix at-sea
  // coverage shared with the carbon engine.
  WAITING_ETS_COVERAGE: ETS_DEFAULTS.COVERAGE_PCT,
  AT_SEA_ETS_COVERAGE: CARBON_DEFAULTS.AT_SEA_ETS_COVERAGE,
  // EUA prices quote in EUR; bunker and demurrage in USD. Flat conversion,
  // overridable per call.
  EUR_USD: 1.08,
} as const;

export interface VesselTelemetry {
  currentSpeedKnots: number;
  distanceToPortNm: number;
  predictedCongestionDelayHours: number;
}

export interface EcoSpeedInput {
  telemetry: VesselTelemetry;
  consumptionCurve: ConsumptionCurve;
  demurrageRatePerDay: number;
  // Explicit clock — the optimizer never reads Date.now().
  nowISO: string;
  // Laytime allowance expected to still be unconsumed at arrival. Default 0:
  // conservatively, every waiting hour is demurrage-equivalent exposure.
  laytimeBufferHours?: number;
  // Laycan cancelling date; an ETA past it costs fixtureLossUsd.
  cancellingAt?: string;
  fixtureLossUsd?: number;
  fuelPriceUsdPerTonne?: number;
  euaPriceEur?: number;
  eurUsd?: number;
  minSpeedKnots?: number;
  maxSpeedKnots?: number; // default: fastest measured point on the curve
  speedStepKnots?: number;
}

export interface SpeedOption {
  speedKnots: number;
  steamingHours: number;
  etaISO: string;
  fuelTonnes: number;
  fuelCostUsd: number;
  etsCostUsd: number;
  waitingHours: number;
  waitingCostUsd: number;
  demurrageExposureUsd: number;
  laycanMissed: boolean;
  laycanPenaltyUsd: number;
  totalCostUsd: number;
}

export interface EcoSpeedRecommendation {
  current: SpeedOption;
  optimal: SpeedOption;
  action: "increase_speed" | "decrease_speed" | "maintain_speed";
  // current total − optimal total (≥ 0 by construction).
  netSavingUsd: number;
  deltaFuelUsd: number;
  deltaEtsUsd: number;
  deltaWaitingUsd: number;
  deltaDemurrageUsd: number;
  deltaLaycanUsd: number;
  recommendation: string;
  evidence: CarbonEvidence[];
  options: SpeedOption[];
  assumptions: {
    fuelPriceUsdPerTonne: number;
    euaPriceEur: number;
    eurUsd: number;
    atSeaEtsCoverage: number;
    waitingEtsCoverage: number;
    laytimeBufferHours: number;
    congestionModel: string;
  };
}

const d = (n: number | Decimal) => new Decimal(n);
const money = (x: Decimal) => x.toDecimalPlaces(2).toNumber();
const HOUR_MS = 3600_000;

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export function calculateOptimalArrivalSpeed(input: EcoSpeedInput): EcoSpeedRecommendation {
  const { telemetry } = input;
  const nowMs = Date.parse(input.nowISO);
  if (
    Number.isNaN(nowMs) ||
    !(telemetry.distanceToPortNm > 0) ||
    !(telemetry.currentSpeedKnots > 0) ||
    telemetry.predictedCongestionDelayHours < 0 ||
    input.demurrageRatePerDay < 0
  ) {
    throw new Error("INVALID_TELEMETRY");
  }
  const cancellingMs = input.cancellingAt ? Date.parse(input.cancellingAt) : null;
  if (cancellingMs !== null && Number.isNaN(cancellingMs)) throw new Error("INVALID_TELEMETRY");

  const fuelPrice = d(input.fuelPriceUsdPerTonne ?? CARBON_DEFAULTS.FUEL_PRICE_USD_PER_TONNE);
  const euaPrice = d(input.euaPriceEur ?? ETS_DEFAULTS.EUA_PRICE_EUR);
  const eurUsd = d(input.eurUsd ?? ECOSPEED_DEFAULTS.EUR_USD);
  const co2Factor = d(CARBON_DEFAULTS.CO2_PER_TONNE_FUEL);
  const seaCoverage = d(ECOSPEED_DEFAULTS.AT_SEA_ETS_COVERAGE);
  const waitCoverage = d(ECOSPEED_DEFAULTS.WAITING_ETS_COVERAGE);
  const buffer = d(Math.max(0, input.laytimeBufferHours ?? 0));
  const demRate = d(input.demurrageRatePerDay);
  const fixtureLoss = d(Math.max(0, input.fixtureLossUsd ?? 0));
  const congestion = d(telemetry.predictedCongestionDelayHours);
  const auxTpd = d(input.consumptionCurve.at_berth_aux_tonnes_per_day);
  if (auxTpd.isNegative()) throw new Error("INVALID_CONSUMPTION_CURVE");

  const minSpeed = input.minSpeedKnots ?? CARBON_DEFAULTS.MIN_STEAMING_SPEED_KNOTS;
  const maxSpeed =
    input.maxSpeedKnots ??
    Math.max(...input.consumptionCurve.sea_curve.map((p) => p.speed_knots), minSpeed);
  const step = input.speedStepKnots ?? ECOSPEED_DEFAULTS.SPEED_STEP_KNOTS;
  if (!(minSpeed > 0) || !(step > 0) || maxSpeed < minSpeed) throw new Error("INVALID_SPEED_RANGE");

  const evaluate = (speedKnots: number): SpeedOption => {
    const v = d(speedKnots);
    const steamingHours = d(telemetry.distanceToPortNm).div(v);
    const etaMs = nowMs + steamingHours.toNumber() * HOUR_MS;

    const seaFuel = seaConsumptionTpd(input.consumptionCurve, speedKnots)
      .mul(steamingHours)
      .div(24);
    const fuelCostUsd = seaFuel.mul(fuelPrice);
    const etsCostUsd = seaFuel.mul(co2Factor).mul(seaCoverage).mul(euaPrice).mul(eurUsd);

    // The queue ahead of us clears on its own schedule: the berth is ready
    // `congestion` hours from now regardless of when we turn up. Arriving
    // earlier than that just means drifting at the anchorage.
    const waitingHours = Decimal.max(congestion.minus(steamingHours), d(0));
    const waitingFuel = waitingHours.div(24).mul(auxTpd);
    const waitingCostUsd = waitingFuel
      .mul(fuelPrice)
      .plus(waitingFuel.mul(co2Factor).mul(waitCoverage).mul(euaPrice).mul(eurUsd));

    const demurrageExposureUsd = Decimal.max(waitingHours.minus(buffer), d(0))
      .div(24)
      .mul(demRate);

    const laycanMissed = cancellingMs !== null && etaMs > cancellingMs;
    const laycanPenaltyUsd = laycanMissed ? fixtureLoss : d(0);

    const total = fuelCostUsd
      .plus(etsCostUsd)
      .plus(waitingCostUsd)
      .plus(demurrageExposureUsd)
      .plus(laycanPenaltyUsd);

    return {
      speedKnots,
      steamingHours: steamingHours.toDecimalPlaces(2).toNumber(),
      etaISO: new Date(etaMs).toISOString(),
      fuelTonnes: seaFuel.toDecimalPlaces(3).toNumber(),
      fuelCostUsd: money(fuelCostUsd),
      etsCostUsd: money(etsCostUsd),
      waitingHours: waitingHours.toDecimalPlaces(2).toNumber(),
      waitingCostUsd: money(waitingCostUsd),
      demurrageExposureUsd: money(demurrageExposureUsd),
      laycanMissed,
      laycanPenaltyUsd: money(laycanPenaltyUsd),
      totalCostUsd: money(total),
    };
  };

  const options: SpeedOption[] = [];
  for (let v = d(minSpeed); v.lte(maxSpeed); v = v.plus(step)) {
    options.push(evaluate(v.toNumber()));
  }
  const current = evaluate(telemetry.currentSpeedKnots);

  // Cheapest wins; ties go to the slower (greener) speed — the grid is
  // ascending, so strict less-than keeps the first minimum.
  let optimal = options[0] ?? current;
  for (const o of options) {
    if (o.totalCostUsd < optimal.totalCostUsd) optimal = o;
  }
  if (current.totalCostUsd < optimal.totalCostUsd) optimal = current;

  const halfStep = step / 2;
  const action: EcoSpeedRecommendation["action"] =
    optimal.speedKnots > telemetry.currentSpeedKnots + halfStep
      ? "increase_speed"
      : optimal.speedKnots < telemetry.currentSpeedKnots - halfStep
        ? "decrease_speed"
        : "maintain_speed";

  const deltaFuelUsd = money(d(optimal.fuelCostUsd).minus(current.fuelCostUsd));
  const deltaEtsUsd = money(d(optimal.etsCostUsd).minus(current.etsCostUsd));
  const deltaWaitingUsd = money(d(optimal.waitingCostUsd).minus(current.waitingCostUsd));
  const deltaDemurrageUsd = money(
    d(optimal.demurrageExposureUsd).minus(current.demurrageExposureUsd)
  );
  const deltaLaycanUsd = money(d(optimal.laycanPenaltyUsd).minus(current.laycanPenaltyUsd));
  const netSavingUsd = money(d(current.totalCostUsd).minus(optimal.totalCostUsd));

  let recommendation: string;
  if (action === "maintain_speed") {
    recommendation = `Maintain ${telemetry.currentSpeedKnots} kn — the current speed is within ${step} kn of the cost-optimal arrival profile (total exposure ${usd(current.totalCostUsd)}).`;
  } else if (action === "increase_speed") {
    recommendation = `Increase speed to ${optimal.speedKnots} kn: burns ${usd(Math.max(deltaFuelUsd, 0))} extra fuel (+${usd(Math.max(deltaEtsUsd, 0))} ETS) but avoids ${usd(-(deltaDemurrageUsd + deltaLaycanUsd + deltaWaitingUsd))} in demurrage, waiting and laycan exposure — net saving ${usd(netSavingUsd)}.`;
  } else {
    recommendation = `Reduce speed to ${optimal.speedKnots} kn (just-in-time arrival): saves ${usd(-deltaFuelUsd)} fuel and ${usd(-deltaEtsUsd)} ETS against ${usd(deltaDemurrageUsd + deltaWaitingUsd + deltaLaycanUsd)} of added port-side exposure — net saving ${usd(netSavingUsd)}.`;
  }

  const evidence: CarbonEvidence[] = [
    {
      clause_ref: "BIMCO-JIT-ARRIVAL",
      finding:
        "Arrival speed optimized against the live berth queue per the Just-in-Time Arrival concept: waiting at anchorage is priced, not ignored.",
    },
    {
      clause_ref: "EU-ETS-2003/87",
      finding: `Passage emissions priced at ${seaCoverage.mul(100).toNumber()}% coverage and anchorage emissions at ${waitCoverage.mul(100).toNumber()}% coverage, EUA ${euaPrice.toNumber()} EUR/tCO2.`,
      quantum: { value: optimal.etsCostUsd, unit: "USD passage ETS cost at optimal speed" },
    },
  ];
  if (action === "decrease_speed") {
    evidence.push({
      clause_ref: "CP-UTMOST-DESPATCH",
      finding:
        "Caution: slow-steaming below the CP warranted speed may require charterer consent — obtain written orders before reducing speed.",
    });
  }
  if (cancellingMs !== null) {
    evidence.push({
      clause_ref: "CP-LAYCAN-CANCELLING",
      finding: optimal.laycanMissed
        ? "No evaluated speed makes the cancelling date — treat the fixture as at risk and notify the charterer."
        : `Recommended speed arrives before the cancelling date (${input.cancellingAt}).`,
    });
  }

  return {
    current,
    optimal,
    action,
    netSavingUsd,
    deltaFuelUsd,
    deltaEtsUsd,
    deltaWaitingUsd,
    deltaDemurrageUsd,
    deltaLaycanUsd,
    recommendation,
    evidence,
    options,
    assumptions: {
      fuelPriceUsdPerTonne: fuelPrice.toNumber(),
      euaPriceEur: euaPrice.toNumber(),
      eurUsd: eurUsd.toNumber(),
      atSeaEtsCoverage: seaCoverage.toNumber(),
      waitingEtsCoverage: waitCoverage.toNumber(),
      laytimeBufferHours: buffer.toNumber(),
      congestionModel:
        "berth ready at now + predicted congestion, independent of own arrival (FIFO queue ahead)",
    },
  };
}
