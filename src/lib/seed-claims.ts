import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SeedScenario } from "@/lib/seed-data";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";

// The standard PDF fonts only encode WinAnsi; strip anything outside the
// printable-ASCII range so pdf-lib can't throw on a stray character.
function asciiSafe(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

// Render a real, valid Statement-of-Facts PDF for a seed scenario so the demo
// document actually opens in the viewer (rather than being a row that points
// at a non-existent storage object).
async function buildSofPdf(scenario: SeedScenario): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageSize: [number, number] = [595.28, 841.89];
  const margin = 50;
  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;
  let currentPageNumber = 1;

  const line = (text: string, opts: { size?: number; font?: typeof font; indent?: number } = {}) => {
    const size = opts.size ?? 10;
    if (y < margin + size) {
      page = pdf.addPage(pageSize);
      y = pageSize[1] - margin;
      currentPageNumber++;
    }
    page.drawText(asciiSafe(text), {
      x: margin + (opts.indent ?? 0),
      y,
      size,
      font: opts.font ?? font,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= size + 6;
  };

  line("STATEMENT OF FACTS (DEMO)", { size: 16, font: bold });
  y -= 6;
  line(`Vessel: ${scenario.vessel}`, { size: 11, font: bold });
  line(`Voyage: ${scenario.voyageRef}`);
  line(`Port: ${scenario.port}`);
  line(`Cargo: ${scenario.cargo}`);
  y -= 10;
  line("Events", { size: 12, font: bold });

  for (const ev of scenario.events) {
    const ts = new Date(ev.occurred_at).toISOString().replace("T", " ").slice(0, 16);
    
    // Calculate bbox before drawing the first line. 
    // y is the baseline of the text. The top of the text is roughly y + size (9).
    // From the top of the page, this is pageSize[1] - (y + 9).
    // Let's add 2 points of padding, so top = pageSize[1] - y - 11.
    // If the first line would trigger a page break, we need to anticipate it.
    if (y < margin + 9) {
      page = pdf.addPage(pageSize);
      y = pageSize[1] - margin;
      currentPageNumber++;
    }
    
    const topY = pageSize[1] - y - 11;
    const startPage = currentPageNumber;

    line(`${ts}  ${ev.event_type}`, { size: 9, font: bold, indent: 6 });
    line(ev.verbatim, { size: 9, indent: 16 });

    // Total height drawn is roughly 30 points. We set height to 34 for some padding.
    ev.page = startPage;
    ev.bbox = {
      x: (margin - 4) / pageSize[0], 
      y: topY / pageSize[1],
      width: (pageSize[0] - margin * 1.5) / pageSize[0],
      height: 34 / pageSize[1],
    };
  }

  const bytes = await pdf.save();
  return { bytes, pageCount: pdf.getPageCount() };
}

// Seeds one scenario end-to-end: claim -> real uploaded SoF PDF -> document
// row -> events -> laytime calculation. Returns the claim id, or null if the
// claim itself could not be created. Throws on storage/DB failures so the
// caller surfaces them rather than leaving a half-seeded claim.
export async function seedScenario(
  supabase: SupabaseClient,
  opts: { companyId: string; userId: string; scenario: SeedScenario }
): Promise<string | null> {
  const { companyId, userId, scenario } = opts;

  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .insert({
      company_id: companyId,
      vessel: scenario.vessel,
      voyage_ref: scenario.voyageRef,
      port: scenario.port,
      cargo: scenario.cargo,
      cp_form: "GENCON94",
      cp_terms: scenario.cpTerms,
      created_by: userId,
      status: "draft",
    })
    .select("id")
    .maybeSingle();

  if (claimErr) throw new Error(`SEED_CLAIM_FAILED: ${claimErr.message}`);
  if (!claim) return null;

  // Upload a real PDF to a company-scoped path so the storage RLS policy
  // (first path segment must be the company id) and signed-URL generation
  // both succeed later.
  const { bytes, pageCount } = await buildSofPdf(scenario);
  const storagePath = `${companyId}/${claim.id}/statement-of-facts.pdf`;
  const { error: uploadErr } = await supabase.storage
    .from("sofs")
    .upload(storagePath, bytes, { contentType: "application/pdf", upsert: true });
  if (uploadErr) throw new Error(`SEED_UPLOAD_FAILED: ${uploadErr.message}`);

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({
      claim_id: claim.id,
      storage_path: storagePath,
      mime: "application/pdf",
      original_filename: "Statement of Facts (Demo).pdf",
      extraction_status: "extracted",
      page_count: pageCount,
    })
    .select("id")
    .maybeSingle();

  if (docErr) throw new Error(`SEED_DOCUMENT_FAILED: ${docErr.message}`);
  if (!doc) throw new Error("SEED_DOCUMENT_FAILED: no document row returned");

  const { error: eventsErr } = await supabase.from("sof_events").insert(
    scenario.events.map((ev) => ({
      claim_id: claim.id,
      document_id: doc.id,
      occurred_at: new Date(ev.occurred_at).toISOString(),
      event_type: ev.event_type,
      raw_text: ev.verbatim,
      page: ev.page,
      bbox: ev.bbox,
      confidence: ev.confidence,
      source: "ai",
      status: "accepted",
      ai_reasoning: ev.reasoning,
    }))
  );
  if (eventsErr) throw new Error(`SEED_EVENTS_FAILED: ${eventsErr.message}`);

  // Pass the caller's client through — the seeder may be running with the
  // service-role client (init-demo) where the default RLS client would fail.
  await recomputeLaytimeServerFn(claim.id, supabase);

  return claim.id;
}
