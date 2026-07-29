import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { renderDemandLetterPdf, type DemandLetterInput } from "./pdf";
import type { DraftContext } from "./context";

const CTX: DraftContext = {
  claim: {
    id: "c1",
    vessel: "MV IRON DUKE",
    vesselImo: "9123456",
    voyageRef: "V-2026-001",
    port: "Rotterdam",
    cargo: "Iron ore",
    counterpartyName: "Acme Chartering",
    cpForm: "GENCON94",
  },
  cpTerms: {
    laytime_allowed_hours: 72,
    turn_time_hours: 6,
    nor_variant: "WIBON",
    days_basis: "SHINC",
    demurrage_rate: 28000,
    despatch_rate: 14000,
    currency: "USD",
  } as DraftContext["cpTerms"],
  totals: {
    allowedHours: 72,
    usedHours: 122,
    demurrageAmount: 58333.33,
    despatchAmount: 0,
    currency: "USD",
  },
  breakdown: [],
  events: [
    { occurredAt: "2026-03-01T09:00:00Z", eventType: "NOR_TENDERED", rawText: "NOR tendered" },
    { occurredAt: "2026-03-05T17:00:00Z", eventType: "COMPLETED_LOADING", rawText: "Completed" },
  ],
  clauseFlags: [],
  evidence: [{ checkType: "weather", verdict: "inconclusive", summary: "Archive gap." }],
  proposals: [],
  settlement: null,
  timeBarDays: 90,
  ets: null,
  timeBar: {
    timeBarDays: 90,
    anchorEventAt: "2026-05-01T00:00:00Z",
    deadline: "2026-07-30T00:00:00Z",
    daysRemaining: 30,
    state: "ok",
    completeness: [],
    complete: true,
  },
  sofGaps: [],
};

function input(over: Partial<DemandLetterInput> = {}): DemandLetterInput {
  return {
    subject: "Demurrage claim — MV IRON DUKE",
    contentMd: "Dear Sirs,\n\nWe claim USD 58,333.33.\n\nYours faithfully",
    kind: "demand_letter",
    ctx: CTX,
    companyName: "Owner Shipping Ltd",
    draftId: "11111111-2222-3333-4444-555555555555",
    generatedAt: new Date("2026-07-14T00:00:00Z"),
    groundingSummary: { amountsChecked: 1, clausesChecked: 0 },
    ...over,
  };
}

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe("renderDemandLetterPdf", () => {
  test("produces a loadable PDF", async () => {
    const bytes = await renderDemandLetterPdf(input());
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(await pageCount(bytes)).toBeGreaterThanOrEqual(1);
  });

  // The claim-pack exporter draws onto one page and lets overflow run off the
  // bottom. A letter is prose; if this regresses, pages of argument vanish
  // silently from correspondence that has already been sent.
  test("paginates long letters instead of overflowing the page", async () => {
    const long = Array.from(
      { length: 220 },
      (_, i) => `Paragraph ${i + 1}: the vessel tendered notice of readiness and laytime commenced.`
    ).join("\n\n");
    const bytes = await renderDemandLetterPdf(input({ contentMd: long }));
    expect(await pageCount(bytes)).toBeGreaterThan(1);
  });

  test("a single unbroken run of text still paginates", async () => {
    const wall = "word ".repeat(6000);
    const bytes = await renderDemandLetterPdf(input({ contentMd: wall }));
    expect(await pageCount(bytes)).toBeGreaterThan(1);
  });

  test("renders non-ASCII vessel and port names without throwing", async () => {
    const ctx = {
      ...CTX,
      claim: { ...CTX.claim, vessel: "MV ΠΟΣΕΙΔΩΝ", port: "Gdańsk" },
    };
    const bytes = await renderDemandLetterPdf(input({ ctx, contentMd: "Καλημέρα — naïve café" }));
    expect(await pageCount(bytes)).toBeGreaterThanOrEqual(1);
  });

  test("renders with no calculation and no events", async () => {
    const bare: DraftContext = { ...CTX, totals: null, events: [], evidence: [], proposals: [] };
    const bytes = await renderDemandLetterPdf(input({ ctx: bare, kind: "letter_of_protest" }));
    expect(await pageCount(bytes)).toBe(1);
  });

  test("handles markdown constructs the drafter emits", async () => {
    const md = [
      "# Heading",
      "",
      "Some **bold** and *italic* and `code`.",
      "",
      "- bullet one",
      "- bullet two",
      "",
      "1. numbered",
      "2. numbered",
      "",
      "> quoted",
      "",
      "---",
      "",
      "[link](https://example.com)",
    ].join("\n");
    const bytes = await renderDemandLetterPdf(input({ contentMd: md }));
    expect(await pageCount(bytes)).toBeGreaterThanOrEqual(1);
  });

  test("an empty body still yields the reference block and calculation", async () => {
    const bytes = await renderDemandLetterPdf(input({ contentMd: "" }));
    expect(await pageCount(bytes)).toBe(1);
  });
});
