// Statement of Facts PDF renderer for synthetic cases (pdf-lib).
//
// Produces a clean, realistic single-column SoF: vessel header block, an
// events table (date / time / description), and a signature footer. All times
// are printed in UTC and the header says so — the extraction pipeline's
// timezone gate must be satisfiable from the document alone.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { Scenario } from "./scenarios";

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 50;
const INK = rgb(0.08, 0.1, 0.14);
const FAINT = rgb(0.45, 0.48, 0.53);
const LINE = rgb(0.8, 0.82, 0.85);

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  bold: PDFFont;
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([A4.width, A4.height]);
  ctx.y = A4.height - MARGIN;
}

function ensureRoom(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < MARGIN + 60) newPage(ctx);
}

function text(ctx: Ctx, x: number, s: string, size = 9, bold = false, color = INK): void {
  ctx.page.drawText(s, { x, y: ctx.y, size, font: bold ? ctx.bold : ctx.font, color });
}

function hline(ctx: Ctx, yOffset = 4): void {
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y - yOffset },
    end: { x: A4.width - MARGIN, y: ctx.y - yOffset },
    thickness: 0.7,
    color: LINE,
  });
}

export async function renderSofPdf(scenario: Scenario): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { doc, page: doc.addPage([A4.width, A4.height]), y: A4.height - MARGIN, font, bold };

  // --- Title ---
  text(ctx, MARGIN, "STATEMENT OF FACTS", 16, true);
  ctx.y -= 14;
  text(ctx, MARGIN, "ALL TIMES IN UTC", 8, false, FAINT);
  ctx.y -= 20;
  hline(ctx, 0);
  ctx.y -= 16;

  // --- Header block ---
  const events = scenario.events;
  const first = events[0]?.occurred_at;
  const last = events[events.length - 1]?.occurred_at;
  const headerRows: Array<[string, string]> = [
    ["VESSEL", `MV ${scenario.claim.vessel}`],
    ["VOYAGE", scenario.claim.voyageRef],
    ["PORT", scenario.claim.port],
    ["CARGO", scenario.claim.cargo],
    ["CP FORM", (scenario.cpTerms.cp_form ?? "GENCON94") === "ASBATANKVOY" ? "ASBATANKVOY" : "GENCON 94"],
    ["PERIOD", first && last ? `${fmtDate(first)} — ${fmtDate(last)}` : "—"],
  ];
  for (const [label, value] of headerRows) {
    text(ctx, MARGIN, label, 8, false, FAINT);
    text(ctx, MARGIN + 90, value, 10, true);
    ctx.y -= 15;
  }
  ctx.y -= 6;
  hline(ctx, 0);
  ctx.y -= 18;

  // --- Events table ---
  const COL_DATE = MARGIN;
  const COL_TIME = MARGIN + 90;
  const COL_DESC = MARGIN + 145;

  const drawTableHeader = () => {
    text(ctx, COL_DATE, "DATE", 8, true, FAINT);
    text(ctx, COL_TIME, "TIME", 8, true, FAINT);
    text(ctx, COL_DESC, "EVENT / REMARKS", 8, true, FAINT);
    ctx.y -= 6;
    hline(ctx, 0);
    ctx.y -= 14;
  };
  drawTableHeader();

  let lastDate = "";
  for (const e of events) {
    ensureRoom(ctx, 40);
    if (ctx.y === A4.height - MARGIN) {
      // Fresh page: repeat the table header for readability.
      drawTableHeader();
      lastDate = "";
    }
    const date = fmtDate(e.occurred_at);
    text(ctx, COL_DATE, date === lastDate ? "" : date, 9);
    lastDate = date;
    text(ctx, COL_TIME, fmtTime(e.occurred_at), 9);
    text(ctx, COL_DESC, e.verbatim, 9);
    ctx.y -= 14;
  }

  // --- Footer ---
  ensureRoom(ctx, 90);
  ctx.y -= 20;
  hline(ctx, 0);
  ctx.y -= 24;
  text(
    ctx,
    MARGIN,
    "The above statement of facts is confirmed as a true and accurate record of events.",
    8,
    false,
    FAINT
  );
  ctx.y -= 30;
  const sigY = ctx.y;
  for (const [i, party] of ["MASTER", "AGENT", "TERMINAL"].entries()) {
    const x = MARGIN + i * 165;
    ctx.page.drawLine({
      start: { x, y: sigY },
      end: { x: x + 130, y: sigY },
      thickness: 0.7,
      color: INK,
    });
    ctx.page.drawText(party, { x, y: sigY - 12, size: 8, font, color: FAINT });
  }

  return doc.save();
}
