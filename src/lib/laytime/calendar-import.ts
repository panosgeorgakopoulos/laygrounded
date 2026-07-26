// Parsing a customer-supplied port calendar out of CSV or JSON.
//
// Operators keep these as spreadsheets — a year of port holidays exported from
// whatever their agent sent — so the parser has to survive real files: BOMs,
// CRLF, quoted fields, a header row or none, trailing blank lines, and the
// occasional comment.
//
// It reports every bad row rather than throwing on the first one. A 200-line
// calendar with two typos should tell the operator which two lines to fix, not
// fail opaquely; and a row that cannot be parsed is DROPPED rather than guessed
// at, because a misread date silently changes whether laytime counts.
//
// Pure — no I/O. The route persists whatever this returns.

export type CalendarDayKind = "holiday" | "non_working";

export interface ParsedCalendarDay {
  date: string; // YYYY-MM-DD
  label?: string;
  kind: CalendarDayKind;
}

export interface CalendarParseError {
  /** 1-based line number in the source file, for a message the operator can act on. */
  line: number;
  value: string;
  reason: string;
}

export interface CalendarParseResult {
  days: ParsedCalendarDay[];
  errors: CalendarParseError[];
  /** Same date listed more than once; the last wins and the rest are counted. */
  duplicatesCollapsed: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only for dates that exist. `2026-02-30` matches the shape but is not a
 * day, and a Date constructor happily rolls it over to 02 March — which would
 * silently move a holiday.
 */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

function normalizeKind(raw: string | undefined): CalendarDayKind {
  const v = (raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return v === "non_working" || v === "nonworking" ? "non_working" : "holiday";
}

/** Splits one CSV line, honouring double-quoted fields with escaped quotes. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === "," || ch === ";" || ch === "\t") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function collapse(rows: ParsedCalendarDay[]): { days: ParsedCalendarDay[]; collapsed: number } {
  const byDate = new Map<string, ParsedCalendarDay>();
  for (const r of rows) byDate.set(r.date, r);
  return { days: [...byDate.values()], collapsed: rows.length - byDate.size };
}

/**
 * Parses a CSV calendar.
 *
 * Expected shape is `date,label,kind` with label and kind optional. A header row
 * is detected and skipped by looking for a date in the first column — safer than
 * matching header names, which vary by whoever exported the file.
 */
export function parseCalendarCsv(text: string): CalendarParseResult {
  // Strip a UTF-8 BOM: Excel writes one, and it would otherwise corrupt the
  // first date into something that fails the shape test with a baffling message.
  const cleaned = text.replace(/^﻿/, "");
  const lines = cleaned.split(/\r\n|\n|\r/);

  const rows: ParsedCalendarDay[] = [];
  const errors: CalendarParseError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const fields = splitCsvLine(raw);
    const dateField = fields[0] ?? "";

    if (!ISO_DATE.test(dateField)) {
      // A first row whose first field is not a date is taken as the header.
      if (rows.length === 0 && errors.length === 0 && /date/i.test(dateField)) continue;
      errors.push({
        line: i + 1,
        value: dateField,
        reason: "Expected a date in YYYY-MM-DD format in the first column.",
      });
      continue;
    }

    if (!isRealDate(dateField)) {
      errors.push({ line: i + 1, value: dateField, reason: "Not a real calendar date." });
      continue;
    }

    const label = (fields[1] ?? "").trim();
    rows.push({
      date: dateField,
      label: label === "" ? undefined : label.slice(0, 200),
      kind: normalizeKind(fields[2]),
    });
  }

  const { days, collapsed } = collapse(rows);
  return { days, errors, duplicatesCollapsed: collapsed };
}

/**
 * Parses a JSON calendar: either an array of date strings, or of
 * `{ date, label?, kind? }` objects, or an object with a `days` array.
 */
export function parseCalendarJson(text: string): CalendarParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      days: [],
      errors: [{ line: 1, value: "", reason: "File is not valid JSON." }],
      duplicatesCollapsed: 0,
    };
  }

  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.days)
      ? ((parsed as Record<string, unknown>).days as unknown[])
      : [];

  if (list.length === 0) {
    return {
      days: [],
      errors: [
        {
          line: 1,
          value: "",
          reason: "Expected an array of dates, or an object with a `days` array.",
        },
      ],
      duplicatesCollapsed: 0,
    };
  }

  const rows: ParsedCalendarDay[] = [];
  const errors: CalendarParseError[] = [];

  list.forEach((entry, index) => {
    const line = index + 1;
    if (typeof entry === "string") {
      if (!isRealDate(entry)) {
        errors.push({ line, value: entry, reason: "Not a real date in YYYY-MM-DD format." });
        return;
      }
      rows.push({ date: entry, kind: "holiday" });
      return;
    }

    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const date = typeof obj.date === "string" ? obj.date : "";
      if (!isRealDate(date)) {
        errors.push({ line, value: date, reason: "Not a real date in YYYY-MM-DD format." });
        return;
      }
      const label = typeof obj.label === "string" ? obj.label.trim() : "";
      rows.push({
        date,
        label: label === "" ? undefined : label.slice(0, 200),
        kind: normalizeKind(typeof obj.kind === "string" ? obj.kind : undefined),
      });
      return;
    }

    errors.push({ line, value: String(entry), reason: "Expected a date string or an object." });
  });

  const { days, collapsed } = collapse(rows);
  return { days, errors, duplicatesCollapsed: collapsed };
}

/** Dispatches on the file name, falling back to sniffing the content. */
export function parseCalendarFile(fileName: string, text: string): CalendarParseResult {
  if (/\.json$/i.test(fileName)) return parseCalendarJson(text);
  if (/\.csv$/i.test(fileName) || /\.tsv$/i.test(fileName)) return parseCalendarCsv(text);
  return text.trimStart().startsWith("[") || text.trimStart().startsWith("{")
    ? parseCalendarJson(text)
    : parseCalendarCsv(text);
}
