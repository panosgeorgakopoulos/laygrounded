// Geofence audit bridge: the DB half of the Autopilot cross-verification.
//
// The engine in ./multimodal.ts stays pure; this module owns everything that
// touches Supabase — resolving the port center, loading the claim's events,
// persisting three-state verdicts, and replacing the discrepancy flags. Both
// entry points share it: the explicit audit route (caller supplies a track)
// and the extraction pipeline (track fetched from the configured provider),
// so a discrepancy means the same thing however the SoF arrived.
//
// Callers running outside a user request must pass a service-role client;
// the cookie client has no user and RLS blocks everything.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { geocodePort } from "@/lib/evidence/weather";
import {
  auditTimelineAgainstAis,
  GEOFENCE_CLAUSE_REF,
  type AisFix,
  type GeofenceOptions,
} from "@/lib/ingestion/multimodal";
import type { EventTypeEnum } from "@/lib/laytime/types";

export interface GeofenceAuditCheck {
  eventId: string;
  eventType: EventTypeEnum;
  occurredAt: string;
  verdict: "verified" | "discrepancy" | "unverifiable";
  distanceNm: number | null;
  allowedRadiusNm: number | null;
  summary: string;
}

export interface GeofenceAuditSummary {
  verified: number;
  discrepancies: number;
  unverifiable: number;
  skipped: number;
  checks: GeofenceAuditCheck[];
}

// Resolves the port geofence center: cached coordinates, else geocode once
// and cache (same policy as evidence verification).
async function resolvePortCenter(
  supabase: SupabaseClient,
  claim: { id: string; port: string; port_lat: number | null; port_lon: number | null }
): Promise<{ lat: number; lon: number }> {
  if (claim.port_lat != null && claim.port_lon != null) {
    return { lat: claim.port_lat, lon: claim.port_lon };
  }
  const loc = claim.port ? await geocodePort(claim.port) : null;
  if (!loc) throw new Error("PORT_NOT_GEOCODED");
  await supabase
    .from("claims")
    .update({ port_lat: loc.lat, port_lon: loc.lon })
    .eq("id", claim.id);
  return { lat: loc.lat, lon: loc.lon };
}

// Audits every position-bound event on the claim against the supplied track.
// Verdicts persist to sof_events.ais_geofence_verified (true / false /
// NULL=unverifiable) and each discrepancy gets a critical AIS-GEOFENCE clause
// flag. Re-running replaces the previous audit — a snapshot, not an append log.
//
// Suggested events are audited too: catching a discrepancy BEFORE a human
// confirms the event is the point of the exercise.
export async function runGeofenceAudit(opts: {
  claimId: string;
  aisHistory: AisFix[];
  client?: SupabaseClient;
  geofence?: GeofenceOptions;
}): Promise<GeofenceAuditSummary> {
  const supabase = opts.client ?? (await createClient());

  const { data: claim } = await supabase
    .from("claims")
    .select("id, port, port_lat, port_lon")
    .eq("id", opts.claimId)
    .maybeSingle();
  if (!claim) throw new Error("CLAIM_NOT_FOUND");

  const center = await resolvePortCenter(supabase, claim as any);

  const { data: events } = await supabase
    .from("sof_events")
    .select("id, event_type, occurred_at")
    .eq("claim_id", opts.claimId)
    .neq("status", "rejected")
    .order("occurred_at", { ascending: true });
  if (!events || events.length === 0) throw new Error("NO_EVENTS");

  const audit = auditTimelineAgainstAis(
    events.map((e) => ({
      id: e.id as string,
      event_type: e.event_type as EventTypeEnum,
      occurred_at: e.occurred_at as string,
    })),
    opts.aisHistory,
    center,
    opts.geofence ?? {}
  );

  // Persist verdicts by bucket; unchecked event types keep NULL.
  const byVerdict = {
    verified: [] as string[],
    discrepancy: [] as string[],
    unverifiable: [] as string[],
  };
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
    .in(
      "event_id",
      events.map((e) => e.id)
    )
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

  return {
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
  };
}
