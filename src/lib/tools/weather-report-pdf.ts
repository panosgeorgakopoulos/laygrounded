// The downloadable weather dispute report.
//
// This is the artefact a broker forwards to a counterparty, so it has to carry
// its own provenance: which archive, which thresholds, which hours, and the
// fact that anyone re-running the same query gets the same answer. A PDF that
// asserts "3 hours lost" without saying how is worth nothing in an argument,
// which is the whole failure mode this product exists to fix.
//
// Shares `loadPdfFonts` with the claim pack rather than growing a second font
// story — international port names must not collapse to "?" here either.

import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import { loadPdfFonts, type PdfFontSet } from "@/lib/export";
import type { ExceptedBlock, WwdResolution } from "@/lib/weather/wwd-resolver";

const BRAND = rgb(0.12, 0.25, 0.69);
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.85, 0.85, 0.85);
const WARN = rgb(0.57, 0.25, 0.05);

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait
const MARGIN = 52;
const LINE = 14;

export interface WeatherReportInput {
  port: { query: string; resolved: string; lat: number; lon: number };
  window: { from: string; to: string };
  thresholds: {
    precipMmPerHr: number | null;
    windKn: number | null;
    gustKn: number | null;
    minStoppageMinutes: number;
  };
  resolution: WwdResolution;
  requestedBy: string;
  generatedAt: Date;
}

/** Minimal page cursor: text, key/value rows, rules, and page breaks. */
class Cursor {
  page: PDFPage;
  y: number;

  constructor(
    private pdf: PDFDocument,
    private fonts: PdfFontSet
  ) {
    this.page = pdf.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  private ensure(space: number) {
    if (this.y - space > MARGIN) return;
    this.page = this.pdf.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  text(
    s: string,
    opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number } = {}
  ) {
    const size = opts.size ?? 10;
    const font = opts.font ?? this.fonts.regular;
    const maxWidth = PAGE.width - MARGIN * 2 - (opts.indent ?? 0);

    // Wrap by measured width rather than character count, so a long port name
    // never runs off the page.
    const words = this.fonts.sanitize(s).split(/\s+/);
    let line = "";
    const flush = () => {
      if (!line) return;
      this.ensure(LINE);
      this.page.drawText(line, {
        x: MARGIN + (opts.indent ?? 0),
        y: this.y,
        size,
        font,
        color: opts.color ?? INK,
      });
      this.y -= LINE;
      line = "";
    };
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > maxWidth) flush();
      line = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(line, size) > maxWidth) flush();
    }
    flush();
  }

  kv(key: string, value: string) {
    this.ensure(LINE);
    this.page.drawText(this.fonts.sanitize(key), {
      x: MARGIN,
      y: this.y,
      size: 9,
      font: this.fonts.bold,
      color: MUTED,
    });
    this.page.drawText(this.fonts.sanitize(value), {
      x: MARGIN + 120,
      y: this.y,
      size: 10,
      font: this.fonts.regular,
      color: INK,
    });
    this.y -= LINE;
  }

  rule() {
    this.ensure(LINE);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y + 4 },
      end: { x: PAGE.width - MARGIN, y: this.y + 4 },
      thickness: 0.6,
      color: RULE,
    });
    this.y -= LINE * 0.5;
  }

  gap(n = 1) {
    this.y -= LINE * n;
  }
}

const fmt = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ") + "Z";

function thresholdSentence(t: WeatherReportInput["thresholds"]): string {
  const parts: string[] = [];
  parts.push(
    t.precipMmPerHr !== null
      ? `precipitation at or above ${t.precipMmPerHr} mm/h`
      : "insensitive to precipitation"
  );
  if (t.windKn !== null) parts.push(`sustained wind at or above ${t.windKn} kn`);
  if (t.gustKn !== null) parts.push(`gusts at or above ${t.gustKn} kn`);
  return `${parts.join(", ")}; interruptions shorter than ${t.minStoppageMinutes} minutes are not counted.`;
}

export async function renderWeatherReportPdf(
  input: WeatherReportInput
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts = await loadPdfFonts(pdf);
  const cur = new Cursor(pdf, fonts);
  const r = input.resolution;

  // --- Header ---
  cur.page.drawText(fonts.sanitize("LAYGROUNDED"), {
    x: MARGIN,
    y: cur.y,
    size: 15,
    font: fonts.bold,
    color: BRAND,
  });
  cur.y -= LINE * 1.3;
  cur.text("WEATHER WORKING DAY REPORT", { size: 9, color: MUTED, font: fonts.bold });
  cur.rule();
  cur.gap(0.3);

  // --- What was asked ---
  cur.kv("Port", `${input.port.resolved} (${input.port.lat.toFixed(4)}, ${input.port.lon.toFixed(4)})`);
  cur.kv("Queried as", input.port.query);
  cur.kv("Window", `${fmt(input.window.from)} to ${fmt(input.window.to)}`);
  cur.kv("Cargo profile", r.profile.label);
  cur.kv("Requested by", input.requestedBy);
  cur.kv("Generated", input.generatedAt.toISOString().slice(0, 19).replace("T", " ") + "Z");
  cur.gap(0.5);
  cur.rule();
  cur.gap(0.3);

  // --- The answer ---
  cur.text(`${r.totalExceptedHours} hours of work stopped by weather`, {
    size: 16,
    font: fonts.bold,
    color: BRAND,
  });
  cur.gap(0.2);
  cur.text(
    `Across ${r.blocks.length} separate stoppage${r.blocks.length === 1 ? "" : "s"}, from ${r.observedHours} hours of hourly observations.`,
    { size: 10, color: MUTED }
  );
  cur.gap(0.6);

  // --- Thresholds applied ---
  cur.text("Thresholds applied", { size: 11, font: fonts.bold });
  cur.gap(0.2);
  cur.text(`${r.profile.label}: ${thresholdSentence(input.thresholds)}`, { size: 9.5 });
  cur.text(r.profile.sourceLabel, { size: 8.5, color: MUTED });
  cur.gap(0.6);

  // --- Stoppages ---
  cur.text("Stoppages", { size: 11, font: fonts.bold });
  cur.gap(0.2);
  if (r.blocks.length === 0) {
    cur.text(
      "No stoppage on record. Every observed hour in this window was workable for this cargo under the thresholds above.",
      { size: 9.5 }
    );
  } else {
    r.blocks.forEach((b: ExceptedBlock, i: number) => {
      cur.text(`${i + 1}.  ${fmt(b.from)} to ${fmt(b.to)}  —  ${b.hours} h`, {
        size: 10,
        font: fonts.bold,
      });
      cur.text(b.reason, { size: 9, color: MUTED, indent: 14 });
      cur.gap(0.25);
    });
  }
  cur.gap(0.5);

  // --- Limits ---
  // Printed rather than omitted: a report that hides its gaps is the thing a
  // counterparty's lawyer opens with.
  if (r.gapHours > 0 || r.warnings.length > 0) {
    cur.rule();
    cur.gap(0.3);
    cur.text("Limits of this report", { size: 11, font: fonts.bold, color: WARN });
    cur.gap(0.2);
    if (r.gapHours > 0) {
      cur.text(
        `${r.gapHours} hours of the window have no observation. Those hours are excluded in both directions — a missing reading is unknown, not fair weather.`,
        { size: 9, color: WARN }
      );
    }
    for (const w of r.warnings) cur.text(w, { size: 9, color: WARN });
    cur.gap(0.5);
  }

  // --- Method ---
  cur.rule();
  cur.gap(0.3);
  cur.text("Method", { size: 11, font: fonts.bold });
  cur.gap(0.2);
  cur.text(
    "Hourly precipitation and wind are taken from the ERA5 reanalysis archive via Open-Meteo for the coordinates above, then compared hour by hour against the cargo thresholds stated. Consecutive stopped hours are merged into one stoppage; runs shorter than the stated minimum are discarded.",
    { size: 9, color: MUTED }
  );
  cur.gap(0.3);
  cur.text(
    "This calculation is deterministic. The same port, window and cargo profile produce the same result on every run, by anyone — there is no model, no sampling and no judgement in it. That is what makes it usable in a dispute.",
    { size: 9, color: MUTED }
  );
  cur.gap(0.3);
  cur.text(
    "Prepared with the free LayGrounded weather checker. Thresholds are published baselines and are overridable; a charterparty may define weather working days differently, and this report does not interpret the contract.",
    { size: 8.5, color: MUTED }
  );

  return pdf.save();
}
