// Demand-letter PDF renderer.
//
// Turns a grounded draft into formal correspondence: letterhead, reference
// block, the letter body, the calculation it rests on, and the dispute
// timeline as an appendix. Two rules shape everything here:
//
//   * Only DB facts are rendered as facts. The body is the (grounded) model
//     text; every figure in the reference block, the calculation table and
//     the timeline is read straight off DraftContext, so those sections
//     cannot drift from the claim record regardless of what the model wrote.
//   * It paginates. The claim-pack exporter draws onto a single page and
//     lets overflow run off the bottom; a letter is prose and will exceed one
//     page, so text that doesn't fit must start a new page, not vanish.
//
// The renderer does not decide whether a draft may be rendered — the route
// enforces grounding before calling in. It only labels what it draws.

import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import { loadPdfFonts, type PdfFontSet } from "@/lib/export";
import type { DraftContext } from "./context";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const BODY_SIZE = 10.5;
const LINE = 15;
const BRAND = rgb(0.96, 0.62, 0.04);
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.85, 0.85, 0.85);

export interface DemandLetterInput {
  subject: string;
  // The grounded draft body (markdown-ish, as the drafter emits it).
  contentMd: string;
  kind: string;
  ctx: DraftContext;
  companyName: string;
  // Stamped in the footer so a printed copy can be traced back to the row.
  draftId: string;
  generatedAt: Date;
  groundingSummary: { amountsChecked: number; clausesChecked: number };
}

function fmtMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

// A cursor that owns pagination: every write goes through it, and running out
// of vertical space starts a page instead of drawing into the void.
class Cursor {
  page: PDFPage;
  y: number;
  pages: PDFPage[] = [];

  constructor(
    private pdf: PDFDocument,
    private fonts: PdfFontSet
  ) {
    this.page = this.newPage();
    this.y = A4[1] - MARGIN;
  }

  private newPage(): PDFPage {
    const p = this.pdf.addPage(A4);
    this.pages.push(p);
    return p;
  }

  private ensure(space: number): void {
    if (this.y - space >= MARGIN + 28) return; // 28pt reserved for the footer
    this.page = this.newPage();
    this.y = A4[1] - MARGIN;
  }

  gap(n = 1): void {
    this.y -= n * LINE;
  }

  rule(): void {
    this.ensure(LINE);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: A4[0] - MARGIN, y: this.y },
      thickness: 0.5,
      color: RULE,
    });
    this.y -= LINE * 0.6;
  }

  // Word-wraps within the text column, breaking pages as needed. Returns the
  // number of lines drawn.
  text(
    raw: string,
    opts: {
      font?: PDFFont;
      size?: number;
      color?: ReturnType<typeof rgb>;
      indent?: number;
      lineHeight?: number;
    } = {}
  ): number {
    const f = opts.font ?? this.fonts.regular;
    const size = opts.size ?? BODY_SIZE;
    const color = opts.color ?? INK;
    const indent = opts.indent ?? 0;
    const lh = opts.lineHeight ?? LINE;
    const maxWidth = A4[0] - MARGIN * 2 - indent;
    const safe = this.fonts.sanitize(raw);

    // An empty string is a deliberate blank line, not a no-op.
    if (safe.trim() === "") {
      this.ensure(lh);
      this.y -= lh;
      return 1;
    }

    let line = "";
    let drawn = 0;
    const flush = () => {
      if (!line) return;
      this.ensure(lh);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y, size, font: f, color });
      this.y -= lh;
      drawn++;
      line = "";
    };

    for (const word of safe.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(test, size) > maxWidth && line) {
        flush();
        line = word;
      } else {
        line = test;
      }
    }
    flush();
    return drawn;
  }

  // Two-column key/value row used by the reference and calculation blocks.
  kv(label: string, value: string): void {
    this.ensure(LINE);
    const y = this.y;
    this.page.drawText(this.fonts.sanitize(label), {
      x: MARGIN,
      y,
      size: 9,
      font: this.fonts.regular,
      color: MUTED,
    });
    this.page.drawText(this.fonts.sanitize(value), {
      x: MARGIN + 150,
      y,
      size: 9.5,
      font: this.fonts.bold,
      color: INK,
    });
    this.y -= LINE;
  }
}

// The drafter emits markdown-ish prose. Rather than pull in a markdown
// engine for a letter, strip the few constructs it actually uses and render
// them as typography: headings bold, list items bulleted and indented,
// inline **bold**/*italic* markers removed (pdf-lib has no rich runs, so the
// marker characters would otherwise print literally).
function renderBody(cur: Cursor, fonts: PdfFontSet, md: string): void {
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim() === "") {
      cur.gap(0.5);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      cur.gap(0.35);
      cur.text(stripInline(heading[2]), { font: fonts.bold, size: 11.5 });
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      cur.rule();
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      cur.text(`• ${stripInline(bullet[1])}`, { indent: 12 });
      continue;
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      cur.text(`${numbered[1]}. ${stripInline(numbered[2])}`, { indent: 12 });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      cur.text(stripInline(quote[1]), { indent: 16, color: MUTED });
      continue;
    }

    cur.text(stripInline(line));
  }
}

// Remove inline markdown markers whose glyphs would otherwise print.
function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)");
}

export async function renderDemandLetterPdf(input: DemandLetterInput): Promise<Uint8Array> {
  const { ctx } = input;
  const pdf = await PDFDocument.create();
  const fonts = await loadPdfFonts(pdf);
  const cur = new Cursor(pdf, fonts);

  // --- Letterhead ---
  cur.page.drawText(fonts.sanitize(input.companyName || "LAYGROUNDED"), {
    x: MARGIN,
    y: cur.y,
    size: 15,
    font: fonts.bold,
    color: BRAND,
  });
  cur.y -= LINE * 1.3;
  cur.text(
    `${input.kind.replace(/_/g, " ").toUpperCase()} — issued ${input.generatedAt
      .toISOString()
      .slice(0, 10)}`,
    { size: 9, color: MUTED }
  );
  cur.rule();
  cur.gap(0.4);

  // --- Reference block (DB facts only) ---
  cur.kv("Vessel", ctx.claim.vessel + (ctx.claim.vesselImo ? ` (IMO ${ctx.claim.vesselImo})` : ""));
  cur.kv("Voyage", ctx.claim.voyageRef);
  cur.kv("Port", ctx.claim.port);
  cur.kv("Cargo", ctx.claim.cargo);
  cur.kv("Charterparty", ctx.claim.cpForm);
  if (ctx.claim.counterpartyName) cur.kv("To", ctx.claim.counterpartyName);
  cur.gap(0.5);

  // --- Subject ---
  cur.text(`Subject: ${input.subject}`, { font: fonts.bold, size: 11 });
  cur.gap(0.4);
  cur.rule();
  cur.gap(0.3);

  // --- Body (the grounded model text) ---
  renderBody(cur, fonts, input.contentMd);

  // --- Calculation the claim rests on ---
  if (ctx.totals) {
    cur.gap(0.8);
    cur.rule();
    cur.text("Laytime calculation", { font: fonts.bold, size: 11.5 });
    cur.gap(0.3);
    cur.kv("Laytime allowed", `${ctx.totals.allowedHours.toFixed(2)} h`);
    cur.kv("Laytime used", `${ctx.totals.usedHours.toFixed(2)} h`);
    if (ctx.cpTerms) {
      cur.kv("Demurrage rate", fmtMoney(ctx.cpTerms.demurrage_rate, ctx.totals.currency) + " / day");
      cur.kv("Days basis", ctx.cpTerms.days_basis);
      cur.kv("NOR variant", ctx.cpTerms.nor_variant);
    }
    cur.kv("Demurrage due", fmtMoney(ctx.totals.demurrageAmount, ctx.totals.currency));
    if (ctx.totals.despatchAmount > 0) {
      cur.kv("Despatch payable", fmtMoney(ctx.totals.despatchAmount, ctx.totals.currency));
    }
    cur.gap(0.4);
    cur.text(
      "Computed by a deterministic rules engine from the confirmed Statement of Facts events listed below. Figures in this section are read from the claim record, not authored.",
      { size: 8.5, color: MUTED, lineHeight: 11 }
    );
  }

  // --- Dispute timeline ---
  if (ctx.events.length > 0) {
    cur.gap(0.8);
    cur.rule();
    cur.text("Statement of Facts — confirmed timeline", { font: fonts.bold, size: 11.5 });
    cur.gap(0.3);
    for (const e of ctx.events) {
      cur.text(`${fmtDateTime(e.occurredAt)}   ${e.eventType.replace(/_/g, " ")}`, {
        size: 9,
        indent: 4,
        lineHeight: 12,
      });
    }
  }

  // Independent evidence — verdicts are the honest part of the pack: an
  // inconclusive check is printed as inconclusive.
  if (ctx.evidence.length > 0) {
    cur.gap(0.8);
    cur.rule();
    cur.text("Independent evidence", { font: fonts.bold, size: 11.5 });
    cur.gap(0.3);
    for (const v of ctx.evidence) {
      cur.text(`[${v.verdict.toUpperCase()}] ${v.checkType}: ${v.summary}`, {
        size: 9,
        indent: 4,
        lineHeight: 12,
      });
    }
  }

  // Contested points already raised by the counterparty.
  const pending = ctx.proposals.filter((p) => p.status === "pending");
  if (pending.length > 0) {
    cur.gap(0.8);
    cur.rule();
    cur.text("Amendments proposed by the counterparty", { font: fonts.bold, size: 11.5 });
    cur.gap(0.3);
    for (const p of pending) {
      const what = p.proposedOccurredAt
        ? `${p.proposedEventType ?? "event"} → ${fmtDateTime(p.proposedOccurredAt)}`
        : (p.proposedEventType ?? p.action);
      cur.text(`${p.proposedByLabel}: ${p.action} ${what} — ${p.note}`, {
        size: 9,
        indent: 4,
        lineHeight: 12,
      });
    }
  }

  // --- Footers: page numbers + provenance on every page ---
  const total = cur.pages.length;
  cur.pages.forEach((p, i) => {
    p.drawText(
      fonts.sanitize(
        `${input.groundingSummary.amountsChecked} figure(s) and ${input.groundingSummary.clausesChecked} clause citation(s) in this letter were verified against the claim record. Draft ${input.draftId.slice(0, 8)}.`
      ),
      { x: MARGIN, y: MARGIN - 16, size: 7, font: fonts.regular, color: MUTED }
    );
    p.drawText(fonts.sanitize(`${i + 1} / ${total}`), {
      x: A4[0] - MARGIN - 26,
      y: MARGIN - 16,
      size: 7,
      font: fonts.regular,
      color: MUTED,
    });
  });

  return pdf.save();
}
