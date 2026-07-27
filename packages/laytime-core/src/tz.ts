// Timezone resolution without Intl, ICU, or the host's tzdata.
//
// The engine needs three things about an instant in a port's local reckoning:
// which calendar day it is, which day of the week, and (for holiday matching)
// the local date key. Everything here derives those from a pinned offset table
// plus integer civil-calendar arithmetic.
//
// The point is not speed, it is REPRODUCIBILITY. date-fns-tz resolved zones
// through Intl.DateTimeFormat, which reads whatever tzdata the runtime carries;
// Node and Bun on one machine disagreed (418 zones vs 445). A laytime figure
// must not depend on which binary computed it, or on when — IANA reissues
// historical offsets, so a 2029 re-run of a 2026 claim could silently shift a
// SHEX exclusion. Pinning the table makes the calculation a function of its
// inputs and a committed, digested artifact.
//
// The old implementation also had a subtler fault: date-fns-tz computed the
// correct zoned instant and then rebuilt it through HOST-LOCAL setFullYear /
// setHours, so the host's own zone leaked into the result. On a host in
// Pacific/Apia a Singapore date of 2011-12-30 came back as 2011-12-31, because
// Apia skipped that local day and the setter normalised forward — flipping a day
// between counting and excepted under SSHEX. Deriving the parts arithmetically
// removes that class of bug entirely: no Date setter is ever involved.

import { TZ_TRANSITIONS, TZDATA_ERA_START_SEC, TZDATA_ERA_END_SEC } from "./tzdata";

export class UnknownTimezoneError extends Error {
  constructor(timeZone: string) {
    super(`UNKNOWN_TIMEZONE: ${timeZone}`);
    this.name = "UnknownTimezoneError";
  }
}

export class TimezoneEraError extends Error {
  constructor(iso: string) {
    super(`TIMESTAMP_OUTSIDE_TZDATA_ERA: ${iso}`);
    this.name = "TimezoneEraError";
  }
}

export interface ZonedParts {
  year: number;
  /** 1-12, unlike Date's 0-11 — this is a civil month, not an array index. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: number;
  /** Minutes east of UTC in force at this instant. */
  offsetMinutes: number;
}

/**
 * UTC offset in force for `zone` at `utcMs`.
 *
 * Refuses rather than guesses: an unknown zone or an instant outside the pinned
 * era throws. Falling back to UTC would be the worst possible failure — a
 * plausible number, quietly wrong, in a legal document.
 */
export function offsetMinutesAt(utcMs: number, zone: string): number {
  const flat = TZ_TRANSITIONS[zone];
  if (!flat) throw new UnknownTimezoneError(zone);

  const sec = Math.floor(utcMs / 1000);
  if (sec < TZDATA_ERA_START_SEC || sec > TZDATA_ERA_END_SEC) {
    throw new TimezoneEraError(new Date(utcMs).toISOString());
  }

  // Binary search over flat [seconds, offset] pairs for the last transition at
  // or before `sec`.
  let lo = 0;
  let hi = flat.length / 2 - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (flat[mid * 2] <= sec) lo = mid;
    else hi = mid - 1;
  }
  return flat[lo * 2 + 1];
}

// Civil-calendar conversion (Howard Hinnant's algorithms). Integer arithmetic
// only: no Date, no host locale, no rounding.

/** Days since 1970-01-01 for a proleptic Gregorian y-m-d. */
function daysFromCivil(y: number, m: number, d: number): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil. */
function civilFromDays(z: number): { year: number; month: number; day: number } {
  const shifted = z + 719468;
  const era = Math.floor(shifted / 146097);
  const doe = shifted - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { year: m <= 2 ? y + 1 : y, month: m, day: d };
}

/**
 * The civil parts of `utcMs` as seen in `zone`.
 *
 * Replaces `toZonedTime(d, tz)` followed by host-local getters. Nothing here
 * consults the host's zone, so the result is identical on every runtime.
 */
export function zonedParts(utcMs: number, zone: string): ZonedParts {
  const offsetMinutes = offsetMinutesAt(utcMs, zone);
  const localMs = utcMs + offsetMinutes * 60_000;

  const localDays = Math.floor(localMs / 86_400_000);
  const msIntoDay = localMs - localDays * 86_400_000;

  const { year, month, day } = civilFromDays(localDays);
  // 1970-01-01 was a Thursday (4). The modulo is written to stay non-negative
  // for pre-epoch days, which the era bound makes unreachable but which a
  // silently negative weekday would make very hard to spot.
  const dayOfWeek = (((localDays + 4) % 7) + 7) % 7;

  return {
    year,
    month,
    day,
    hour: Math.floor(msIntoDay / 3_600_000),
    minute: Math.floor(msIntoDay / 60_000) % 60,
    dayOfWeek,
    offsetMinutes,
  };
}

/** Local calendar date as YYYY-MM-DD, for matching port-calendar holidays. */
export function zonedDateKey(utcMs: number, zone: string): string {
  const { year, month, day } = zonedParts(utcMs, zone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** True when the table covers this zone; lets callers check before computing. */
export function isKnownTimezone(zone: string): boolean {
  return Object.prototype.hasOwnProperty.call(TZ_TRANSITIONS, zone);
}

export { daysFromCivil, civilFromDays };
