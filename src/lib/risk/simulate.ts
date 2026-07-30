// The simulation itself: N trials, one seed, one distribution.
//
// PURE, and that is the whole point. Every external fact — forecast members,
// historical years, the port's queue, the cargo's thresholds — has already been
// resolved into plain data by the time this runs. So the function is a total
// function of (inputs, seed, trials), which is what lets the persisted row be
// replayed months later and produce the same numbers to the cent.
//
// No clock, no I/O, no Math.random.

import { makeRng } from "@/lib/risk/prng";
import {
  drawTrialVector,
  mirrorVector,
  runTrialFromVector,
  type TrialInputs,
} from "@/lib/risk/trial";
import { summarize, type RiskDistribution, type TrialOutcome } from "@/lib/risk/aggregate";

export const DEFAULT_TRIALS = 5000;
export const MAX_TRIALS = 50000;
export const MIN_TRIALS = 100;

export interface SimulationOptions {
  seed: string;
  trials?: number;
  /**
   * Antithetic variates: run trials in mirrored pairs.
   *
   * Each pair contains one draw and its reflection, so a trial that sampled a
   * late arrival, a long queue and a bad forecast is matched by one that
   * sampled early, short and good. The two are negatively correlated, their
   * average has lower variance than two independent trials, and the estimator
   * stays unbiased. Typically buys the precision of ~1.5-2x the trial count for
   * free on the mean; it does less for extreme percentiles, which is why the
   * standard errors are reported per statistic rather than as one number.
   */
  antithetic?: boolean;
}

export interface SimulationResult {
  seed: string;
  trials: number;
  antithetic: boolean;
  distribution: RiskDistribution;
}

export function simulate(inputs: TrialInputs, options: SimulationOptions): SimulationResult {
  const requested = options.trials ?? DEFAULT_TRIALS;
  const trials = Math.min(Math.max(Math.floor(requested), MIN_TRIALS), MAX_TRIALS);
  const antithetic = options.antithetic ?? true;

  if (inputs.ensemblePool.length === 0 && inputs.climatologyPool.length === 0) {
    throw new Error("NO_WEATHER_TRAJECTORIES");
  }
  if (inputs.waitingHoursSorted.length === 0) {
    throw new Error("NO_CONGESTION_SAMPLES");
  }

  const rng = makeRng(options.seed);
  const outcomes: TrialOutcome[] = [];

  if (antithetic) {
    // Pairs, so the requested count is honoured exactly whether it is odd or
    // even: an odd request runs one unpaired trial rather than silently
    // rounding, because a caller who asked for 5001 should get 5001.
    const pairs = Math.floor(trials / 2);
    for (let i = 0; i < pairs; i++) {
      const v = drawTrialVector(rng.next);
      outcomes.push(runTrialFromVector(v, inputs));
      outcomes.push(runTrialFromVector(mirrorVector(v), inputs));
    }
    if (trials % 2 === 1) {
      outcomes.push(runTrialFromVector(drawTrialVector(rng.next), inputs));
    }
  } else {
    for (let i = 0; i < trials; i++) {
      outcomes.push(runTrialFromVector(drawTrialVector(rng.next), inputs));
    }
  }

  return {
    seed: options.seed,
    trials: outcomes.length,
    antithetic,
    distribution: summarize(outcomes),
  };
}
