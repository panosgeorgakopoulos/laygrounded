// Inferring a port's non-working days from real statements of facts.
//
// The other half of the calendar dataset. Customers supply what they know; this
// notices what their paperwork already shows — a whole local day, inside a
// vessel's stay alongside, during which nothing happened.
//
// EVERY OUTPUT HERE IS A HYPOTHESIS. A quiet day may be a public holiday, or a
// breakdown, or congestion, or simply a gap in the paperwork, and this module
// cannot tell those apart. Observations are therefore emitted as candidates for
// a human to confirm, and the loader excludes unconfirmed days from every
// calculation. An inference that silently moved money would be the same failure
// as inventing the calendar outright.
//
// Pure — the caller supplies events and persists the candidates.

import { toZonedTime } from "date-fns-tz";
import type { SofEventInput } from "@/lib/laytime/types";

export interface CalendarCandidate {
  /** Local calendar date (YYYY-MM-DD) in the port's timezone. */
  date: string;
  /** Why this day is being proposed, in words a reviewer can check. */
  rationale: string;
  /** Hours of the local day covered by the vessel's stay. */
  observedHours: number;
}

/** Events that show cargo work actually happening. */
const ACTIVITY_TYPES = new Set([
  "COMMENCED_LOADING",
  "COMMENCED_DISCHARGE",
  "COMPLETED_LOADING",
  "COMPLETED_DISCHARGE",
  "HATCH_OPEN",
  "HATCH_CLOSE",
]);

/** Events that explain idleness for a reason that is NOT a holiday. */
const COMPETING_EXPLANATION_TYPES = new Set([
  "WEATHER_DELAY",
  "WEATHER_DELAY_END",
  "SHIFTING",
  "SHIFTING_END",
  "BREAKDOWN",
  "STRIKE",
]);

const MS_PER_HOUR = 3_600_000;

function localDateKey(d: Date, tz: string): string {
  const local = toZonedTime(d, tz);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Proposes non-working days from one voyage's confirmed events.
 *
 * Scope is deliberately narrow — only days fully inside the berthed window, only
 * days with no cargo activity, and only days with no competing explanation
 * already on the timeline. A weather stoppage or a strike already accounts for
 * the idleness, and proposing a holiday on top would double-count the same
 * quiet day in the operator's review queue.
 */
export function observeNonWorkingDays(
  events: SofEventInput[],
  timezone: string,
): CalendarCandidate[] {
  const sorted = [...events]
    .map((e) => ({ ...e, at: new Date(e.occurred_at) }))
    .filter((e) => !isNaN(e.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (sorted.length === 0) return [];

  // The stay: alongside until cargo work completes. Outside that window the
  // vessel's idleness says nothing about whether the port was working.
  const berthed = sorted.find((e) => e.event_type === "ALL_FAST" || e.event_type === "BERTHED");
  const completed = [...sorted]
    .reverse()
    .find((e) => e.event_type === "COMPLETED_LOADING" || e.event_type === "COMPLETED_DISCHARGE");

  if (!berthed || !completed || completed.at <= berthed.at) return [];

  const activeDates = new Set<string>();
  const explainedDates = new Set<string>();
  for (const e of sorted) {
    if (ACTIVITY_TYPES.has(e.event_type)) activeDates.add(localDateKey(e.at, timezone));
    if (COMPETING_EXPLANATION_TYPES.has(e.event_type)) {
      explainedDates.add(localDateKey(e.at, timezone));
    }
  }

  // Cargo work spans the gaps between its start and end events, so a day with no
  // event of its own can still be a working day. Mark every local date covered
  // by an operations interval as active.
  let openOps: Date | null = null;
  for (const e of sorted) {
    if (e.event_type === "COMMENCED_LOADING" || e.event_type === "COMMENCED_DISCHARGE") {
      if (!openOps) openOps = e.at;
    } else if (
      e.event_type === "COMPLETED_LOADING" ||
      e.event_type === "COMPLETED_DISCHARGE"
    ) {
      if (openOps) {
        for (const d of localDatesBetween(openOps, e.at, timezone)) activeDates.add(d);
        openOps = null;
      }
    }
  }

  // Likewise for a competing explanation that spans days.
  let openExplanation: Date | null = null;
  for (const e of sorted) {
    if (e.event_type === "WEATHER_DELAY" || e.event_type === "SHIFTING") {
      if (!openExplanation) openExplanation = e.at;
    } else if (e.event_type === "WEATHER_DELAY_END" || e.event_type === "SHIFTING_END") {
      if (openExplanation) {
        for (const d of localDatesBetween(openExplanation, e.at, timezone)) explainedDates.add(d);
        openExplanation = null;
      }
    }
  }

  const candidates: CalendarCandidate[] = [];
  for (const date of localDatesBetween(berthed.at, completed.at, timezone)) {
    if (activeDates.has(date) || explainedDates.has(date)) continue;

    // Partial days at either end of the stay are not evidence: the vessel was
    // only there for part of them, so silence proves nothing about the port.
    const coverage = localDayCoverageHours(date, berthed.at, completed.at, timezone);
    if (coverage < 24) continue;

    candidates.push({
      date,
      rationale:
        "Vessel was alongside for the whole of this local day with no cargo activity " +
        "recorded, and no weather, shifting or other stoppage explains the idleness.",
      observedHours: coverage,
    });
  }

  return candidates;
}

/** Every local date touched by [start, end], inclusive. */
function localDatesBetween(start: Date, end: Date, tz: string): string[] {
  const dates: string[] = [];
  const seen = new Set<string>();
  // Step hourly rather than daily: a daily step in UTC drifts against the local
  // day across DST boundaries and can skip or duplicate a date.
  for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_HOUR) {
    const key = localDateKey(new Date(t), tz);
    if (!seen.has(key)) {
      seen.add(key);
      dates.push(key);
    }
  }
  const endKey = localDateKey(end, tz);
  if (!seen.has(endKey)) dates.push(endKey);
  return dates;
}

/** How many hours of `date` (port-local) fall inside [start, end]. */
function localDayCoverageHours(date: string, start: Date, end: Date, tz: string): number {
  let hours = 0;
  for (let t = start.getTime(); t < end.getTime(); t += MS_PER_HOUR) {
    if (localDateKey(new Date(t), tz) === date) hours++;
  }
  return hours;
}
