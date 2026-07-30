// Turning a set of sampled durations into an event timeline the engine can run.
//
// Extracted from `simulator/fixture-risk.ts`, which had this logic with the
// waiting time hard-coded at two hours. The pre-arrival engine samples waiting
// time from a port's queue instead, so the shape is now a parameter. Both
// callers share one definition of what a synthetic voyage looks like: two
// simulators quietly disagreeing about when laytime starts would be a very
// expensive kind of bug to find.
//
// Pure.

import type { SofEventInput } from "@/lib/laytime/types";

const HOUR_MS = 3_600_000;

/** The engine iterates at most 1440 hours; leave margin for turn time. */
export const MAX_TIMELINE_HOURS = 1200;

export interface VoyageShape {
  /** When NOR is tendered. */
  startISO: string;
  /**
   * NOR → ALL_FAST. The queue.
   *
   * Whole hours: the engine's breakdown is hourly, so a fractional wait would
   * imply a precision the output does not carry. Callers round before sampling
   * so the rounding is visible at the call site rather than hidden here.
   */
  waitingHours: number;
  /** ALL_FAST → cargo commences. Hose connection, surveys, gear rigging. */
  berthToOpsHours: number;
  /**
   * Stoppage flag per hour, indexed from `startISO` — NOT from ops commencing.
   * Hours past the end of the array are treated as workable.
   */
  stoppageFlags: boolean[];
  /** Hours of ACTUAL cargo work required; stoppages extend the stay. */
  opsDurationHours: number;
  maxTimelineHours?: number;
  /** COMMENCED/COMPLETED_LOADING (default) or the discharge pair. */
  operation?: "loading" | "discharge";
}

/**
 * Builds NOR → berth → ops → completion, pausing work during stoppage hours.
 *
 * Weather events are emitted as paired WEATHER_DELAY / WEATHER_DELAY_END, which
 * is what the engine expects and what the WWD resolver emits — never
 * EXCEPTED_PERIOD, because an excepted period is excluded under every days
 * basis while weather is only excluded under a weather-working one.
 */
export function synthesizeVoyageTimeline(shape: VoyageShape): SofEventInput[] {
  const maxHours = shape.maxTimelineHours ?? MAX_TIMELINE_HOURS;
  const start = new Date(shape.startISO);
  const at = (h: number) => new Date(start.getTime() + h * HOUR_MS).toISOString();

  const waiting = Math.max(0, Math.round(shape.waitingHours));
  const berthLag = Math.max(0, Math.round(shape.berthToOpsHours));
  const opsStartHour = waiting + berthLag;

  const commenced = shape.operation === "discharge" ? "COMMENCED_DISCHARGE" : "COMMENCED_LOADING";
  const completed = shape.operation === "discharge" ? "COMPLETED_DISCHARGE" : "COMPLETED_LOADING";

  const events: SofEventInput[] = [
    { id: "nor", occurred_at: at(0), event_type: "NOR_TENDERED" },
    { id: "fast", occurred_at: at(waiting), event_type: "ALL_FAST" },
    { id: "ops", occurred_at: at(opsStartHour), event_type: commenced as SofEventInput["event_type"] },
  ];

  let worked = 0;
  let hour = opsStartHour;
  let weatherOpen = false;
  let pairIndex = 0;

  while (worked < shape.opsDurationHours && hour < maxHours) {
    const stopped = shape.stoppageFlags[hour] === true;
    if (stopped && !weatherOpen) {
      events.push({ id: `w${pairIndex}s`, occurred_at: at(hour), event_type: "WEATHER_DELAY" });
      weatherOpen = true;
    } else if (!stopped && weatherOpen) {
      events.push({ id: `w${pairIndex}e`, occurred_at: at(hour), event_type: "WEATHER_DELAY_END" });
      weatherOpen = false;
      pairIndex++;
    }
    if (!stopped) worked++;
    hour++;
  }

  // A stoppage still running when cargo finishes must still be closed, or the
  // engine sees an unterminated interruption and excludes the rest of time.
  if (weatherOpen) {
    events.push({ id: `w${pairIndex}e`, occurred_at: at(hour), event_type: "WEATHER_DELAY_END" });
  }
  events.push({
    id: "done",
    occurred_at: at(hour),
    event_type: completed as SofEventInput["event_type"],
  });
  return events;
}
