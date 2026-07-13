// Parametric trigger detection — pure function over the deterministic
// engine's breakdown. No I/O, no thresholds baked in: rows in, longest
// continuous weather-delay window out. The oracle service compares that
// window against each policy's threshold.

import type { BreakdownRow } from "@/lib/laytime/types";

export interface ContinuousDelay {
  hours: number;
  start: string; // ISO, first weather row's start_time
  end: string; // ISO, last contiguous weather row's end_time
  segments: number; // breakdown rows merged into this window
}

// Engine breakdown rows are chronologically contiguous, but timestamps may
// differ in formatting between rows — compare instants, with a minute of
// tolerance for rounding at row boundaries.
const CONTIGUITY_TOLERANCE_MS = 60_000;

function contiguous(prevEnd: string, nextStart: string): boolean {
  const gap = Math.abs(new Date(nextStart).getTime() - new Date(prevEnd).getTime());
  return Number.isFinite(gap) && gap <= CONTIGUITY_TOLERANCE_MS;
}

/**
 * Longest run of contiguous weather_delay rows in a breakdown, or null when
 * the breakdown contains none. Any intervening non-weather row (laytime
 * resuming, shifting, excepted period) breaks continuity — "continuous"
 * means the engine saw weather stop the clock without interruption.
 */
export function longestContinuousWeatherDelay(
  breakdown: BreakdownRow[]
): ContinuousDelay | null {
  let best: ContinuousDelay | null = null;
  let run: ContinuousDelay | null = null;

  for (const row of breakdown) {
    if (row.status !== "weather_delay") {
      run = null;
      continue;
    }
    if (run && contiguous(run.end, row.start_time)) {
      run.hours += row.duration_hours;
      run.end = row.end_time;
      run.segments += 1;
    } else {
      run = {
        hours: row.duration_hours,
        start: row.start_time,
        end: row.end_time,
        segments: 1,
      };
    }
    if (!best || run.hours > best.hours) best = { ...run };
  }

  return best;
}

/**
 * The policy decision: the longest continuous weather delay when it meets or
 * exceeds the threshold, else null. Kept separate from detection so the
 * threshold comparison is its own testable seam.
 */
export function detectParametricTrigger(
  breakdown: BreakdownRow[],
  thresholdHours: number
): ContinuousDelay | null {
  const longest = longestContinuousWeatherDelay(breakdown);
  if (!longest || longest.hours < thresholdHours) return null;
  return longest;
}
