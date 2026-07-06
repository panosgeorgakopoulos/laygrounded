// GENCON 94 laytime rules engine.
// Pure TypeScript, no I/O, no AI. Every branch cites its clause in clause_ref.

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
  return new Date(s);
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

// Sunday = 0, Saturday = 6
function isSunday(d: Date): boolean {
  return d.getUTCDay() === 0;
}

// A holiday is approximated as Sunday for the engine's deterministic logic.
// GENCON 94 treats Sundays and holidays equivalently for excepted-period purposes.
function isExceptedDay(d: Date): boolean {
  return isSunday(d);
}

// Determine if a Date lies inside an excepted period (Sunday or holiday).
// EXCEPTED_PERIOD_START / EXCEPTED_PERIOD_END events override this.
function isExceptedHour(
  hour: Date,
  exceptedPeriods: Array<{ start: Date; end: Date }>
): boolean {
  for (const p of exceptedPeriods) {
    if (hour >= p.start && hour < p.end) return true;
  }
  return isExceptedDay(hour);
}

// Find all active events of a given type that contain `hour`.
// An event is "active" from its occurred_at until the next event of any type
// in the same operational sequence, or until end of iteration.
function isEventActiveAt(
  events: SofEventInput[],
  type: EventTypeEnum,
  hour: Date,
  windowEnd: Date
): boolean {
  const matching = events
    .filter((e) => e.event_type === type)
    .sort((a, b) => parseISO(a.occurred_at).getTime() - parseISO(b.occurred_at).getTime());
  for (const ev of matching) {
    const start = parseISO(ev.occurred_at);
    if (start > hour) continue;
    // find next event of any type after this one
    const nextEvent = events
      .map((e) => parseISO(e.occurred_at))
      .filter((t) => t > start && t <= windowEnd)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const end = nextEvent ?? windowEnd;
    if (hour >= start && hour < end) return true;
  }
  return false;
}

// Determine if cargo operations are ongoing at `hour`.
function operationsOngoingAt(
  events: SofEventInput[],
  hour: Date,
  windowEnd: Date
): boolean {
  const commencedL = events.find((e) => e.event_type === "COMMENCED_LOADING");
  const completedL = events.find((e) => e.event_type === "COMPLETED_LOADING");
  const commencedD = events.find((e) => e.event_type === "COMMENCED_DISCHARGE");
  const completedD = events.find((e) => e.event_type === "COMPLETED_DISCHARGE");

  if (
    commencedL &&
    parseISO(commencedL.occurred_at) <= hour &&
    (!completedL || parseISO(completedL.occurred_at) > hour)
  ) {
    return true;
  }
  if (
    commencedD &&
    parseISO(commencedD.occurred_at) <= hour &&
    (!completedD || parseISO(completedD.occurred_at) > hour)
  ) {
    return true;
  }
  return false;
}

// Determine whether hatch is open at `hour`.
function hatchOpenAt(
  events: SofEventInput[],
  hour: Date,
  windowEnd: Date
): boolean {
  const open = events.find((e) => e.event_type === "HATCH_OPEN");
  const close = events.find((e) => e.event_type === "HATCH_CLOSE");
  if (!open) return false;
  const openT = parseISO(open.occurred_at);
  const closeT = close ? parseISO(close.occurred_at) : windowEnd;
  return hour >= openT && hour < closeT;
}

// If laytime_commences_at falls on a non-working period under SHEX rules,
// advance to next working hour (Monday 08:00 UTC by convention).
function advanceToWorkingHour(commencesAt: Date, daysBasis: string): Date {
  if (daysBasis === "SHINC") return commencesAt;
  // For SHEX / SHEX-UU / WWDSHEX-EIU, skip Sundays entirely.
  let result = new Date(commencesAt);
  while (isSunday(result)) {
    result = addHours(result, 24);
    // snap to 08:00 UTC Monday
    result.setUTCHours(8, 0, 0, 0);
  }
  return result;
}

// === Main entrypoint ===
export function recomputeLaytime(
  events: SofEventInput[],
  cpTerms: CpTerms
): LaytimeResult {
  // Step 1: NOR validation
  const norEvent = events.find((e) => e.event_type === "NOR_TENDERED");
  if (!norEvent) throw new NoNorError();

  const norTime = parseISO(norEvent.occurred_at);
  let laytimeCommencesAt = addHours(norTime, cpTerms.turn_time_hours);
  laytimeCommencesAt = advanceToWorkingHour(laytimeCommencesAt, cpTerms.days_basis);

  // Step 2: operational window end = last of COMPLETED_LOADING / COMPLETED_DISCHARGE
  const completedEvents = events
    .filter(
      (e) =>
        e.event_type === "COMPLETED_LOADING" ||
        e.event_type === "COMPLETED_DISCHARGE"
    )
    .map((e) => parseISO(e.occurred_at))
    .sort((a, b) => a.getTime() - b.getTime());
  if (completedEvents.length === 0) {
    // No completion event — iterate from commencement to NARROW window of NOR + 24h
    // to avoid runaway loops; the spec implies a completed event.
    // We'll iterate up to 720 hours (30 days) as a safety bound.
  }
  // If no completion event exists, iterate from commencement to a reasonable bound
  // (the spec implies a completed event). 72h default matches a typical laytime allowance.
  const windowEnd = completedEvents[completedEvents.length - 1] ?? addHours(laytimeCommencesAt, 72);

  // Pre-compute excepted periods from explicit events
  const exceptedPeriods: Array<{ start: Date; end: Date }> = [];
  const eps = events
    .filter((e) => e.event_type === "EXCEPTED_PERIOD_START")
    .sort((a, b) => parseISO(a.occurred_at).getTime() - parseISO(b.occurred_at).getTime());
  const epe = events
    .filter((e) => e.event_type === "EXCEPTED_PERIOD_END")
    .sort((a, b) => parseISO(a.occurred_at).getTime() - parseISO(b.occurred_at).getTime());
  for (let i = 0; i < eps.length; i++) {
    const start = parseISO(eps[i].occurred_at);
    const end = epe[i] ? parseISO(epe[i].occurred_at) : windowEnd;
    exceptedPeriods.push({ start, end });
  }

  // Step 3: hour-by-hour iteration
  const breakdown: BreakdownRow[] = [];
  let usedHours = 0;
  const allowedHours = cpTerms.laytime_allowed_hours;

  let cursor = new Date(laytimeCommencesAt);
  // Iterate hour-by-hour; we'll coalesce contiguous blocks at the end.
  const hourly: Array<{
    hour: Date;
    status: BreakdownStatus;
    counts: boolean;
    clause_ref: string;
    reasoning: string;
  }> = [];

  while (cursor < windowEnd) {
    const hourStart = new Date(cursor);
    const hourEnd = addHours(hourStart, 1);
    let status: BreakdownStatus = "laytime";
    let counts = true;
    let clause_ref = "GENCON94-6";
    let reasoning = "Default laytime — operations counting.";

    // 1. Once on demurrage
    if (usedHours >= allowedHours) {
      status = "demurrage";
      counts = true;
      clause_ref = "GENCON94-8";
      reasoning = "Once on demurrage — time counts continuously regardless of weather, weekends, or shifting.";
    } else {
      // 2. Weather delay (only if days_basis includes WWD)
      const weatherActive = isEventActiveAt(events, "WEATHER_DELAY", hourStart, windowEnd);
      const daysBasisIncludesWWD = cpTerms.days_basis === "WWDSHEX-EIU";
      if (weatherActive && daysBasisIncludesWWD) {
        status = "weather_delay";
        counts = false;
        clause_ref = "GENCON94-6c";
        reasoning = "Weather working day excluded — WWDSHEX-EIU excludes weather delays from laytime.";
      } else {
        // 3. Excepted period (Sunday/Holiday)
        const excepted = isExceptedHour(hourStart, exceptedPeriods);
        if (excepted) {
          if (cpTerms.days_basis === "SHINC") {
            status = "excepted";
            counts = true;
            clause_ref = "GENCON94-7(b)";
            reasoning = "Sunday/holiday counts under SHINC.";
          } else if (cpTerms.days_basis === "SHEX" || cpTerms.days_basis === "WWDSHEX-EIU") {
            status = "excepted";
            counts = false;
            clause_ref = "GENCON94-7(c)";
            reasoning = "Sunday/holiday excepted under SHEX.";
          } else if (cpTerms.days_basis === "SHEX-UU") {
            const hatchOpen = hatchOpenAt(events, hourStart, windowEnd);
            const opsOngoing = operationsOngoingAt(events, hourStart, windowEnd);
            if (hatchOpen && opsOngoing) {
              status = "excepted";
              counts = true;
              clause_ref = "GENCON94-7(d)";
              reasoning = "SHEX-UU: Sunday counts when hatch open and operations ongoing.";
            } else {
              status = "excepted";
              counts = false;
              clause_ref = "GENCON94-7(c)";
              reasoning = "SHEX-UU: Sunday excepted without operations.";
            }
          }
        } else {
          // 4. Shifting
          const shiftingActive = isEventActiveAt(events, "SHIFTING", hourStart, windowEnd);
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
            // 5. Default
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

  // Coalesce contiguous blocks with same status / counts / clause_ref / reasoning.
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

  // Step 4: totals
  const time_on_demurrage_hours = Math.max(0, usedHours - allowedHours);
  const time_saved_hours = Math.max(0, allowedHours - usedHours);
  const demurrage_amount = (time_on_demurrage_hours / 24) * cpTerms.demurrage_rate;
  const despatch_amount = (time_saved_hours / 24) * cpTerms.despatch_rate;

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
