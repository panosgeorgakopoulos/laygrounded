// Virtual Arrival: turning a port's observed queue into a speed instruction.
//
// `ecospeed.ts` already prices every arrival speed against fuel, ETS, waiting
// burn, demurrage exposure and the laycan. What it could not do was know how
// long the queue actually is — `predictedCongestionDelayHours` was a number the
// caller had to invent. This module supplies it from the AIS congestion feed.
//
// ── THE STATISTIC MATTERS, SO IT IS EXPLICIT ───────────────────────────────
//
// The adapter returns a DISTRIBUTION of observed waiting times, and port queues
// are heavy-tailed: most ships berth quickly, one in eight waits four days. The
// mean of such a sample is dragged upward by the tail and systematically
// overstates the typical wait, which would bias every recommendation toward
// slowing down. So the default is the MEDIAN — the wait a vessel arriving now
// would typically see — and the percentile is a parameter rather than a buried
// choice.
//
// ── AND ONE POINT ESTIMATE IS NOT AN ANSWER ────────────────────────────────
//
// A speed instruction derived from a single guess at the queue hides the fact
// that the queue is uncertain. So the optimiser is run across a BAND of
// percentiles and the module reports whether the recommended ACTION survives
// it. "Slow down, and that holds whether the queue is short or long" is a
// decision a master can act on; "slow down (at P50 only, speed up at P75)" is a
// warning that the queue needs watching, and saying so is the honest output.
//
// Pure: no I/O, no clock. The caller fetches the snapshot.

import {
  calculateOptimalArrivalSpeed,
  type EcoSpeedInput,
  type EcoSpeedRecommendation,
} from "@/lib/optimization/ecospeed";
import { percentile } from "@/lib/risk/aggregate";
import type { DataProvenance } from "@/lib/risk/provenance";

/** Percentiles the sensitivity band is evaluated at, shortest queue first. */
export const QUEUE_BAND = [0.25, 0.5, 0.75, 0.9] as const;

export const DEFAULT_QUEUE_PERCENTILE = 0.5;

export interface QueueObservation {
  /** Observed berth waiting times in hours, ASCENDING. */
  waitingHoursSorted: number[];
  vesselsAtAnchorage: number | null;
  observedAt: string | null;
  provenance: DataProvenance;
}

export interface VirtualArrivalInput
  extends Omit<EcoSpeedInput, "telemetry"> {
  telemetry: {
    currentSpeedKnots: number;
    distanceToPortNm: number;
  };
  queue: QueueObservation;
  /** Which queue percentile drives the headline recommendation. */
  queuePercentile?: number;
}

export interface QueueScenario {
  percentile: number;
  queueHours: number;
  optimalSpeedKnots: number;
  action: EcoSpeedRecommendation["action"];
  netSavingUsd: number;
  fuelTonnesSaved: number;
  etsSavedUsd: number;
}

export interface VirtualArrivalResult {
  /** The recommendation at the chosen percentile — the headline answer. */
  recommendation: EcoSpeedRecommendation;
  queuePercentile: number;
  queueHours: number;
  queueSpread: { p25: number; p50: number; p75: number; p90: number };
  observationCount: number;
  /** How the advice changes as the queue assumption moves. */
  sensitivity: QueueScenario[];
  /**
   * True when every scenario in the band recommends the same ACTION.
   *
   * Deliberately about the action, not the exact speed: a master can act on
   * "slow down" holding across the band even if the optimal knots shift by a
   * few tenths. A flip between slowing and speeding up is a different
   * instruction, and that is what must be surfaced.
   */
  actionRobust: boolean;
  /** Fuel and carbon the headline recommendation avoids, versus current speed. */
  savings: {
    fuelTonnes: number;
    fuelUsd: number;
    etsUsd: number;
    co2Tonnes: number;
    totalUsd: number;
  };
  provenance: DataProvenance;
  caveats: string[];
}

/**
 * MIND THE SIGNS — `ecospeed` mixes two conventions in one object.
 *
 *   netSavingUsd  = current − optimal   (POSITIVE means money saved)
 *   deltaFuelUsd  = optimal − current   (NEGATIVE means money saved)
 *   deltaEtsUsd   = optimal − current   (NEGATIVE means money saved)
 *
 * That is why the optimiser's own prose says `usd(-deltaEtsUsd)` when it
 * reports a saving. Anything published under the word "savings" must therefore
 * be negated, or a dashboard shows a fuel saving as a negative number and a
 * carbon saving as negative tonnes. This helper exists so the negation happens
 * in exactly one place with the reason attached.
 */
function asSaving(delta: number): number {
  return Math.round(-delta * 100) / 100;
}

/**
 * CO2 implied by an ETS saving.
 *
 * Derived from the money the optimiser actually priced rather than recomputed
 * from fuel mass, so the tonnage on screen cannot drift from the cost beside it.
 */
function co2FromEtsSaving(etsSavingUsd: number, euaPriceEur: number, eurUsd: number): number {
  if (euaPriceEur <= 0 || eurUsd <= 0) return 0;
  return Math.round((etsSavingUsd / (euaPriceEur * eurUsd)) * 1000) / 1000;
}

export function planVirtualArrival(input: VirtualArrivalInput): VirtualArrivalResult {
  const observations = input.queue.waitingHoursSorted;
  if (observations.length === 0) throw new Error("NO_QUEUE_OBSERVATIONS");

  const chosen = Math.min(Math.max(input.queuePercentile ?? DEFAULT_QUEUE_PERCENTILE, 0), 1);
  const queueHours = percentile(observations, chosen);

  const runAt = (hours: number): EcoSpeedRecommendation =>
    calculateOptimalArrivalSpeed({
      ...input,
      telemetry: {
        currentSpeedKnots: input.telemetry.currentSpeedKnots,
        distanceToPortNm: input.telemetry.distanceToPortNm,
        predictedCongestionDelayHours: Math.max(0, hours),
      },
    });

  const recommendation = runAt(queueHours);

  const sensitivity: QueueScenario[] = QUEUE_BAND.map((p) => {
    const hours = percentile(observations, p);
    const r = runAt(hours);
    return {
      percentile: p,
      queueHours: Math.round(hours * 10) / 10,
      optimalSpeedKnots: r.optimal.speedKnots,
      action: r.action,
      netSavingUsd: r.netSavingUsd,
      fuelTonnesSaved: Math.round((r.current.fuelTonnes - r.optimal.fuelTonnes) * 1000) / 1000,
      etsSavedUsd: asSaving(r.deltaEtsUsd),
    };
  });

  const actions = new Set(sensitivity.map((s) => s.action));
  const actionRobust = actions.size === 1;

  const fuelTonnes =
    Math.round((recommendation.current.fuelTonnes - recommendation.optimal.fuelTonnes) * 1000) /
    1000;
  const etsSavingUsd = asSaving(recommendation.deltaEtsUsd);
  const co2Tonnes = co2FromEtsSaving(
    etsSavingUsd,
    recommendation.assumptions.euaPriceEur,
    recommendation.assumptions.eurUsd
  );

  const caveats: string[] = [
    `Queue taken at the P${Math.round(chosen * 100)} of ${observations.length} observed waiting time${observations.length === 1 ? "" : "s"} (${queueHours.toFixed(1)}h). Port queues are heavy-tailed, so the median is used rather than the mean, which the tail would drag upward.`,
    "The berth is modelled as clearing on its own schedule: arriving earlier than it frees up means waiting at anchorage, not berthing sooner.",
  ];

  if (!actionRobust) {
    caveats.push(
      `The recommended action is NOT stable across queue uncertainty — it changes between ${[...actions].join(" and ")} as the queue assumption moves from P25 to P90. Treat the headline as provisional and watch the queue.`
    );
  }
  if (observations.length < 5) {
    caveats.push(
      `Only ${observations.length} waiting observation${observations.length === 1 ? "" : "s"} back this queue estimate, so the percentiles are coarse.`
    );
  }
  if (input.queue.provenance.source === "mock") {
    caveats.push(
      "SYNTHETIC QUEUE: the congestion figures come from the mock provider, not from measurement. This plan must not be sent to a master."
    );
  }

  return {
    recommendation,
    queuePercentile: chosen,
    queueHours: Math.round(queueHours * 10) / 10,
    queueSpread: {
      p25: Math.round(percentile(observations, 0.25) * 10) / 10,
      p50: Math.round(percentile(observations, 0.5) * 10) / 10,
      p75: Math.round(percentile(observations, 0.75) * 10) / 10,
      p90: Math.round(percentile(observations, 0.9) * 10) / 10,
    },
    observationCount: observations.length,
    sensitivity,
    actionRobust,
    savings: {
      fuelTonnes,
      fuelUsd: asSaving(recommendation.deltaFuelUsd),
      etsUsd: etsSavingUsd,
      co2Tonnes,
      // Already current − optimal upstream, so this one is NOT negated.
      totalUsd: recommendation.netSavingUsd,
    },
    provenance: input.queue.provenance,
    caveats,
  };
}
