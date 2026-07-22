import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiRequest } from "@/lib/api/authenticate";
import { apiAuthFailure, apiFail, apiOk } from "@/lib/api/respond";
import { EVENT_TYPE_VALUES, DEFAULT_CP_TERMS } from "@/lib/laytime/types";

const EventSchema = z.object({
  eventType: z.enum(EVENT_TYPE_VALUES as [string, ...string[]]),
  // Timezone-explicit only — the same rule the AI extraction pipeline and the
  // M2M endpoint enforce. A naive timestamp read in the wrong zone silently
  // moves money.
  occurredAt: z.string().datetime({ offset: true }),
  rawText: z.string().max(500).optional(),
});

const PushSchema = z.object({
  // The caller's own identifier for this voyage. It is the idempotency key:
  // pushing twice updates one claim rather than forking the voyage in two.
  externalRef: z.string().min(1).max(200),
  vessel: z.string().min(1).max(120),
  vesselImo: z.string().min(1).max(20).optional(),
  voyageRef: z.string().min(1).max(120),
  port: z.string().min(1).max(120),
  cargo: z.string().min(1).max(200),
  counterpartyName: z.string().min(1).max(200).optional(),
  timeBarDays: z.number().int().min(1).max(3650).optional(),
  events: z.array(EventSchema).max(500).optional(),
});

// POST /api/v1/audit/voyages — push a voyage into LayGrounded.
//
// Idempotent on (company, external_ref): the claim upserts, so a retrying ERP
// cannot fork one voyage into two claims. Events land as status 'suggested' —
// zero-touch data entry, not zero-touch trust. That is the same posture the
// SoF ingestion route takes, and it is load-bearing: confirmed events are
// what the time bar anchors to and what the notary and MRV report treat as
// evidence, so an event no human has reviewed must not silently acquire that
// standing by arriving over an API.
export async function POST(req: NextRequest) {
  let caller;
  try {
    caller = await authenticateApiRequest(req, "voyages:write");
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/voyages/POST:auth");
  }

  try {
    const parsed = PushSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return apiFail(400, "VALIDATION_ERROR", "Request body failed validation.", parsed.error.flatten());
    }
    const input = parsed.data;

    const { data: claim, error: claimErr } = await caller.client
      .from("claims")
      .upsert(
        {
          company_id: caller.companyId,
          vessel: input.vessel,
          vessel_imo: input.vesselImo ?? null,
          voyage_ref: input.voyageRef,
          port: input.port,
          cargo: input.cargo,
          counterparty_name: input.counterpartyName ?? null,
          cp_form: "GENCON94",
          cp_terms: DEFAULT_CP_TERMS,
          status: "draft",
          external_source: "audit_api",
          external_ref: input.externalRef,
          ...(input.timeBarDays ? { time_bar_days: input.timeBarDays } : {}),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,external_source,external_ref" }
      )
      .select("id, vessel, voyage_ref, created_at, updated_at")
      .single();
    if (claimErr || !claim) throw new Error(`VOYAGE_UPSERT_FAILED: ${claimErr?.message}`);

    let eventsInserted = 0;
    if (input.events?.length) {
      // Events hang off a document row; a pushed voyage gets one stub,
      // reused across pushes (same shape as the multimodal ingest path).
      let { data: doc } = await caller.client
        .from("documents")
        .select("id")
        .eq("claim_id", claim.id)
        .eq("mime", "audit_api")
        .limit(1)
        .maybeSingle();
      if (!doc) {
        const { data: created, error: docErr } = await caller.client
          .from("documents")
          .insert({
            claim_id: claim.id,
            storage_path: `audit_api/${claim.id}`,
            mime: "audit_api",
            original_filename: `Pushed via Audit Trail API (${caller.label})`,
            extraction_status: "extracted",
          })
          .select("id")
          .single();
        if (docErr || !created) throw new Error(`DOCUMENT_FAILED: ${docErr?.message}`);
        doc = created;
      }

      const { data: inserted, error: evErr } = await caller.client
        .from("sof_events")
        .insert(
          input.events.map((e) => ({
            claim_id: claim.id,
            document_id: doc!.id,
            occurred_at: e.occurredAt,
            event_type: e.eventType,
            raw_text: e.rawText ?? `${e.eventType} (Audit Trail API)`,
            page: 1,
            bbox: { x: 0, y: 0, width: 0, height: 0 },
            confidence: 1,
            source: "audit_api",
            status: "suggested",
          }))
        )
        .select("id");
      if (evErr) throw new Error(`EVENTS_FAILED: ${evErr.message}`);
      eventsInserted = inserted?.length ?? 0;
    }

    const created = claim.created_at === claim.updated_at;
    return apiOk(
      {
        claimId: claim.id,
        externalRef: input.externalRef,
        created,
        eventsInserted,
        eventStatus: "suggested",
        notice:
          "Events are recorded as 'suggested'. They do not count toward laytime, the time bar, or notarized proofs until confirmed in the workspace.",
      },
      caller,
      { status: created ? 201 : 200 }
    );
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/voyages/POST");
  }
}

// GET /api/v1/audit/voyages[?externalRef=...] — list, or resolve the caller's
// own reference to a claim id.
export async function GET(req: NextRequest) {
  let caller;
  try {
    caller = await authenticateApiRequest(req, "calculations:read");
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/voyages/GET:auth");
  }

  try {
    const externalRef = req.nextUrl.searchParams.get("externalRef");
    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 50) || 50, 200);

    let q = caller.client
      .from("claims")
      .select("id, vessel, vessel_imo, voyage_ref, port, cargo, status, external_ref, settled_at, created_at")
      .eq("company_id", caller.companyId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (externalRef) q = q.eq("external_ref", externalRef);

    const { data, error } = await q;
    if (error) throw new Error(`QUERY_FAILED: ${error.message}`);

    return apiOk(
      {
        voyages: (data ?? []).map((c) => ({
          claimId: c.id,
          vessel: c.vessel,
          vesselImo: c.vessel_imo,
          voyageRef: c.voyage_ref,
          port: c.port,
          cargo: c.cargo,
          status: c.status,
          externalRef: c.external_ref,
          settledAt: c.settled_at,
          createdAt: c.created_at,
        })),
      },
      caller
    );
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/voyages/GET");
  }
}
