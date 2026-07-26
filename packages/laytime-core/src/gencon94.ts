// Laytime rules engine: GENCON 94 (dry bulk) and ASBATANKVOY (tanker).
// Pure TypeScript, no I/O, no AI. Every branch cites its clause in clause_ref.
// GENCON 94 references cite the form's clause numbers; ASBATANKVOY references
// cite Part II clauses ("ASBA-II-n").

import { toZonedTime } from 'date-fns-tz';
import { Decimal } from 'decimal.js';

import {
  BreakdownRow,
  BreakdownStatus,
  CpTerms,
  LaytimeResult,
  SofEventInput,
  EventTypeEnum,
  PortCalendar,
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

// Local calendar date (YYYY-MM-DD) in the port's own timezone. Holidays are
// days in the port's reckoning, so the comparison has to happen in local terms.
function localDateKey(d: Date, tz: string): string {
  const local = toZonedTime(d, tz);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isCalendarHoliday(d: Date, tz: string, calendar?: PortCalendar): boolean {
  if (!calendar || calendar.holidays.length === 0) return false;
  return calendar.holidays.includes(localDateKey(d, tz));
}

// Excepted days are the weekend days the basis excludes, plus any holiday the
// supplied port calendar names. With no calendar this is exactly the old
// Sunday/Saturday test, which is what keeps existing results identical.
//
// Note this deliberately reports holidays under EVERY basis, including SHINC.
// The caller downstream decides whether an excepted hour counts, and SHINC's
// branch counts it — so labelling stays truthful ("holiday, counts under
// SHINC") instead of pretending the day was ordinary.
function isExceptedDay(
  d: Date,
  daysBasis: string,
  tz: string,
  calendar?: PortCalendar
): boolean {
  if (isCalendarHoliday(d, tz, calendar)) return true;
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
  tz: string,
  calendar?: PortCalendar
): boolean {
  for (const p of exceptedPeriods) {
    if (hour >= p.start && hour < p.end) return true;
  }
  return isExceptedDay(hour, daysBasis, tz, calendar);
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

// Events that CLOSE an interval. At an identical timestamp these must be
// processed before the events that open one: a stoppage cannot begin before the
// previous stoppage has ended, and pairing them the other way round silently
// swallows an interval (the opener is discarded because one is already open,
// then its terminator is discarded because none is).
const TERMINATOR_TYPES = new Set<string>([
  "WEATHER_DELAY_END",
  "SHIFTING_END",
  "EXCEPTED_PERIOD_END",
  "HATCH_CLOSE",
  "COMPLETED_LOADING",
  "COMPLETED_DISCHARGE",
]);

/**
 * Total order over events, so the result is a function of the event SET rather
 * than of the array order it happened to arrive in.
 *
 * Every sort in this engine compares timestamps only, and ES sorts are stable —
 * so before this existed, two events at the same instant were resolved by input
 * order. That made the engine's output depend on how the caller's query happened
 * to return rows: `recompute-server.ts` orders by `occurred_at` alone, and
 * Postgres gives no guarantee for ties, so the same claim could compute two
 * different figures. Measured on a specimen voyage: 48 vs 60 used hours from
 * reordering two array elements.
 *
 * Ordering is (time, terminators-first, type, id). The id tiebreak is what makes
 * it total — without it two same-typed events at the same instant would still be
 * order-dependent.
 */
function canonicalEventOrder(events: SofEventInput[]): SofEventInput[] {
  return [...events].sort((a, b) => {
    const ta = new Date(a.occurred_at).getTime();
    const tb = new Date(b.occurred_at).getTime();
    if (ta !== tb) return ta - tb;

    const aTerm = TERMINATOR_TYPES.has(a.event_type) ? 0 : 1;
    const bTerm = TERMINATOR_TYPES.has(b.event_type) ? 0 : 1;
    if (aTerm !== bTerm) return aTerm - bTerm;

    if (a.event_type !== b.event_type) return a.event_type < b.event_type ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// === Main entrypoint ===
export function recomputeLaytime(
  inputEvents: SofEventInput[],
  cpTerms: CpTerms
): LaytimeResult {
  // Normalised once, at the boundary. Every downstream sort is stable, so they
  // all inherit this order and the whole computation becomes reproducible from
  // the event set alone — which is the property an offline verifier rests on.
  const events = canonicalEventOrder(inputEvents);
  // Step 1: NOR validation
  const norEvents = events.filter((e) => e.event_type === "NOR_TENDERED");
  if (norEvents.length > 1) {
    throw new Error("MULTIPLE_NOR: Multiple NOR_TENDERED events found");
  }
  const norEvent = norEvents[0];
  if (!norEvent) throw new NoNorError();

  const norTime = parseISO(norEvent.occurred_at);
  const tz = cpTerms.port_timezone || "UTC";
  const isAsba = (cpTerms.cp_form ?? "GENCON94") === "ASBATANKVOY";

  let laytimeCommencesAt = addHours(norTime, cpTerms.turn_time_hours);

  if (isAsba) {
    // ASBA-II-6: laytime commences on expiry of turn time (6h standard) after
    // NOR, or upon the vessel's arrival in berth, whichever first occurs.
    const berthedAt = events
      .filter((e) => e.event_type === "ALL_FAST" || e.event_type === "BERTHED")
      .map((e) => parseISO(e.occurred_at))
      .filter((d) => d >= norTime)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (berthedAt && berthedAt < laytimeCommencesAt) {
      laytimeCommencesAt = berthedAt;
    }
  } else if (cpTerms.days_basis !== "SHINC") {
     let guard = 0;
     while(isExceptedDay(laytimeCommencesAt, cpTerms.days_basis, tz, cpTerms.port_calendar) && guard < 168) {
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
  let halfRateDemurrageHours = 0;

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
      if (isAsba && isActiveAt(weatherIntervals, hourStart)) {
        halfRateDemurrageHours += 1;
        clause_ref = "ASBA-II-8";
        reasoning = "Demurrage during storm/weather — rate reduced one-half.";
      } else if (isAsba) {
        clause_ref = "ASBA-II-8";
        reasoning = "Demurrage per running hour, pro rata for part of an hour.";
      } else {
        clause_ref = "GENCON94-8";
        reasoning = "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.";
      }
    } else if (isAsba) {
      // ASBATANKVOY: running hours — Sundays/holidays included, weather does
      // not stop laytime; only agreed exceptions and delays getting into
      // berth beyond the charterer's control are excluded.
      const explicitExcepted = exceptedPeriods.some(
        (p) => hourStart >= p.start && hourStart < p.end
      );
      if (explicitExcepted) {
        status = "excepted";
        counts = false;
        clause_ref = "ASBA-II-7";
        reasoning = "Agreed excepted period excluded from laytime.";
      } else if (isActiveAt(shiftingIntervals, hourStart)) {
        status = "shifting";
        counts = false;
        clause_ref = "ASBA-II-6";
        reasoning = "Delay getting into berth after NOR, beyond Charterer's control — does not count as used laytime.";
      } else if (isActiveAt(weatherIntervals, hourStart)) {
        status = "weather_delay";
        counts = true;
        clause_ref = "ASBA-II-7";
        reasoning = "Running hours — weather interruptions do not stop laytime.";
      } else {
        status = "laytime";
        counts = true;
        clause_ref = "ASBA-II-7";
        reasoning = "Laytime running (running hours, Sundays and holidays included).";
      }
    } else {
      const weatherActive = isActiveAt(weatherIntervals, hourStart);
      const daysBasisIncludesWWD = cpTerms.days_basis.includes("WWD");
      if (weatherActive && daysBasisIncludesWWD) {
        status = "weather_delay";
        counts = false;
        clause_ref = "GENCON94-6c";
        reasoning = "Weather working day excluded — weather delays excluded from laytime.";
      } else {
        const excepted = isExceptedHour(
          hourStart,
          exceptedPeriods,
          cpTerms.days_basis,
          tz,
          cpTerms.port_calendar
        );
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

  // ASBA-II-8: hours flagged half-rate bill at 50%; everything else full rate.
  const effectiveDemurrageHours = new Decimal(time_on_demurrage_hours)
    .minus(halfRateDemurrageHours)
    .plus(new Decimal(halfRateDemurrageHours).div(2));
  const demurrage_amount = effectiveDemurrageHours.div(24).mul(cpTerms.demurrage_rate).toDecimalPlaces(2).toNumber();
  const despatch_amount = new Decimal(time_saved_hours).div(24).mul(cpTerms.despatch_rate).toDecimalPlaces(2).toNumber();

  return {
    breakdown,
    totals: {
      allowed_hours: allowedHours,
      used_hours: usedHours,
      time_on_demurrage_hours,
      time_saved_hours,
      ...(isAsba ? { demurrage_half_rate_hours: halfRateDemurrageHours } : {}),
      demurrage_amount,
      despatch_amount,
      currency: cpTerms.currency,
    },
  };
}
