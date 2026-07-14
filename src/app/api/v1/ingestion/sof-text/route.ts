import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { geocodePort } from "@/lib/evidence/weather";
import {
  auditTimelineAgainstAis,
  extractSofTimeline,
  type AisFix,
  type TimelineAuditResult,
  type ExtractedSofEvent,
} from "@/lib/ingestion/multimodal";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";

const AisFixSchema = z.object({
  at: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const SofTextSchema = z.object({
  // Omit to create a fresh claim from the ingested text.
  claimId: z.string().uuid().optional(),
  // Parsed multimodal text: a PDF text layer, an OCR pass, an email body.
  text: z.string().min(20).max(50_000),
  vessel: z.string().min(1).max(120).optional(),
  port: z.string().min(1).max(120).optional(),
  cargo: z.string().min(1).max(200).optional(),
  voyageRef: z.string().min(1).max(120).optional(),
  counterpartyName: z.string().min(1).max(200).optional(),
  // The port's UTC offset (e.g. "+03:00") for SoFs with naive local
  // timestamps. Without it, naive lines are reported, never guessed.
  defaultUtcOffset: z.string().regex(/^(?:Z|[+-]\d{2}:?\d{2})$/).optional(),
  // Optional AIS track: when supplied, every extracted position-bound event
  // is geofenced BEFORE it lands on the claim.
  aisHistory: z.array(AisFixSchema).min(1).max(5000).optional(),
});

// Autopilot SoF ingestion: deterministic text-to-timeline extraction with
// optional AIS geofencing at the door. Events land as status 'suggested' —
// zero-touch data entry, not zero-touch trust: a human still confirms them
// in the workspace (or the geofence flags tell them exactly what not to
// confirm).
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();

    const parsed = SofTextSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const input = parsed.data;

    const extraction = extractSofTimeline(input.text, {
      defaultUtcOffset: input.defaultUtcOffset,
    });
    if (extraction.events.length === 0) {
      return NextResponse.json(
        { error: "SOF_UNPARSEABLE", warnings: extraction.warnings },
        { status: 422 }
      );
    }
    const warnings = [...extraction.warnings];

    const supabase = await createClient();

    // Resolve or create the claim.
    let claimId: string;
    let created = false;
    let port: string;
    let portLat: number | null = null;
    let portLon: number | null = null;
    if (input.claimId) {
      const { data: claim } = await supabase
        .from("claims")
        .select("id, company_id, port, port_lat, port_lon")
        .eq("id", input.claimId)
        .maybeSingle();
      if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");
      claimId = claim.id;
      port = claim.port;
      portLat = claim.port_lat;
      portLon = claim.port_lon;
    } else {
      const { data: claim, error: claimErr } = await supabase
        .from("claims")
        .insert({
          company_id: auth.companyId,
          vessel: input.vessel ?? "TBN",
          voyage_ref: input.voyageRef ?? `SOF-${Date.now()}`,
          port: input.port ?? "TBC",
          cargo: input.cargo ?? "TBC",
          cp_form: "GENCON94",
          cp_terms: DEFAULT_CP_TERMS,
          counterparty_name: input.counterpartyName ?? null,
          status: "draft",
          created_by: auth.userId,
        })
        .select("id, port")
        .single();
      if (claimErr || !claim) throw new Error(`PERSIST_FAILED: ${claimErr?.message}`);
      claimId = claim.id;
      port = claim.port;
      created = true;
    }

    // Geofence at the door when an AIS track came with the SoF.
    let audit: TimelineAuditResult<ExtractedSofEvent> | null = null;
    if (input.aisHistory) {
      if (portLat == null || portLon == null) {
        const loc = port && port !== "TBC" ? await geocodePort(port) : null;
        if (loc) {
          portLat = loc.lat;
          portLon = loc.lon;
          await supabase
            .from("claims")
            .update({ port_lat: portLat, port_lon: portLon })
            .eq("id", claimId);
        }
      }
      if (portLat != null && portLon != null) {
        audit = auditTimelineAgainstAis(
          extraction.events,
          input.aisHistory as AisFix[],
          { lat: portLat, lon: portLon }
        );
      } else {
        warnings.push(
          `Port "${port}" could not be geocoded — AIS geofencing skipped; set the claim's port and re-run the geofence audit.`
        );
      }
    }
    const verdictByLine = new Map<number, boolean | null>();
    for (const { event, check } of audit?.checks ?? []) {
      verdictByLine.set(event.line, check.verdict === "unverifiable" ? null : check.verdict === "verified");
    }

    // Stub document, reused across repeated ingests into the same claim.
    let { data: doc } = await supabase
      .from("documents")
      .select("id")
      .eq("claim_id", claimId)
      .eq("mime", "multimodal")
      .limit(1)
      .maybeSingle();
    if (!doc) {
      const { data: createdDoc, error: docErr } = await supabase
        .from("documents")
        .insert({
          claim_id: claimId,
          storage_path: `multimodal/${claimId}`,
          mime: "multimodal",
          original_filename: "Multimodal SoF text ingest",
          extraction_status: "extracted",
        })
        .select("id")
        .single();
      if (docErr || !createdDoc) throw new Error(`PERSIST_FAILED: ${docErr?.message}`);
      doc = createdDoc;
    }

    const { data: inserted, error: eventsErr } = await supabase
      .from("sof_events")
      .insert(
        extraction.events.map((e) => ({
          claim_id: claimId,
          document_id: doc!.id,
          occurred_at: e.occurred_at,
          event_type: e.event_type,
          raw_text: e.raw_text,
          page: 1,
          bbox: { x: 0, y: 0, width: 0, height: 0 },
          confidence: 0.9,
          source: "multimodal",
          status: "suggested",
          ais_geofence_verified: verdictByLine.get(e.line) ?? null,
        }))
      )
      .select("id, raw_text");
    if (eventsErr || !inserted) throw new Error(`PERSIST_FAILED: ${eventsErr?.message}`);

    // Critical flags on the discrepancies, so the review queue leads with
    // them. Inserted rows come back in insert order → map flags via line.
    if (audit && audit.flags.length) {
      const idByLine = new Map<number, string>();
      extraction.events.forEach((e, i) => idByLine.set(e.line, inserted[i]?.id));
      const { error: flagErr } = await supabase.from("clause_flags").insert(
        audit.flags
          .filter((f) => idByLine.get(f.event.line))
          .map((f) => ({
            event_id: idByLine.get(f.event.line)!,
            clause_ref: f.clause_ref,
            severity: f.severity,
            note: f.note,
          }))
      );
      if (flagErr) throw new Error(`PERSIST_FAILED: ${flagErr.message}`);
    }

    return NextResponse.json(
      {
        claimId,
        created,
        eventsInserted: inserted.length,
        warnings,
        geofence: audit
          ? {
              verified: audit.verified,
              discrepancies: audit.discrepancies,
              unverifiable: audit.unverifiable,
              skipped: audit.skipped,
            }
          : null,
      },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "v1/ingestion/sof-text/POST");
  }
}
