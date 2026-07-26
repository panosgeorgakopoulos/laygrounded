import { describe, expect, test } from "bun:test";
import {
  parseCalendarCsv,
  parseCalendarJson,
  parseCalendarFile,
  splitCsvLine,
} from "./calendar-import";

describe("splitCsvLine", () => {
  test("splits on comma, semicolon and tab", () => {
    expect(splitCsvLine("a,b")).toEqual(["a", "b"]);
    expect(splitCsvLine("a;b")).toEqual(["a", "b"]);
    expect(splitCsvLine("a\tb")).toEqual(["a", "b"]);
  });

  test("a quoted field may contain the delimiter", () => {
    expect(splitCsvLine('2026-01-01,"New Year, observed",holiday')).toEqual([
      "2026-01-01",
      "New Year, observed",
      "holiday",
    ]);
  });

  test("doubled quotes are an escaped quote", () => {
    expect(splitCsvLine('2026-01-01,"He said ""no""",holiday')[1]).toBe('He said "no"');
  });
});

describe("CSV parsing", () => {
  test("parses date, label and kind", () => {
    const r = parseCalendarCsv("2026-01-01,New Year's Day,holiday\n2026-01-26,Australia Day");
    expect(r.errors).toEqual([]);
    expect(r.days).toEqual([
      { date: "2026-01-01", label: "New Year's Day", kind: "holiday" },
      { date: "2026-01-26", label: "Australia Day", kind: "holiday" },
    ]);
  });

  test("a header row is skipped", () => {
    const r = parseCalendarCsv("date,label,kind\n2026-01-01,New Year,holiday");
    expect(r.errors).toEqual([]);
    expect(r.days).toHaveLength(1);
  });

  test("a file with no header still parses", () => {
    expect(parseCalendarCsv("2026-01-01").days).toHaveLength(1);
  });

  test("Excel's BOM does not corrupt the first date", () => {
    const r = parseCalendarCsv("﻿2026-01-01,New Year");
    expect(r.errors).toEqual([]);
    expect(r.days[0].date).toBe("2026-01-01");
  });

  test("CRLF line endings, blank lines and comments are tolerated", () => {
    const r = parseCalendarCsv("# port holidays\r\n2026-01-01,A\r\n\r\n2026-01-02,B\r\n");
    expect(r.errors).toEqual([]);
    expect(r.days).toHaveLength(2);
  });

  test("non_working is recognised in several spellings", () => {
    const r = parseCalendarCsv(
      "2026-01-01,x,non_working\n2026-01-02,y,non-working\n2026-01-03,z,NonWorking",
    );
    expect(r.days.every((d) => d.kind === "non_working")).toBe(true);
  });

  test("an unknown kind falls back to holiday rather than failing the row", () => {
    expect(parseCalendarCsv("2026-01-01,x,banana").days[0].kind).toBe("holiday");
  });

  test("bad rows are reported by line number and dropped, not guessed at", () => {
    const r = parseCalendarCsv("2026-01-01,ok\nnot-a-date,bad\n2026-01-03,ok2");
    expect(r.days).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(2);
    expect(r.errors[0].value).toBe("not-a-date");
  });

  test("a date-shaped value that is not a real day is rejected", () => {
    // A Date constructor would roll 30 February into March and silently move the
    // holiday to the wrong day.
    const r = parseCalendarCsv("2026-02-30,Fake");
    expect(r.days).toEqual([]);
    expect(r.errors[0].reason).toContain("Not a real calendar date");
  });

  test("29 February is accepted in a leap year and rejected otherwise", () => {
    expect(parseCalendarCsv("2028-02-29,Leap").days).toHaveLength(1);
    expect(parseCalendarCsv("2026-02-29,Not a leap year").days).toEqual([]);
  });

  test("a repeated date collapses to one, and the count is reported", () => {
    const r = parseCalendarCsv("2026-01-01,First\n2026-01-01,Second");
    expect(r.days).toHaveLength(1);
    expect(r.days[0].label).toBe("Second");
    expect(r.duplicatesCollapsed).toBe(1);
  });

  test("an empty file yields nothing and no error", () => {
    expect(parseCalendarCsv("")).toEqual({ days: [], errors: [], duplicatesCollapsed: 0 });
  });
});

describe("JSON parsing", () => {
  test("an array of date strings", () => {
    const r = parseCalendarJson('["2026-01-01","2026-01-02"]');
    expect(r.errors).toEqual([]);
    expect(r.days.map((d) => d.date)).toEqual(["2026-01-01", "2026-01-02"]);
  });

  test("an array of objects", () => {
    const r = parseCalendarJson('[{"date":"2026-01-01","label":"NY","kind":"non_working"}]');
    expect(r.days[0]).toEqual({ date: "2026-01-01", label: "NY", kind: "non_working" });
  });

  test("an object wrapping a days array", () => {
    expect(parseCalendarJson('{"days":["2026-01-01"]}').days).toHaveLength(1);
  });

  test("malformed JSON reports rather than throws", () => {
    const r = parseCalendarJson("{not json");
    expect(r.days).toEqual([]);
    expect(r.errors[0].reason).toContain("not valid JSON");
  });

  test("bad entries are reported by index and dropped", () => {
    const r = parseCalendarJson('["2026-01-01","nope",{"date":"2026-13-01"}]');
    expect(r.days).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
  });

  test("an empty array explains what was expected", () => {
    expect(parseCalendarJson("[]").errors[0].reason).toContain("Expected an array");
  });
});

describe("dispatch by file name", () => {
  test("extension decides", () => {
    expect(parseCalendarFile("holidays.json", '["2026-01-01"]').days).toHaveLength(1);
    expect(parseCalendarFile("holidays.csv", "2026-01-01,NY").days).toHaveLength(1);
  });

  test("an unknown extension sniffs the content", () => {
    expect(parseCalendarFile("holidays.txt", '["2026-01-01"]').days).toHaveLength(1);
    expect(parseCalendarFile("holidays.txt", "2026-01-01,NY").days).toHaveLength(1);
  });
});
