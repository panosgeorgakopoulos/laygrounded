// Persistence for deterministically-extracted SoF events.
//
// Extracted here so the M2M ingestion route (`/api/v1/ingestion/sof-text`) and
// the workspace panel write events the SAME way. Two copies would drift on the
// first change to the review contract, and the drift is invisible: events that
// land with the wrong `status` do not error, they just quietly bypass — or
// quietly fail to reach — the human review queue.
//
// EVENTS LAND AS `suggested`, NEVER `accepted`. `loadClaimComputationInputs`
// reads only `accepted` and `edited`, so nothing extracted from unstructured
// text can move a figure until a person has confirmed it. Zero-touch data
// entry, not zero-touch trust.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedSofEvent } from "@/lib/ingestion/multimodal";

/** The stub document every text ingest for a claim hangs off. */
export const MULTIMODAL_MIME = "multimodal";

/**
 * Finds or creates the stub `documents` row for text ingests.
 *
 * One per claim, reused across repeated ingests: a document row per paste would
 * make the workspace's document viewer show a stack of empty documents, and the
 * viewer keys off `documents[0]`.
 */
export async function ensureMultimodalDocument(
  supabase: SupabaseClient,
  claimId: string
): Promise<string> {
  const { data: existing } = await supabase
    .from("documents")
    .select("id")
    .eq("claim_id", claimId)
    .eq("mime", MULTIMODAL_MIME)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id;

  const { data: created, error } = await supabase
    .from("documents")
    .insert({
      claim_id: claimId,
      storage_path: `multimodal/${claimId}`,
      mime: MULTIMODAL_MIME,
      original_filename: "Multimodal SoF text ingest",
      extraction_status: "extracted",
    })
    .select("id")
    .single();
  if (error || !created) throw new Error(`PERSIST_FAILED: ${error?.message}`);
  return created.id;
}

/**
 * Writes extracted candidates as `suggested` events.
 *
 * `geofenceByLine` carries the AIS verdict per source line where one was run;
 * an absent entry becomes NULL, which means "not checked" and is a different
 * statement from "checked and failed".
 */
export async function persistSuggestedSofEvents(
  supabase: SupabaseClient,
  claimId: string,
  documentId: string,
  events: ExtractedSofEvent[],
  geofenceByLine: Map<number, boolean | null> = new Map()
): Promise<Array<{ id: string; raw_text: string }>> {
  const { data, error } = await supabase
    .from("sof_events")
    .insert(
      events.map((e) => ({
        claim_id: claimId,
        document_id: documentId,
        occurred_at: e.occurred_at,
        event_type: e.event_type,
        raw_text: e.raw_text,
        // The extractor works on text, not a rendered page, so there is no
        // bounding box to point at. Zeroes rather than a fabricated region:
        // the viewer highlights nothing instead of highlighting the wrong thing.
        page: 1,
        bbox: { x: 0, y: 0, width: 0, height: 0 },
        confidence: 0.9,
        source: "multimodal",
        status: "suggested",
        ais_geofence_verified: geofenceByLine.get(e.line) ?? null,
      }))
    )
    .select("id, raw_text");
  if (error || !data) throw new Error(`PERSIST_FAILED: ${error?.message}`);
  return data;
}
