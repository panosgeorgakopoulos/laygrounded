import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { geocodePort } from "@/lib/evidence/weather";
import {
  auditTimelineAgainstAis,
  GEOFENCE_CLAUSE_REF,
  type AisFix,
} from "@/lib/ingestion/multimodal";
import type { EventTypeEnum } from "@/lib/laytime/types";

const AisFixSchema = z.object({
  at: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const GeofenceAuditSchema = z.object({
  // The vessel's AIS track around the port call, supplied by the caller
  // (owner's provider export, bridge stack download). Deliberately not
  // fetched from AIS_PROVIDER_URL here: provider payload shapes differ and a
  // deterministic audit needs deterministic input.
  aisHistory: z.array(AisFixSchema).min(1).max(5000),
  portRadiusNm: z.number().min(0.1).max(50).optional(),
  anchorageRadiusNm: z.number().min(0.1).max(100).optional(),
  maxAisGapHours: z.number().min(0.5).max(48).optional(),
});

// AIS geofence audit: cross-references every position-bound event on the
// claim against the vessel's AIS track. Verdicts persist three-state to
// sof_events.ais_geofence_verified (true / false / NULL=unverifiable) and
// each discrepancy gets a critical AIS-GEOFENCE clause flag. Re-running
// replaces the previous audit — a snapshot, not an append log.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();

    const parsed = GeofenceAuditSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, port, port_lat, port_lon")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    // Port geofence center: cached coordinates, else geocode once and cache
    // (same policy as evidence verification).
    let lat: number | null = claim.port_lat;
    let lon: number | null = claim.port_lon;
    if (lat == null || lon == null) {
      const loc = await geocodePort(claim.port);
      if (!loc) throw new Error("PORT_NOT_GEOCODED");
      lat = loc.lat;
      lon = loc.lon;
      await supabase.from("claims").update({ port_lat: lat, port_lon: lon }).eq("id", claimId);
    }

    // Suggested events are audited too — catching a discrepancy BEFORE a
    // human confirms the event is the point of the exercise.
    const { data: events } = await supabase
      .from("sof_events")
      .select("id, event_type, occurred_at")
      .eq("claim_id", claimId)
      .neq("status", "rejected")
      .order("occurred_at", { ascending: true });
    if (!events || events.length === 0) throw new Error("NO_EVENTS");

    const audit = auditTimelineAgainstAis(
      events.map((e) => ({
        id: e.id as string,
        event_type: e.event_type as EventTypeEnum,
        occurred_at: e.occurred_at as string,
      })),
      parsed.data.aisHistory as AisFix[],
      { lat, lon },
      {
        portRadiusNm: parsed.data.portRadiusNm,
        anchorageRadiusNm: parsed.data.anchorageRadiusNm,
        maxAisGapHours: parsed.data.maxAisGapHours,
      }
    );

    // Persist verdicts by bucket; unchecked event types keep NULL.
    const byVerdict = { verified: [] as string[], discrepancy: [] as string[], unverifiable: [] as string[] };
    for (const { event, check } of audit.checks) byVerdict[check.verdict].push(event.id);
    const buckets: Array<[string[], boolean | null]> = [
      [byVerdict.verified, true],
      [byVerdict.discrepancy, false],
      [byVerdict.unverifiable, null],
    ];
    for (const [ids, value] of buckets) {
      if (!ids.length) continue;
      const { error } = await supabase
        .from("sof_events")
        .update({ ais_geofence_verified: value })
        .in("id", ids);
      if (error) throw new Error(`PERSIST_FAILED: ${error.message}`);
    }

    // Replace-on-rerun for the discrepancy flags.
    const { error: delErr } = await supabase
      .from("clause_flags")
      .delete()
      .in("event_id", events.map((e) => e.id))
      .eq("clause_ref", GEOFENCE_CLAUSE_REF);
    if (delErr) throw new Error(`PERSIST_FAILED: ${delErr.message}`);
    if (audit.flags.length) {
      const { error: flagErr } = await supabase.from("clause_flags").insert(
        audit.flags.map((f) => ({
          event_id: f.event.id,
          clause_ref: f.clause_ref,
          severity: f.severity,
          note: f.note,
        }))
      );
      if (flagErr) throw new Error(`PERSIST_FAILED: ${flagErr.message}`);
    }

    return NextResponse.json({
      verified: audit.verified,
      discrepancies: audit.discrepancies,
      unverifiable: audit.unverifiable,
      skipped: audit.skipped,
      checks: audit.checks.map(({ event, check }) => ({
        eventId: event.id,
        eventType: event.event_type,
        occurredAt: event.occurred_at,
        verdict: check.verdict,
        distanceNm: check.distanceNm,
        allowedRadiusNm: check.allowedRadiusNm,
        summary: check.summary,
      })),
    });
  } catch (e) {
    return apiError(e, "v1/claims/geofence-audit/POST", {
      PORT_NOT_GEOCODED: 422,
      NO_EVENTS: 409,
    });
  }
}
