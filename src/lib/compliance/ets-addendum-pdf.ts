// The EU-ETS addendum as a PDF a counterparty receives.
//
// Rendered from an `EtsAddendum` that the SERVER built from the claim — never
// from figures a client posted back. Same rule as the weather report, and the
// reason matters more here: this document allocates a liability between two
// named parties, so a caller able to supply its own numbers could mint an
// official-looking LayGrounded demand for any amount against anyone.
//
// The allocation language is the addendum's, not this renderer's. Nothing here
// decides who owes the money; it only lays out what `ets-addendum.ts` decided,
// so the legal reasoning lives in one tested place rather than in a layout file.

import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import { loadPdfFonts, type PdfFontSet } from "@/lib/export";
import type { EtsAddendum } from "@/lib/compliance/ets-addendum";

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const LINE = 14;

const BRAND = rgb(0.05, 0.15, 0.35);
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.45, 0.5);
const WARN = rgb(0.62, 0.36, 0.02);
const WARN_BG = rgb(0.99, 0.96, 0.88);

export interface EtsAddendumPdfInput {
  addendum: EtsAddendum;
  claim: {
    vessel: string;
    voyageRef: string | null;
    port: string;
    cargo: string | null;
    charterer: string | null;
    owner: string | null;
  };
  requestedBy: string;
}

/** Minimal page cursor: text, key/value rows, rules, page breaks. */
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
    const indent = opts.indent ?? 0;
    const maxWidth = PAGE.width - MARGIN * 2 - indent;

    // Wrap by MEASURED width, not character count — a long charterer name would
    // otherwise run off the page edge and be silently lost.
    const words = this.fonts.sanitize(s).split(/\s+/);
    let line = "";
    const flush = () => {
      if (!line) return;
      this.ensure(LINE);
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y,
        size,
        font,
        color: opts.color ?? INK,
      });
      this.y -= LINE;
      line = "";
    };
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) flush();
      else line = candidate;
      if (!line) line = w;
    }
    flush();
  }

  kv(key: string, value: string, emphasis = false) {
    this.ensure(LINE);
    const font = emphasis ? this.fonts.bold : this.fonts.regular;
    const size = emphasis ? 11 : 10;
    this.page.drawText(this.fonts.sanitize(key), {
      x: MARGIN,
      y: this.y,
      size,
      font: this.fonts.regular,
      color: MUTED,
    });
    this.page.drawText(this.fonts.sanitize(value), {
      x: MARGIN + 210,
      y: this.y,
      size,
      font,
      color: emphasis ? BRAND : INK,
    });
    this.y -= LINE;
  }

  rule() {
    this.ensure(LINE);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y + 6 },
      end: { x: PAGE.width - MARGIN, y: this.y + 6 },
      thickness: 0.5,
      color: rgb(0.85, 0.87, 0.9),
    });
    this.y -= LINE * 0.5;
  }

  gap(mult = 1) {
    this.y -= LINE * mult;
  }

  /** A boxed warning — the visual signal that the CP offers no recovery route. */
  warningBox(lines: string[]) {
    const height = LINE * (lines.length + 1.2);
    this.ensure(height + LINE);
    this.page.drawRectangle({
      x: MARGIN - 8,
      y: this.y - height + LINE * 0.6,
      width: PAGE.width - MARGIN * 2 + 16,
      height,
      color: WARN_BG,
      borderColor: WARN,
      borderWidth: 1,
    });
    this.y -= LINE * 0.2;
    for (const l of lines) this.text(l, { size: 9.5, color: WARN, font: this.fonts.bold });
    this.y -= LINE * 0.4;
  }
}

export async function renderEtsAddendumPdf(input: EtsAddendumPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts = await loadPdfFonts(pdf);
  const cur = new Cursor(pdf, fonts);
  const a = input.addendum;

  // --- Header ---
  cur.page.drawText(fonts.sanitize("LAYGROUNDED"), {
    x: MARGIN,
    y: cur.y,
    size: 15,
    font: fonts.bold,
    color: BRAND,
  });
  cur.y -= LINE * 1.3;
  cur.text("EU-ETS CARBON LIABILITY ADDENDUM", { size: 9, color: MUTED, font: fonts.bold });
  cur.rule();
  cur.gap(0.3);

  // --- Subject ---
  cur.kv("Vessel", input.claim.vessel);
  if (input.claim.voyageRef) cur.kv("Voyage", input.claim.voyageRef);
  cur.kv("Port", input.claim.port);
  if (input.claim.cargo) cur.kv("Cargo", input.claim.cargo);
  cur.kv("Owner / shipping company", input.claim.owner?.trim() || "Not recorded");
  cur.kv("Charterer", input.claim.charterer?.trim() || "Not recorded");
  cur.kv("Issued", a.issuedAt.slice(0, 19).replace("T", " ") + "Z");
  cur.kv("Requested by", input.requestedBy);
  cur.gap(0.5);
  cur.rule();
  cur.gap(0.3);

  // --- The headline ---
  cur.text(a.title, { size: 14, font: fonts.bold, color: BRAND });
  cur.gap(0.2);
  cur.text(`Amount: EUR ${a.amountEur.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, {
    size: 13,
    font: fonts.bold,
  });
  cur.text(`Borne by: ${a.bearer}`, { size: 11, color: MUTED });
  cur.gap(0.5);

  // Not decision-grade is stated BEFORE the figures, not after: a reader who
  // stops at the amount must already have seen it.
  if (!a.decisionGrade) {
    cur.warningBox([
      "NOT DECISION-GRADE. One or more inputs to this figure is synthetic or",
      "uncertain. See the basis and notes below before relying on this document.",
    ]);
    cur.gap(0.3);
  }

  if (a.warning) {
    cur.warningBox(wrapForBox(a.warning));
    cur.gap(0.3);
  }

  // --- Allocation basis ---
  cur.text("Allocation basis", { size: 10, font: fonts.bold });
  cur.gap(0.15);
  cur.text(a.basis, { size: 9.5, color: INK });
  cur.gap(0.6);
  cur.rule();
  cur.gap(0.3);

  // --- Calculation ---
  cur.text("Calculation", { size: 10, font: fonts.bold });
  cur.gap(0.25);
  for (const line of a.lines) cur.kv(line.label, line.value, line.emphasis === true);
  cur.gap(0.5);
  cur.rule();
  cur.gap(0.3);

  // --- Notes ---
  cur.text("Basis and limitations", { size: 10, font: fonts.bold });
  cur.gap(0.25);
  for (const note of a.footnotes) {
    cur.text(`- ${note}`, { size: 8.5, color: MUTED, indent: 4 });
    cur.gap(0.1);
  }

  cur.gap(0.6);
  cur.rule();
  cur.text(
    "This addendum states an allowance cost arising from a recorded demurrage period and the contractual " +
      "basis on which it falls. It is not legal advice, and it does not itself create a liability.",
    { size: 8, color: MUTED }
  );

  return pdf.save();
}

/** Splits a warning into short lines the box can size itself around. */
function wrapForBox(s: string, perLine = 92): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > perLine) {
      out.push(line.trim());
      line = w;
    } else {
      line = `${line} ${w}`;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
