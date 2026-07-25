/// <reference types="bun-types" />
// Run with: bun test src/lib/export.test.ts

import { describe, it, expect } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { generatePDF, type ExportClaim, type ExportEvent } from "./export";
import { DEFAULT_CP_TERMS, type LaytimeResult } from "@/lib/laytime/types";

const claim: ExportClaim = {
  id: "c1",
  vessel: "MV Test Runner",
  voyageRef: "VR-1",
  port: "Rotterdam",
  cargo: "Iron ore",
  cpForm: "GENCON94",
  status: "demurrage",
  company: { name: "Acme Chartering" },
};

function event(i: number): ExportEvent {
  return {
    id: `e${i}`,
    occurredAt: new Date(Date.UTC(2026, 0, 1, i % 24)).toISOString(),
    eventType: "NOR_TENDERED",
    page: 1,
    confidence: 0.9,
    rawText: `Notice of readiness tendered — line item ${i} with enough text to occupy a row.`,
    source: "ai",
    status: "accepted",
    aiReasoning: `Reasoning for event ${i}: this line exists to consume vertical space so the pack overflows one page.`,
  };
}

const totals: LaytimeResult["totals"] = {
  allowed_hours: 72,
  used_hours: 120,
  time_on_demurrage_hours: 48,
  time_saved_hours: 0,
  demurrage_amount: 50000,
  despatch_amount: 0,
  currency: "EUR",
};

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe("generatePDF pagination", () => {
  it("a short pack fits on a single page", async () => {
    const bytes = await generatePDF(claim, DEFAULT_CP_TERMS, [event(0)], [], totals, []);
    expect(await pageCount(bytes)).toBe(1);
  });

  it("a long event list spills onto multiple pages instead of being truncated", async () => {
    const many = Array.from({ length: 160 }, (_, i) => event(i));
    const bytes = await generatePDF(claim, DEFAULT_CP_TERMS, many, [], totals, []);
    // 160 events × ~4 lines each far exceeds one page; the old single-page
    // renderer silently dropped everything below the fold.
    expect(await pageCount(bytes)).toBeGreaterThan(1);
  });
});

describe("generatePDF character safety", () => {
  it("does not throw on non-ASCII names or the euro sign, and still emits a page", async () => {
    const intl: ExportClaim = {
      ...claim,
      vessel: "MV Ólafur — Ærø ☃",
      port: "Gdańsk",
      company: { name: "Ñoño Shipping €" },
    };
    const bytes = await generatePDF(intl, DEFAULT_CP_TERMS, [event(0)], [], totals, []);
    expect(await pageCount(bytes)).toBeGreaterThanOrEqual(1);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
