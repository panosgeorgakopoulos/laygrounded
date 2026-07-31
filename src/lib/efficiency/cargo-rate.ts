// What rate did the terminal ACTUALLY achieve?
//
// The number nobody computes rigorously, and the foundation of every argument
// about whose fault a slow call was. Two rates matter and they answer different
// questions:
//
//   GROSS rate — cargo ÷ (completed − commenced). What the berth delivered
//                end to end, including every interruption.
//   NET rate   — cargo ÷ time actually working. What the gear achieved when it
//                was turning.
//
// A charterparty rate "per weather working day" is a NET-of-weather figure, so
// comparing it against a gross rate would indict a terminal for a storm. The
// comparison basis is therefore explicit rather than assumed.
//
// Pure: no I/O, no clock.

import type { SofEventInput } from "@/lib/laytime/types";

export interface CargoQuantity {
  tonnes: number;
  /** The text it was read from, so a reader can check the parse. */
  raw: string;
  /** How confident the parse is — see parseCargoQuantity. */
  confident: boolean;
}

const UNIT_MULTIPLIER: Record<string, number> = {
  mt: 1,
  t: 1,
  tonne: 1,
  tonnes: 1,
  ton: 1,
  tons: 1,
  kt: 1000,
};

/**
 * Reads a cargo quantity out of free text like "Soybeans, 54,000 MT".
 *
 * `claims.cargo` is a description an operator typed, not a structured field, so
 * this returns null rather than guessing when it cannot find an unambiguous
 * quantity. A rate computed from a misread tonnage is worse than no rate: it
 * looks authoritative and is wrong by whatever factor the misread was.
 *
 * Multiple numbers in the string means ambiguity ("Grain 54,000 MT in 5 holds"
 * is fine, but "50,000/55,000 MT" is a range and must not be resolved to one).
 */
export function parseCargoQuantity(cargo: string | null | undefined): CargoQuantity | null {
  if (!cargo || !cargo.trim()) return null;
  const text = cargo.trim();

  // number (with thousands separators / decimals) followed by a mass unit
  const re = /(\d[\d,.\s]*)\s*(kt|mt|tonnes|tonne|tons|ton|t)\b/gi;
  const hits: Array<{ tonnes: number; raw: string }> = [];

  for (const m of text.matchAll(re)) {
    const digits = m[1].replace(/[,\s]/g, "");
    // A trailing dot is a sentence, not a decimal point.
    const value = Number.parseFloat(digits.replace(/\.$/, ""));
    if (!Number.isFinite(value) || value <= 0) continue;
    const mult = UNIT_MULTIPLIER[m[2].toLowerCase()] ?? 1;
    hits.push({ tonnes: value * mult, raw: m[0].trim() });
  }

  if (hits.length === 0) return null;

  // A single unambiguous quantity is confident; several are not, and the
  // largest is reported with `confident: false` so a caller can refuse to act.
  if (hits.length === 1) return { ...hits[0], confident: true };

  const largest = hits.reduce((a, b) => (b.tonnes > a.tonnes ? b : a));
  return { ...largest, confident: false };
}

export interface WorkingTime {
  /** Commenced → completed, wall clock. */
  grossHours: number;
  /** Gross minus every recorded interruption. */
  netHours: number;
  /** Hours removed, by cause. */
  interruptions: { weatherHours: number; shiftingHours: number; exceptedHours: number };
  from: string;
  to: string;
}

const OPS_START = new Set(["COMMENCED_LOADING", "COMMENCED_DISCHARGE"]);
const OPS_END = new Set(["COMPLETED_LOADING", "COMPLETED_DISCHARGE"]);

const PAIRS: Array<{ open: string; close: string; bucket: keyof WorkingTime["interruptions"] }> = [
  { open: "WEATHER_DELAY", close: "WEATHER_DELAY_END", bucket: "weatherHours" },
  { open: "SHIFTING", close: "SHIFTING_END", bucket: "shiftingHours" },
  { open: "EXCEPTED_PERIOD_START", close: "EXCEPTED_PERIOD_END", bucket: "exceptedHours" },
];

const HOUR_MS = 3_600_000;

/**
 * Working time between the first commencement and the last completion.
 *
 * Interruptions are clipped to the operations window, so a weather delay that
 * began before cargo started does not subtract time the terminal never had.
 */
export function computeWorkingTime(events: SofEventInput[]): WorkingTime | null {
  const ordered = [...events].sort(
    (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)
  );

  const start = ordered.find((e) => OPS_START.has(e.event_type as string));
  const end = [...ordered].reverse().find((e) => OPS_END.has(e.event_type as string));
  if (!start || !end) return null;

  const from = Date.parse(start.occurred_at);
  const to = Date.parse(end.occurred_at);
  if (!(to > from)) return null;

  const interruptions = { weatherHours: 0, shiftingHours: 0, exceptedHours: 0 };

  for (const { open, close, bucket } of PAIRS) {
    let openAt: number | null = null;
    for (const e of ordered) {
      const t = Date.parse(e.occurred_at);
      if ((e.event_type as string) === open && openAt === null) openAt = t;
      else if ((e.event_type as string) === close && openAt !== null) {
        const clippedFrom = Math.max(openAt, from);
        const clippedTo = Math.min(t, to);
        if (clippedTo > clippedFrom) {
          interruptions[bucket] += (clippedTo - clippedFrom) / HOUR_MS;
        }
        openAt = null;
      }
    }
  }

  const grossHours = (to - from) / HOUR_MS;
  const totalInterrupted =
    interruptions.weatherHours + interruptions.shiftingHours + interruptions.exceptedHours;

  return {
    grossHours,
    // Clamped: overlapping interruption pairs could otherwise subtract more
    // time than the window contains and produce a negative working span.
    netHours: Math.max(0, grossHours - totalInterrupted),
    interruptions,
    from: start.occurred_at,
    to: end.occurred_at,
  };
}

export type RateBasis = "gross" | "net";

export interface AchievedRate {
  /** Metric tonnes per DAY, the unit charterparties quote. */
  tonnesPerDay: number;
  basis: RateBasis;
  hoursUsed: number;
  quantity: CargoQuantity;
  workingTime: WorkingTime;
}

/**
 * The rate the terminal actually achieved.
 *
 * Returns null when the quantity or the operations window cannot be
 * established — a rate is a ratio, and neither half may be invented.
 */
export function computeAchievedRate(
  cargo: string | null | undefined,
  events: SofEventInput[],
  basis: RateBasis = "net"
): AchievedRate | null {
  const quantity = parseCargoQuantity(cargo);
  if (!quantity) return null;

  const workingTime = computeWorkingTime(events);
  if (!workingTime) return null;

  const hoursUsed = basis === "net" ? workingTime.netHours : workingTime.grossHours;
  if (!(hoursUsed > 0)) return null;

  return {
    tonnesPerDay: (quantity.tonnes / hoursUsed) * 24,
    basis,
    hoursUsed,
    quantity,
    workingTime,
  };
}
