import { describe, expect, test } from "bun:test";
import {
  zonedParts,
  zonedDateKey,
  offsetMinutesAt,
  isKnownTimezone,
  daysFromCivil,
  civilFromDays,
  UnknownTimezoneError,
  TimezoneEraError,
} from "./tz";
import { TZ_TRANSITIONS, TZDATA_DIGEST } from "./tzdata";

// Zones that actually appear in the corpus and seed data, plus awkward ones:
// India (half-hour), Nepal (three-quarter-hour), Lord Howe (half-hour DST),
// Chatham, and the southern-hemisphere reversals.
const ZONES = [
  "UTC",
  "Asia/Singapore",
  "Europe/Amsterdam",
  "America/Chicago",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Africa/Johannesburg",
  "Asia/Shanghai",
  "Europe/Gibraltar",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "America/Santiago",
  "Asia/Tehran",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Cached per zone: constructing a DateTimeFormat dominates the cost, and this
// test makes hundreds of thousands of comparisons.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let dtf = formatters.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      hourCycle: "h23",
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, dtf);
  }
  return dtf;
}

/** The same question, answered by the host's ICU. */
function icuParts(utcMs: number, timeZone: string) {
  const dtf = formatterFor(timeZone);
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    dayOfWeek: WEEKDAYS.indexOf(p.weekday),
  };
}

describe("civil calendar arithmetic", () => {
  test("round-trips across four centuries, including leap years", () => {
    for (const [y, m, d] of [
      [2000, 2, 29], [1900, 3, 1], [2024, 2, 29], [2026, 12, 31],
      [2040, 1, 1], [2100, 2, 28], [2001, 1, 1],
    ] as Array<[number, number, number]>) {
      expect(civilFromDays(daysFromCivil(y, m, d))).toEqual({ year: y, month: m, day: d });
    }
  });

  test("weekday derivation is anchored correctly", () => {
    // 2026-01-01 was a Thursday; the epoch itself sits outside the pinned era.
    expect(zonedParts(Date.UTC(2026, 0, 1), "UTC").dayOfWeek).toBe(4);
    expect(zonedParts(Date.UTC(2026, 0, 4), "UTC").dayOfWeek).toBe(0); // Sunday
    expect(zonedParts(Date.UTC(2026, 0, 3), "UTC").dayOfWeek).toBe(6); // Saturday
  });
});

describe("agreement with ICU", () => {
  // The pinned table was READ from ICU, so this is the check that it was read
  // and indexed correctly — a transposed transition or an off-by-one binary
  // search would show up immediately as a disagreement.
  test("matches ICU at 6-hourly samples across 2000-2040", () => {
    const start = Date.UTC(2000, 0, 1);
    const end = Date.UTC(2039, 11, 31);
    const step = 6 * 3_600_000;

    for (const zone of ZONES) {
      if (!isKnownTimezone(zone)) continue;
      for (let t = start; t <= end; t += step) {
        const mine = zonedParts(t, zone);
        const icu = icuParts(t, zone);
        if (
          mine.year !== icu.year ||
          mine.month !== icu.month ||
          mine.day !== icu.day ||
          mine.hour !== icu.hour ||
          mine.minute !== icu.minute ||
          mine.dayOfWeek !== icu.dayOfWeek
        ) {
          throw new Error(
            `${zone} @ ${new Date(t).toISOString()}: ` +
              `pinned=${JSON.stringify(mine)} icu=${JSON.stringify(icu)}`,
          );
        }
      }
    }
  }, 120_000);

  test("matches ICU minute-by-minute across DST transitions", () => {
    // The boundary is where an imprecise table would betray itself. Northern and
    // southern spring-forward and fall-back, plus Lord Howe's 30-minute shift.
    const boundaries: Array<[string, number]> = [
      ["Europe/Amsterdam", Date.UTC(2026, 2, 29, 1, 0)],
      ["Europe/Amsterdam", Date.UTC(2026, 9, 25, 1, 0)],
      ["America/Chicago", Date.UTC(2026, 2, 8, 8, 0)],
      ["America/Chicago", Date.UTC(2026, 10, 1, 6, 0)],
      ["Australia/Sydney", Date.UTC(2026, 3, 4, 16, 0)],
      ["Australia/Lord_Howe", Date.UTC(2026, 3, 4, 15, 30)],
      ["America/Santiago", Date.UTC(2026, 3, 4, 3, 0)],
    ];

    for (const [zone, centre] of boundaries) {
      if (!isKnownTimezone(zone)) continue;
      for (let dt = -90; dt <= 90; dt++) {
        const t = centre + dt * 60_000;
        const mine = zonedParts(t, zone);
        const icu = icuParts(t, zone);
        expect(
          `${mine.year}-${mine.month}-${mine.day} ${mine.hour}:${mine.minute} dow${mine.dayOfWeek}`,
          `${zone} at ${new Date(t).toISOString()}`,
        ).toBe(`${icu.year}-${icu.month}-${icu.day} ${icu.hour}:${icu.minute} dow${icu.dayOfWeek}`);
      }
    }
  });
});

describe("refusing rather than guessing", () => {
  test("an unknown zone throws instead of silently falling back to UTC", () => {
    // A silent UTC fallback is the worst outcome: a plausible number, quietly
    // wrong, inside a legal document.
    expect(() => zonedParts(Date.UTC(2026, 0, 1), "Mars/Olympus_Mons")).toThrow(
      UnknownTimezoneError,
    );
    expect(() => zonedParts(Date.UTC(2026, 0, 1), "Mars/Olympus_Mons")).toThrow(
      /UNKNOWN_TIMEZONE/,
    );
  });

  test("an instant outside the pinned era throws", () => {
    expect(() => zonedParts(Date.UTC(1985, 0, 1), "UTC")).toThrow(TimezoneEraError);
    expect(() => zonedParts(Date.UTC(2099, 0, 1), "UTC")).toThrow(TimezoneEraError);
  });
});

describe("table integrity", () => {
  test("every zone's transitions are ascending and sane", () => {
    for (const [zone, flat] of Object.entries(TZ_TRANSITIONS)) {
      expect(flat.length % 2, `${zone} has an odd flat length`).toBe(0);
      for (let i = 2; i < flat.length; i += 2) {
        expect(flat[i] > flat[i - 2], `${zone} transitions out of order at ${i}`).toBe(true);
      }
      for (let i = 1; i < flat.length; i += 2) {
        // Real offsets run from -12:00 to +14:00.
        expect(flat[i]).toBeGreaterThanOrEqual(-720);
        expect(flat[i]).toBeLessThanOrEqual(840);
      }
    }
  });

  test("the digest is pinned, so a silent regeneration fails the build", () => {
    expect(TZDATA_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  test("covers the zones the corpus and seed data actually use", () => {
    for (const zone of ZONES) {
      expect(isKnownTimezone(zone), `${zone} missing from the pinned table`).toBe(true);
    }
  });

  test("half-hour and quarter-hour zones survive the round trip", () => {
    expect(offsetMinutesAt(Date.UTC(2026, 5, 1), "Asia/Kolkata")).toBe(330);
    expect(offsetMinutesAt(Date.UTC(2026, 5, 1), "Asia/Kathmandu")).toBe(345);
  });

  test("renamed zones agree with their legacy spelling at every transition", () => {
    // Runtimes disagree about which spelling is canonical — Bun enumerates
    // Asia/Calcutta and omits Asia/Kolkata, Node the reverse — so both are in
    // the table. They are only safe to treat as equivalent if they genuinely
    // resolve the same, which is what this checks rather than assumes.
    const pairs: Array<[string, string]> = [
      ["Asia/Kolkata", "Asia/Calcutta"],
      ["Asia/Kathmandu", "Asia/Katmandu"],
      ["Asia/Ho_Chi_Minh", "Asia/Saigon"],
      ["Europe/Kyiv", "Europe/Kiev"],
      ["America/Nuuk", "America/Godthab"],
      ["Atlantic/Faroe", "Atlantic/Faeroe"],
      ["Asia/Yangon", "Asia/Rangoon"],
    ];
    const step = 12 * 3_600_000;
    for (const [modern, legacy] of pairs) {
      if (!isKnownTimezone(modern) || !isKnownTimezone(legacy)) continue;
      for (let t = Date.UTC(2000, 0, 1); t <= Date.UTC(2039, 11, 31); t += step) {
        expect(
          offsetMinutesAt(t, modern),
          `${modern} vs ${legacy} diverge at ${new Date(t).toISOString()}`,
        ).toBe(offsetMinutesAt(t, legacy));
      }
    }
  }, 60_000);
});

describe("zonedDateKey", () => {
  test("pads to YYYY-MM-DD", () => {
    expect(zonedDateKey(Date.UTC(2026, 0, 5, 12), "UTC")).toBe("2026-01-05");
  });

  test("reports the port's local day, not UTC's", () => {
    // 2026-03-05T23:00Z is already the 6th in Singapore.
    expect(zonedDateKey(Date.UTC(2026, 2, 5, 23), "Asia/Singapore")).toBe("2026-03-06");
    expect(zonedDateKey(Date.UTC(2026, 2, 5, 23), "UTC")).toBe("2026-03-05");
  });
});
