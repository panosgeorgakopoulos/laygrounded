// GENCON 94 laytime rules engine.
// Pure TypeScript, no I/O, no AI. Every branch cites its clause in clause_ref.

import { toZonedTime } from 'date-fns-tz';
import { Decimal } from 'decimal.js';

import {
  BreakdownRow,
  BreakdownStatus,
  CpTerms,
  LaytimeResult,
  SofEventInput,
  EventTypeEnum,
} from "./types";

export class NoNorError extends Error {
  constructor() {
    super("NO_NOR");
    this.name = "NoNorError";
  }
}

// === Helpers ===

function parseISO(s: string): Date {
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid ISO timestamp: "${s}"`);
  }
  return d;
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3600_000);
}

function diffHours(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3600_000;
}

function toISO(d: Date): string {
  return d.toISOString();
}

function isSundayLocal(d: Date, tz: string): boolean {
  return toZonedTime(d, tz).getDay() === 0;
}

function isSaturdayLocal(d: Date, tz: string): boolean {
  return toZonedTime(d, tz).getDay() === 6;
}

// A holiday is approximated as Sunday for the engine's deterministic logic.
function isExceptedDay(d: Date, daysBasis: string, tz: string): boolean {
  if (daysBasis.includes("SSHEX")) {
    return isSundayLocal(d, tz) || isSaturdayLocal(d, tz);
  }
  return isSundayLocal(d, tz);
}

// Determine if a Date lies inside an excepted period (Sunday or holiday).
function isExceptedHour(
  hour: Date,
  exceptedPeriods: Array<{ start: Date; end: Date }>,
  daysBasis: string,
  tz: string
): boolean {
  for (const p of exceptedPeriods) {
    if (hour >= p.start && hour < p.end) return true;
  }
  return isExceptedDay(hour, daysBasis, tz);
}

// Pre-compute intervals for O(n) checking
type Interval = { start: Date; end: Date };

// Pairs an explicit start/end event type (e.g. WEATHER_DELAY / WEATHER_DELAY_END)
// into intervals, mirroring getHatchIntervals/getOperationsIntervals below. A
// start with no matching end runs to windowEnd (conservative: we never assume
// a delay ended just because some unrelated event happened to be logged next).
// A stray end with no open start is ignored.
function getPairedIntervals(
  events: SofEventInput[],
  startType: EventTypeEnum,
  endType: EventTypeEnum,
  windowEnd: Date
): Interval[] {
  const intervals: Interval[] = [];
  let currentStart: Date | null = null;
  const paired = events
    .filter((e) => e.event_type === startType || e.event_type === endType)
    .sort((a, b) => parseISO(a.occurred_at).getTime() - parseISO(b.occurred_at).getTime());

  for (const ev of paired) {
    if (ev.event_type === startType) {
      if (!currentStart) currentStart = parseISO(ev.occurred_at);
    } else if (ev.event_type === endType) {
      if (currentStart) {
        intervals.push({ start: currentStart, end: parseISO(ev.occurred_at) });
        currentStart = null;
      }
    }
  }
  if (currentStart) {
    intervals.push({ start: currentStart, end: windowEnd });
  }
  return intervals;
}

function isActiveAt(intervals: Interval[], hour: Date): boolean {
  return intervals.some(i => hour >= i.start && hour < i.end);
}

// Operations ongoing logic
function getOperationsIntervals(events: SofEventInput[], windowEnd: Date): Interval[] {
  const intervals: Interval[] = [];
  let currentStart: Date | null = null;

  const opsEvents = events
    .filter(e => ["COMMENCED_LOADING", "COMPLETED_LOADING", "COMMENCED_DISCHARGE", "COMPLETED_DISCHARGE"].includes(e.event_type))
    .sort((a, b) => parseISO(a.occurred_at).getTime() - parseISO(b.occurred_at).getTime());

  for (const ev of opsEvents) {
    if (ev.event_type === "COMMENCED_LOADING" || ev.event_type === "COMMENCED_DISCHARGE") {
      if (!currentStart) currentStart = parseISO(ev.occurred_at);
    } else if (ev.event_type === "COMPLETED_LOADING" || ev.event_type === "COMPLETED_DISCHARGE") {
      if (currentStart) {
        intervals.push({ start: currentStart, end: parseISO(ev.occurred_at) });
        currentStart = null;
      }
    }
  }
  if (currentStart) {
    intervals.push({ start: currentStart, end: windowEnd });
  }
  return intervals;
}

function getHatchIntervals(events: SofEventInput[], windowEnd: Date): Interval[] {
  const intervals: Interval[] = [];
  let currentStart: Date | null = null;
  const hatchEvents = events
    .filter(e => ["HATCH_OPEN", "HATCH_CLOSE"].includes(e.event_type))
    .sort((a, b) => parseISO(a.occurred_at).getTime() - parseISO(b.occurred_at).getTime());

  for (const ev of hatchEvents) {
    if (ev.event_type === "HATCH_OPEN") {
      if (!currentStart) currentStart = parseISO(ev.occurred_at);
    } else if (ev.event_type === "HATCH_CLOSE") {
      if (currentStart) {
        intervals.push({ start: currentStart, end: parseISO(ev.occurred_at) });
        currentStart = null;
      }
    }
  }
  if (currentStart) {
    intervals.push({ start: currentStart, end: windowEnd });
  }
  return intervals;
}

// === Main entrypoint ===
export function recomputeLaytime(
  events: SofEventInput[],
  cpTerms: CpTerms
): LaytimeResult {
  // Step 1: NOR validation
  const norEvents = events.filter((e) => e.event_type === "NOR_TENDERED");
  if (norEvents.length > 1) {
    throw new Error("MULTIPLE_NOR: Multiple NOR_TENDERED events found");
  }
  const norEvent = norEvents[0];
  if (!norEvent) throw new NoNorError();

  const norTime = parseISO(norEvent.occurred_at);
  const tz = cpTerms.port_timezone || "UTC";

  let laytimeCommencesAt = addHours(norTime, cpTerms.turn_time_hours);
  
  if (cpTerms.days_basis !== "SHINC") {
     let guard = 0;
     while(isExceptedDay(laytimeCommencesAt, cpTerms.days_basis, tz) && guard < 168) {
        laytimeCommencesAt = addHours(laytimeCommencesAt, 1);
        guard++;
     }
  }

  // Step 2: operational window end
  const completedEvents = events
    .filter((e) => e.event_type === "COMPLETED_LOADING" || e.event_type === "COMPLETED_DISCHARGE")
    .map((e) => parseISO(e.occurred_at))
    .sort((a, b) => a.getTime() - b.getTime());
  
  const windowEnd = completedEvents[completedEvents.length - 1] ?? addHours(laytimeCommencesAt, 72);

  // Pre-compute excepted periods from explicit events
  const exceptedPeriods: Array<{ start: Date; end: Date }> = [];
  const epEvents = events
    .filter((e) => e.event_type === "EXCEPTED_PERIOD_START" || e.event_type === "EXCEPTED_PERIOD_END")
    .sort((a, b) => parseISO(a.occurred_at).getTime() - parseISO(b.occurred_at).getTime());
  
  let currentEPStart: Date | null = null;
  for (const ev of epEvents) {
    if (ev.event_type === "EXCEPTED_PERIOD_START") {
      if (!currentEPStart) currentEPStart = parseISO(ev.occurred_at);
    } else if (ev.event_type === "EXCEPTED_PERIOD_END") {
      if (currentEPStart) {
        exceptedPeriods.push({ start: currentEPStart, end: parseISO(ev.occurred_at) });
        currentEPStart = null;
      }
    }
  }
  if (currentEPStart) {
    exceptedPeriods.push({ start: currentEPStart, end: windowEnd });
  }

  // Precompute intervals
  const weatherIntervals = getPairedIntervals(events, "WEATHER_DELAY", "WEATHER_DELAY_END", windowEnd);
  const shiftingIntervals = getPairedIntervals(events, "SHIFTING", "SHIFTING_END", windowEnd);
  const opsIntervals = getOperationsIntervals(events, windowEnd);
  const hatchIntervals = getHatchIntervals(events, windowEnd);

  // Step 3: hour-by-hour iteration
  const breakdown: BreakdownRow[] = [];
  let usedHours = 0;
  const allowedHours = cpTerms.laytime_allowed_hours;

  let cursor = new Date(laytimeCommencesAt);
  const hourly: Array<{
    hour: Date;
    status: BreakdownStatus;
    counts: boolean;
    clause_ref: string;
    reasoning: string;
  }> = [];

  let iterations = 0;
  const MAX_HOURS = 1440; // 60 days

  while (cursor < windowEnd && iterations < MAX_HOURS) {
    iterations++;
    const hourStart = new Date(cursor);
    const hourEnd = addHours(hourStart, 1);
    let status: BreakdownStatus = "laytime";
    let counts = true;
    let clause_ref = "GENCON94-6";
    let reasoning = "Default laytime — operations counting.";

    if (usedHours >= allowedHours) {
      status = "demurrage";
      counts = true;
      clause_ref = "GENCON94-8";
      reasoning = "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.";
    } else {
      const weatherActive = isActiveAt(weatherIntervals, hourStart);
      const daysBasisIncludesWWD = cpTerms.days_basis.includes("WWD");
      if (weatherActive && daysBasisIncludesWWD) {
        status = "weather_delay";
        counts = false;
        clause_ref = "GENCON94-6c";
        reasoning = "Weather working day excluded — weather delays excluded from laytime.";
      } else {
        const excepted = isExceptedHour(hourStart, exceptedPeriods, cpTerms.days_basis, tz);
        if (excepted) {
          if (cpTerms.days_basis === "SHINC") {
            status = "excepted";
            counts = true;
            clause_ref = "GENCON94-7(b)";
            reasoning = "Sunday/holiday counts under SHINC.";
          } else if (cpTerms.days_basis.includes("-UU")) {
            const hatchOpen = isActiveAt(hatchIntervals, hourStart);
            const opsOngoing = isActiveAt(opsIntervals, hourStart);
            if (hatchOpen && opsOngoing) {
              status = "excepted";
              counts = true;
              clause_ref = "GENCON94-7(d)";
              reasoning = "SHEX-UU: Excepted period counts when hatch open and operations ongoing.";
            } else {
              status = "excepted";
              counts = false;
              clause_ref = "GENCON94-7(c)";
              reasoning = "SHEX-UU: Excepted period excluded without operations.";
            }
          } else {
            status = "excepted";
            counts = false;
            clause_ref = "GENCON94-7(c)";
            reasoning = "Excepted period excluded.";
          }
        } else {
          const shiftingActive = isActiveAt(shiftingIntervals, hourStart);
          if (shiftingActive) {
            if (cpTerms.nor_variant === "WIBON") {
              status = "shifting";
              counts = true;
              clause_ref = "GENCON94-6c";
              reasoning = "WIBON: shifting counts as laytime (NOR valid before berth).";
            } else {
              status = "shifting";
              counts = false;
              clause_ref = "GENCON94-6c";
              reasoning = "Non-WIBON: shifting does not count as laytime.";
            }
          } else {
            status = "laytime";
            counts = true;
            clause_ref = "GENCON94-6";
            reasoning = "Laytime counting.";
          }
        }
      }
    }

    hourly.push({ hour: hourStart, status, counts, clause_ref, reasoning });
    if (counts) usedHours += 1;
    cursor = hourEnd;
  }

  if (iterations >= MAX_HOURS) {
    throw new Error(`CALCULATION_TIMEOUT: exceeded ${MAX_HOURS} hour iterations`);
  }

  for (const h of hourly) {
    const last = breakdown[breakdown.length - 1];
    if (
      last &&
      last.status === h.status &&
      last.counts === h.counts &&
      last.clause_ref === h.clause_ref &&
      last.reasoning === h.reasoning
    ) {
      last.end_time = toISO(addHours(h.hour, 1));
      last.duration_hours += 1;
    } else {
      breakdown.push({
        start_time: toISO(h.hour),
        end_time: toISO(addHours(h.hour, 1)),
        duration_hours: 1,
        status: h.status,
        counts: h.counts,
        clause_ref: h.clause_ref,
        reasoning: h.reasoning,
      });
    }
  }

  const time_on_demurrage_hours = Math.max(0, usedHours - allowedHours);
  const time_saved_hours = Math.max(0, allowedHours - usedHours);
  
  const demurrage_amount = new Decimal(time_on_demurrage_hours).div(24).mul(cpTerms.demurrage_rate).toDecimalPlaces(2).toNumber();
  const despatch_amount = new Decimal(time_saved_hours).div(24).mul(cpTerms.despatch_rate).toDecimalPlaces(2).toNumber();

  return {
    breakdown,
    totals: {
      allowed_hours: allowedHours,
      used_hours: usedHours,
      time_on_demurrage_hours,
      time_saved_hours,
      demurrage_amount,
      despatch_amount,
      currency: cpTerms.currency,
    },
  };
}
