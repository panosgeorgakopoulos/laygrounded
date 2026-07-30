// One Monte Carlo trial: sample an arrival, a queue and a weather trajectory,
// then run the real engine over the resulting timeline.
//
// The engine is used UNMODIFIED. Nothing here reaches into `gencon94.ts`, and
// no randomness crosses into it — the trial resolves every uncertain quantity
// into concrete timestamps first and hands the engine an ordinary event list.
// That is what keeps the 500-case corpus and the offline verifier meaningful:
// the same code that prices a settled claim prices a hypothetical one.
//
// Pure.

import { recomputeLaytime } from "@/lib/laytime/gencon94";
import type { CpTerms } from "@/lib/laytime/types";
import { Decimal } from "decimal.js";
import { pickIndex, sampleEmpirical, sampleTriangular } from "@/lib/risk/distributions";
import { synthesizeVoyageTimeline, MAX_TIMELINE_HOURS } from "@/lib/risk/voyage-timeline";
import type { TrialOutcome } from "@/lib/risk/aggregate";

/**
 * One physically-consistent weather history or forecast, reduced to the only
 * thing the simulation needs: whether cargo work stops in each hour.
 *
 * Stored as flags rather than raw readings because the cargo profile has
 * already been applied. Two consequences worth knowing: the persisted inputs
 * stay small enough to keep forever, and the audit question "would THIS cargo
 * have stopped" is answered once rather than re-litigated at replay.
 */
export interface StoppageTrajectory {
  kind: "ensemble" | "climatology";
  /** Member number or historical year — whatever identifies it to a reader. */
  id: string;
  /** Indexed from `referenceStartISO`, one entry per hour. */
  flags: boolean[];
}

export interface TrialInputs {
  cpTerms: CpTerms;
  opsDurationHours: number;
  berthToOpsHours: number;
  /** The instant trajectory index 0 corresponds to. */
  referenceStartISO: string;
  /** Nominal ETA. Arrival is this plus the sampled error. */
  etaISO: string;
  /** Triangular ETA error bounds in hours, e.g. −24 (early) to +72 (late). */
  etaErrorHours: { min: number; mode: number; max: number };
  /** Observed berth waiting times, ASCENDING. Feeds the ECDF. */
  waitingHoursSorted: number[];
  ensemblePool: StoppageTrajectory[];
  climatologyPool: StoppageTrajectory[];
  /** Share of trials drawing from the ensemble pool. See horizon.ts. */
  ensembleWeight: number;
  operation?: "loading" | "discharge";
}

/**
 * Uniforms consumed per trial, in a fixed order.
 *
 * Fixed length is what makes antithetic pairing possible: the partner trial is
 * this vector with every element replaced by 1−u, which mirrors each decision
 * simultaneously. A trial that drew a variable number of uniforms could not be
 * mirrored coherently.
 */
export const UNIFORMS_PER_TRIAL = 3;

const enum U {
  EtaError = 0,
  Waiting = 1,
  Trajectory = 2,
}

export function drawTrialVector(next: () => number): number[] {
  return Array.from({ length: UNIFORMS_PER_TRIAL }, () => next());
}

/** The antithetic partner of a uniform vector. */
export function mirrorVector(vector: number[]): number[] {
  return vector.map((u) => 1 - u);
}

const HOUR_MS = 3_600_000;

export function runTrialFromVector(vector: number[], inputs: TrialInputs): TrialOutcome {
  // ── 1. When does she actually arrive? ──────────────────────────────────────
  const etaError = sampleTriangular(
    inputs.etaErrorHours.min,
    inputs.etaErrorHours.mode,
    inputs.etaErrorHours.max,
    vector[U.EtaError]
  );
  const arrivalMs = new Date(inputs.etaISO).getTime() + Math.round(etaError) * HOUR_MS;

  // ── 2. How long in the queue? ──────────────────────────────────────────────
  const waitingHours = Math.max(
    0,
    Math.round(sampleEmpirical(inputs.waitingHoursSorted, vector[U.Waiting]))
  );

  // ── 3. Which weather? ──────────────────────────────────────────────────────
  // A mixture draw, never an average — see horizon.ts. The pools are checked
  // for emptiness so a horizon that asks for a pool we could not fetch falls
  // back to the one we have rather than simulating no weather at all.
  const wantsEnsemble = vector[U.Trajectory] < inputs.ensembleWeight;
  const pool =
    wantsEnsemble && inputs.ensemblePool.length > 0
      ? inputs.ensemblePool
      : inputs.climatologyPool.length > 0
        ? inputs.climatologyPool
        : inputs.ensemblePool;

  // The trajectory index is reused rather than drawn separately: it is already
  // uniform on [0,1) and independent of the pool choice threshold, and keeping
  // the vector at three elements keeps the antithetic mirror exact.
  const rescaled = wantsEnsemble
    ? vector[U.Trajectory] / Math.max(inputs.ensembleWeight, Number.EPSILON)
    : (vector[U.Trajectory] - inputs.ensembleWeight) /
      Math.max(1 - inputs.ensembleWeight, Number.EPSILON);
  const trajectory = pool[pickIndex(pool.length, Math.min(Math.max(rescaled, 0), 0.999999))];

  // ── 4. Align the weather to the arrival ────────────────────────────────────
  // Arriving twelve hours later means meeting different weather, not the same
  // weather twelve hours in. Slicing the trajectory at the arrival index is
  // what makes ETA uncertainty interact with the forecast rather than sit
  // beside it.
  const offsetHours = Math.round(
    (arrivalMs - new Date(inputs.referenceStartISO).getTime()) / HOUR_MS
  );
  const flags =
    offsetHours <= 0
      ? // Arrival before the window starts: pad with workable hours rather than
        // wrapping, which would fabricate weather that was never forecast.
        (Array(Math.min(-offsetHours, MAX_TIMELINE_HOURS)).fill(false) as boolean[]).concat(
          trajectory.flags
        )
      : trajectory.flags.slice(offsetHours);

  // ── 5. Price it with the real engine ───────────────────────────────────────
  const events = synthesizeVoyageTimeline({
    startISO: new Date(arrivalMs).toISOString(),
    waitingHours,
    berthToOpsHours: inputs.berthToOpsHours,
    stoppageFlags: flags,
    opsDurationHours: inputs.opsDurationHours,
    operation: inputs.operation,
  });

  const totals = recomputeLaytime(events, inputs.cpTerms).totals;

  // Stoppage hours counted over the span actually occupied, not the whole
  // trajectory: weather after cargo finished never cost anyone anything.
  const opsSpan = flags.slice(0, waitingHours + inputs.berthToOpsHours + inputs.opsDurationHours * 2);

  return {
    net: new Decimal(totals.demurrage_amount)
      .minus(totals.despatch_amount)
      .toDecimalPlaces(2)
      .toNumber(),
    demurrageAmount: totals.demurrage_amount,
    despatchAmount: totals.despatch_amount,
    usedHours: totals.used_hours,
    waitingHours,
    stoppageHours: opsSpan.filter(Boolean).length,
    trajectoryKind: trajectory.kind,
  };
}
