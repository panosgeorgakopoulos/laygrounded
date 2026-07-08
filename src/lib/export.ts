import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "xlsx";
import { LaytimeResult, CpTerms } from "@/lib/laytime/types";
import { createServiceRoleClient } from "@/lib/supabase/server";

function sanitizeForPdf(s: string): string {
  return s
    .replace(/→/g, "->")
    .replace(/↓/g, "v")
    .replace(/–/g, "-")
    .replace(/—/g, "--")
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/"/g, '"')
    .replace(/"/g, '"')
    .replace(/…/g, "...")
    .replace(/•/g, "*")
    .replace(/©/g, "(c)")
    .replace(/®/g, "(R)")
    .replace(/™/g, "(TM)");
}

interface ExportPayload {
  claimId: string;
  companyId: string;
}

export async function exportClaimPack(payload: ExportPayload) {
  const supabase = createServiceRoleClient();

  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select(`
      *,
      companies (*),
      documents (*),
      sof_events (*),
      calculations (*)
    `)
    .eq("id", payload.claimId)
    .single();

  if (claimErr || !claim || claim.company_id !== payload.companyId) {
    throw new Error("CLAIM_NOT_FOUND");
  }

  const sofEvents = (claim.sof_events || []).sort((a: any, b: any) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  const calculations = (claim.calculations || []).sort((a: any, b: any) => new Date(b.computed_at).getTime() - new Date(a.computed_at).getTime());
  const company = claim.companies;
  const latestCalc = calculations[0];

  const cpTerms: CpTerms | null = claim.cp_terms as any;
  const breakdown: LaytimeResult["breakdown"] = latestCalc?.breakdown as any || [];
  const totals: LaytimeResult["totals"] | null = latestCalc
    ? {
        allowed_hours: latestCalc.allowed_hours,
        used_hours: latestCalc.used_hours,
        time_on_demurrage_hours: Math.max(0, latestCalc.used_hours - latestCalc.allowed_hours),
        time_saved_hours: Math.max(0, latestCalc.allowed_hours - latestCalc.used_hours),
        demurrage_amount: latestCalc.demurrage_amount ?? 0,
        despatch_amount: latestCalc.despatch_amount ?? 0,
        currency: latestCalc.currency,
      }
    : null;

  const eventIds = sofEvents.map((e: any) => e.id);
  
  let clauseFlags: any[] = [];
  if (eventIds.length > 0) {
    const { data: flags } = await supabase
      .from("clause_flags")
      .select("*")
      .in("event_id", eventIds);
    clauseFlags = flags || [];
  }

  const claimObj = {
    id: claim.id,
    vessel: claim.vessel,
    voyageRef: claim.voyage_ref,
    port: claim.port,
    cargo: claim.cargo,
    cpForm: claim.cp_form,
    status: claim.status,
    company: { name: company?.name || "" }
  };
  
  const eventsObj = sofEvents.map((e: any) => ({
    id: e.id,
    occurredAt: e.occurred_at,
    eventType: e.event_type,
    page: e.page,
    confidence: e.confidence,
    rawText: e.raw_text,
    source: e.source,
    status: e.status,
    aiReasoning: e.ai_reasoning
  }));
  
  const flagsObj = clauseFlags.map((f: any) => ({
    eventId: f.event_id,
    severity: f.severity,
    clauseRef: f.clause_ref,
    note: f.note
  }));

  const pdfBytes = await generatePDF(
    claimObj,
    cpTerms,
    eventsObj,
    breakdown,
    totals,
    flagsObj
  );

  const xlsxBytes = await generateXLSX(
    claimObj,
    cpTerms,
    eventsObj,
    breakdown,
    totals,
    flagsObj
  );

  const pdfName = `exports/${claim.id}/claim-${claim.id}-${Date.now()}.pdf`;
  const xlsxName = `exports/${claim.id}/claim-${claim.id}-${Date.now()}.xlsx`;

  await supabase.storage.from("sofs").upload(pdfName, pdfBytes, { contentType: "application/pdf" });
  await supabase.storage.from("sofs").upload(xlsxName, xlsxBytes, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

  const { data: pdfUrlData } = await supabase.storage.from("sofs").createSignedUrl(pdfName, 3600);
  const { data: xlsxUrlData } = await supabase.storage.from("sofs").createSignedUrl(xlsxName, 3600);

  return {
    pdfUrl: pdfUrlData?.signedUrl,
    xlsxUrl: xlsxUrlData?.signedUrl,
    pdfPath: pdfName,
    xlsxPath: xlsxName,
  };
}

async function generatePDF(
  claim: any,
  cpTerms: CpTerms | null,
  events: any[],
  breakdown: LaytimeResult["breakdown"],
  totals: LaytimeResult["totals"] | null,
  clauseFlags: any[]
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  const page = pdf.addPage([595.28, 841.89]); 
  const { width, height } = page.getSize();
  const margin = 40;
  let y = height - margin;

  const lineHeight = 14;
  const gap = (n = 1) => {
    y -= n * lineHeight;
  };
  const writeLine = (
    text: string,
    opts: { font?: any; size?: number; color?: any; indent?: number } = {}
  ) => {
    const f = opts.font ?? font;
    const sz = opts.size ?? 10;
    const col = opts.color ?? rgb(0.1, 0.1, 0.1);
    const indent = opts.indent ?? 0;
    const safeText = sanitizeForPdf(text);
    const maxWidth = width - margin * 2 - indent;
    const words = safeText.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(test, sz) > maxWidth) {
        page.drawText(line, { x: margin + indent, y, size: sz, font: f, color: col });
        y -= lineHeight;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) {
      page.drawText(line, { x: margin + indent, y, size: sz, font: f, color: col });
      y -= lineHeight;
    }
  };

  page.drawText("LAYGROUNDED", {
    x: margin,
    y,
    size: 18,
    font: bold,
    color: rgb(0.96, 0.62, 0.04),
  });
  y -= 24;
  page.drawText("Laytime & Demurrage Claim Pack", {
    x: margin,
    y,
    size: 12,
    font: font,
    color: rgb(0.4, 0.4, 0.4),
  });
  gap(2);

  writeLine(`Vessel: ${claim.vessel}`, { font: bold, size: 11 });
  writeLine(`Voyage Ref: ${claim.voyageRef}`);
  writeLine(`Port: ${claim.port}`);
  writeLine(`Cargo: ${claim.cargo}`);
  writeLine(`CP Form: ${claim.cpForm}`);
  writeLine(`Status: ${claim.status}`);
  writeLine(`Company: ${claim.company.name}`);
  gap();

  if (cpTerms) {
    writeLine("Charterparty Terms Summary", { font: bold, size: 12 });
    writeLine(`- Laytime allowed: ${cpTerms.laytime_allowed_hours} hours`, { indent: 10 });
    writeLine(`- Turn time: ${cpTerms.turn_time_hours} hours`, { indent: 10 });
    writeLine(`- NOR variant: ${cpTerms.nor_variant}`, { indent: 10 });
    writeLine(`- Days basis: ${cpTerms.days_basis}`, { indent: 10 });
    writeLine(`- Demurrage rate: ${cpTerms.currency} ${cpTerms.demurrage_rate}/day`, { indent: 10 });
    writeLine(`- Despatch rate: ${cpTerms.currency} ${cpTerms.despatch_rate}/day`, { indent: 10 });
    gap();
  }

  writeLine("Statement of Facts — Event Timeline", { font: bold, size: 12 });
  for (const ev of events) {
    const ts = new Date(ev.occurredAt).toISOString();
    writeLine(`[${ts}] ${ev.eventType} (page ${ev.page}, conf ${(ev.confidence * 100).toFixed(0)}%)`, {
      font: mono,
      size: 9,
    });
    writeLine(`  Verbatim: ${ev.rawText}`, { size: 9, indent: 10 });
    writeLine(`  Source: ${ev.source} | Status: ${ev.status}`, {
      size: 9,
      indent: 10,
      color: rgb(0.4, 0.4, 0.4),
    });
    if (ev.aiReasoning) writeLine(`  AI reasoning: ${ev.aiReasoning}`, { size: 9, indent: 10, color: rgb(0.4, 0.4, 0.4) });
  }
  gap();

  if (breakdown.length > 0) {
    writeLine("Hour-Resolution Breakdown (with clause citations)", { font: bold, size: 12 });
    for (const row of breakdown) {
      writeLine(
        `[${row.start_time} → ${row.end_time}] ${row.duration_hours}h | ${row.status} | counts=${row.counts} | ${row.clause_ref}`,
        { font: mono, size: 9 }
      );
      writeLine(`  Reasoning: ${row.reasoning}`, { size: 9, indent: 10, color: rgb(0.4, 0.4, 0.4) });
    }
    gap();
  }

  if (totals) {
    writeLine("Totals", { font: bold, size: 12 });
    writeLine(`- Allowed: ${totals.allowed_hours.toFixed(2)} hours`, { indent: 10 });
    writeLine(`- Used: ${totals.used_hours.toFixed(2)} hours`, { indent: 10 });
    writeLine(`- Time on demurrage: ${totals.time_on_demurrage_hours.toFixed(2)} hours`, { indent: 10 });
    writeLine(`- Time saved: ${totals.time_saved_hours.toFixed(2)} hours`, { indent: 10 });
    writeLine(
      `- Demurrage: ${totals.currency} ${totals.demurrage_amount.toFixed(2)}`,
      { indent: 10, font: bold }
    );
    writeLine(
      `- Despatch: ${totals.currency} ${totals.despatch_amount.toFixed(2)}`,
      { indent: 10, font: bold }
    );
    gap();
  }

  if (clauseFlags.length > 0) {
    writeLine("Clause Flags", { font: bold, size: 12 });
    for (const f of clauseFlags) {
      const ev = events.find((e: any) => e.id === f.eventId);
      writeLine(`[${f.severity.toUpperCase()}] ${f.clauseRef}`, {
        font: mono,
        size: 9,
        color:
          f.severity === "critical"
            ? rgb(0.94, 0.27, 0.27)
            : f.severity === "warning"
              ? rgb(0.57, 0.41, 0.1)
              : rgb(0.4, 0.4, 0.4),
      });
      writeLine(`  Event: ${ev?.eventType ?? "—"} @ ${ev ? new Date(ev.occurredAt).toISOString() : "—"}`, {
        size: 9,
        indent: 10,
      });
      writeLine(`  Note: ${f.note}`, { size: 9, indent: 10 });
    }
  }

  page.drawText(`Generated by LayGrounded — ${new Date().toISOString()}`, {
    x: margin,
    y: 30,
    size: 8,
    font: font,
    color: rgb(0.5, 0.5, 0.5),
  });

  const bytes = await pdf.save();
  return bytes;
}

async function generateXLSX(
  claim: any,
  cpTerms: CpTerms | null,
  events: any[],
  breakdown: LaytimeResult["breakdown"],
  totals: LaytimeResult["totals"] | null,
  clauseFlags: any[]
): Promise<Buffer> {
  const wb = XLSX.utils.book_new();

  const headerAoa: any[][] = [
    ["LAYGROUNDED — CLAIM PACK"],
    [""],
    ["Field", "Value"],
    ["Vessel", claim.vessel],
    ["Voyage Ref", claim.voyageRef],
    ["Port", claim.port],
    ["Cargo", claim.cargo],
    ["CP Form", claim.cpForm],
    ["Status", claim.status],
    ["Company", claim.company.name],
    ["Generated", new Date().toISOString()],
    [""],
    ["Charterparty Terms"],
    ["Laytime allowed (hrs)", cpTerms?.laytime_allowed_hours ?? ""],
    ["Turn time (hrs)", cpTerms?.turn_time_hours ?? ""],
    ["NOR variant", cpTerms?.nor_variant ?? ""],
    ["Days basis", cpTerms?.days_basis ?? ""],
    ["Demurrage rate (per day)", cpTerms?.demurrage_rate ?? ""],
    ["Despatch rate (per day)", cpTerms?.despatch_rate ?? ""],
    ["Currency", cpTerms?.currency ?? ""],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(headerAoa);
  XLSX.utils.book_append_sheet(wb, ws1, "Claim");

  const eventAoa: any[][] = [
    [
      "Timestamp",
      "Event Type",
      "Page",
      "Verbatim Text",
      "Confidence",
      "Source",
      "Status",
      "AI Reasoning",
      "Citation",
    ],
    ...events.map((e) => [
      new Date(e.occurredAt).toISOString(),
      e.eventType,
      e.page,
      e.rawText,
      e.confidence,
      e.source,
      e.status,
      e.aiReasoning ?? "",
      "GENCON94-6 (event source)",
    ]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(eventAoa);
  XLSX.utils.book_append_sheet(wb, ws2, "Events");

  if (breakdown.length > 0) {
    const bdAoa: any[][] = [
      ["Start", "End", "Duration (hrs)", "Status", "Counts", "Clause Ref", "Reasoning"],
      ...breakdown.map((r) => [
        r.start_time,
        r.end_time,
        r.duration_hours,
        r.status,
        r.counts ? "yes" : "no",
        r.clause_ref,
        r.reasoning,
      ]),
    ];
    const ws3 = XLSX.utils.aoa_to_sheet(bdAoa);
    XLSX.utils.book_append_sheet(wb, ws3, "Breakdown");
  }

  if (totals) {
    const totAoa: any[][] = [
      ["Totals"],
      [""],
      ["Allowed hours", totals.allowed_hours],
      ["Used hours", totals.used_hours],
      ["Time on demurrage (hrs)", totals.time_on_demurrage_hours],
      ["Time saved (hrs)", totals.time_saved_hours],
      ["Demurrage amount", totals.demurrage_amount],
      ["Despatch amount", totals.despatch_amount],
      ["Currency", totals.currency],
      ["Citation", "GENCON94-8 (demurrage) / GENCON94-7 (despatch)"],
    ];
    const ws4 = XLSX.utils.aoa_to_sheet(totAoa);
    XLSX.utils.book_append_sheet(wb, ws4, "Totals");
  }

  if (clauseFlags.length > 0) {
    const cfAoa: any[][] = [
      ["Severity", "Clause Ref", "Event Type", "Event Timestamp", "Note"],
      ...clauseFlags.map((f) => {
        const ev = events.find((e: any) => e.id === f.eventId);
        return [
          f.severity,
          f.clauseRef,
          ev?.eventType ?? "",
          ev ? new Date(ev.occurredAt).toISOString() : "",
          f.note,
        ];
      }),
    ];
    const ws5 = XLSX.utils.aoa_to_sheet(cfAoa);
    XLSX.utils.book_append_sheet(wb, ws5, "ClauseFlags");
  }

  const xlsxBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return xlsxBuffer;
}
