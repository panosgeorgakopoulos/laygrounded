import { describe, expect, test } from "bun:test";
import { recomputeLaytime } from "./gencon94";
import type { CpTerms, PortCalendar, SofEventInput } from "./types";

// Wednesday 4 March 2026 through the following week — deliberately mid-week, so
// a holiday here can only come from the calendar and never from the engine's
// weekend rules.
const EVENTS: SofEventInput[] = [
  { id: "nor", occurred_at: "2026-03-04T06:00:00Z", event_type: "NOR_TENDERED" },
  { id: "fast", occurred_at: "2026-03-04T08:00:00Z", event_type: "ALL_FAST" },
  { id: "start", occurred_at: "2026-03-04T12:00:00Z", event_type: "COMMENCED_LOADING" },
  { id: "end", occurred_at: "2026-03-09T12:00:00Z", event_type: "COMPLETED_LOADING" },
];

function terms(over: Partial<CpTerms> = {}): CpTerms {
  return {
    cp_form: "GENCON94",
    laytime_allowed_hours: 48,
    turn_time_hours: 6,
    nor_variant: "WIBON",
    days_basis: "SHEX",
    demurrage_rate: 24_000,
    despatch_rate: 12_000,
    currency: "USD",
    port_timezone: "UTC",
    ...over,
  };
}

const THURSDAY_HOLIDAY: PortCalendar = {
  holidays: ["2026-03-05"],
  source: "test fixture",
};

function used(cp: CpTerms): number {
  return recomputeLaytime(EVENTS, cp).totals.used_hours;
}

function demurrage(cp: CpTerms): number {
  return recomputeLaytime(EVENTS, cp).totals.demurrage_amount;
}

describe("no calendar supplied", () => {
  test("behaviour is unchanged — the default that keeps the corpus valid", () => {
    const withoutField = used(terms());
    const withUndefined = used(terms({ port_calendar: undefined }));
    expect(withUndefined).toBe(withoutField);
  });

  test("an empty holiday list is inert", () => {
    expect(used(terms({ port_calendar: { holidays: [], source: "empty" } }))).toBe(
      used(terms()),
    );
  });
});

describe("SHEX — an excluded holiday", () => {
  test("a midweek holiday stops the clock, so less laytime is consumed", () => {
    const withoutCalendar = used(terms());
    const withCalendar = used(terms({ port_calendar: THURSDAY_HOLIDAY }));
    expect(withCalendar).toBeLessThan(withoutCalendar);
    // A whole calendar day is excluded.
    expect(withoutCalendar - withCalendar).toBeCloseTo(24, 5);
  });

  test("less laytime consumed means less demurrage", () => {
    expect(demurrage(terms({ port_calendar: THURSDAY_HOLIDAY }))).toBeLessThan(
      demurrage(terms()),
    );
  });

  test("the excluded hours are labelled and cited, not silently dropped", () => {
    const result = recomputeLaytime(EVENTS, terms({ port_calendar: THURSDAY_HOLIDAY }));
    const holidayRows = result.breakdown.filter(
      (r) => r.start_time.startsWith("2026-03-05") && r.status === "excepted",
    );
    expect(holidayRows.length).toBeGreaterThan(0);
    expect(holidayRows.every((r) => r.counts === false)).toBe(true);
    expect(holidayRows[0].clause_ref).toBeTruthy();
  });

  test("a holiday on another date leaves the calculation alone", () => {
    const elsewhere: PortCalendar = { holidays: ["2026-07-04"], source: "test" };
    expect(used(terms({ port_calendar: elsewhere }))).toBe(used(terms()));
  });
});

describe("SHINC — an included holiday", () => {
  test("the holiday still counts, so laytime is unchanged", () => {
    const basis = { days_basis: "SHINC" as const };
    expect(used(terms({ ...basis, port_calendar: THURSDAY_HOLIDAY }))).toBe(
      used(terms(basis)),
    );
  });

  test("but it is still labelled a holiday rather than reported as ordinary time", () => {
    const result = recomputeLaytime(
      EVENTS,
      terms({ days_basis: "SHINC", port_calendar: THURSDAY_HOLIDAY }),
    );
    const rows = result.breakdown.filter(
      (r) => r.start_time.startsWith("2026-03-05") && r.status === "excepted",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.counts === true)).toBe(true);
  });
});

describe("timezone handling", () => {
  test("a holiday is a day in the PORT's reckoning, not in UTC", () => {
    // 2026-03-05T23:00Z is already 06 March in Singapore (UTC+8), so a holiday
    // declared for the 6th must catch that hour and one declared for the 5th
    // must not. Resolving holidays in UTC would get this backwards.
    const sgEvents: SofEventInput[] = [
      { id: "nor", occurred_at: "2026-03-05T00:00:00Z", event_type: "NOR_TENDERED" },
      { id: "fast", occurred_at: "2026-03-05T02:00:00Z", event_type: "ALL_FAST" },
      { id: "start", occurred_at: "2026-03-05T06:00:00Z", event_type: "COMMENCED_LOADING" },
      { id: "end", occurred_at: "2026-03-08T00:00:00Z", event_type: "COMPLETED_LOADING" },
    ];
    const sgTerms = (cal?: PortCalendar): CpTerms =>
      terms({ port_timezone: "Asia/Singapore", port_calendar: cal });

    const baseline = recomputeLaytime(sgEvents, sgTerms()).totals.used_hours;
    const onSixth = recomputeLaytime(
      sgEvents,
      sgTerms({ holidays: ["2026-03-06"], source: "t" }),
    ).totals.used_hours;

    expect(onSixth).toBeLessThan(baseline);

    // The excluded block must span local 06 March 00:00–24:00, which in UTC is
    // 05 March 16:00 → 06 March 16:00. Resolving the holiday in UTC instead
    // would shift the exclusion eight hours and clip the wrong day.
    const excluded = recomputeLaytime(
      sgEvents,
      sgTerms({ holidays: ["2026-03-06"], source: "t" }),
    ).breakdown.find(
      (r) => r.status === "excepted" && r.start_time === "2026-03-05T16:00:00.000Z",
    );
    expect(excluded).toBeDefined();
    expect(excluded!.end_time).toBe("2026-03-06T16:00:00.000Z");
    expect(excluded!.counts).toBe(false);
  });
});

describe("determinism", () => {
  test("the same calendar gives byte-identical results across runs", () => {
    const cp = terms({ port_calendar: THURSDAY_HOLIDAY });
    expect(JSON.stringify(recomputeLaytime(EVENTS, cp))).toBe(
      JSON.stringify(recomputeLaytime(EVENTS, cp)),
    );
  });
});
