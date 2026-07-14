import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { runGeofenceAudit } from "@/lib/ingestion/geofence-server";
import { fetchAisTrack } from "@/lib/evidence/ais";
import type { AisFix } from "@/lib/ingestion/multimodal";

const AisFixSchema = z.object({
  at: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const GeofenceAuditSchema = z.object({
  // The vessel's AIS track around the port call (owner's provider export,
  // bridge stack download). A caller-supplied track is authoritative and
  // keeps the audit deterministic; omit it and the server fetches one from
  // AIS_PROVIDER_URL via the normalizer, which is what lets the workspace
  // trigger an audit with no track of its own. Unconfigured provider →
  // AIS_UNAVAILABLE, never a silent pass.
  aisHistory: z.array(AisFixSchema).min(1).max(5000).optional(),
  portRadiusNm: z.number().min(0.1).max(50).optional(),
  anchorageRadiusNm: z.number().min(0.1).max(100).optional(),
  maxAisGapHours: z.number().min(0.5).max(48).optional(),
});

// Pads the AIS request window either side of the chronology so the track
// brackets the first and last event rather than starting at them.
const AIS_WINDOW_PAD_HOURS = 12;

// Resolves the track to audit against: the caller's if supplied, else the
// configured provider's over the claim's event window.
async function resolveTrack(
  supabase: Awaited<ReturnType<typeof createClient>>,
  claimId: string,
  supplied: AisFix[] | undefined
): Promise<AisFix[]> {
  if (supplied) return supplied;

  const { data: claim } = await supabase
    .from("claims")
    .select("vessel, vessel_imo")
    .eq("id", claimId)
    .maybeSingle();
  const vesselRef = claim?.vessel_imo || claim?.vessel;
  if (!vesselRef) throw new Error("AIS_UNAVAILABLE");

  const { data: events } = await supabase
    .from("sof_events")
    .select("occurred_at")
    .eq("claim_id", claimId)
    .neq("status", "rejected")
    .order("occurred_at", { ascending: true });
  if (!events || events.length === 0) throw new Error("NO_EVENTS");

  const padMs = AIS_WINDOW_PAD_HOURS * 3600_000;
  const first = new Date(events[0].occurred_at as string).getTime();
  const last = new Date(events[events.length - 1].occurred_at as string).getTime();
  if (Number.isNaN(first) || Number.isNaN(last)) throw new Error("AIS_UNAVAILABLE");

  const track = await fetchAisTrack(
    vesselRef,
    new Date(first - padMs).toISOString(),
    new Date(last + padMs).toISOString()
  );
  if (!track) throw new Error("AIS_UNAVAILABLE");
  return track;
}

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

    // Tenancy check stays here (defense in depth alongside RLS); the bridge
    // owns the audit itself and is shared with the extraction pipeline.
    const supabase = await createClient();
    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const aisHistory = await resolveTrack(
      supabase,
      claimId,
      parsed.data.aisHistory as AisFix[] | undefined
    );

    const audit = await runGeofenceAudit({
      claimId,
      aisHistory,
      client: supabase,
      geofence: {
        portRadiusNm: parsed.data.portRadiusNm,
        anchorageRadiusNm: parsed.data.anchorageRadiusNm,
        maxAisGapHours: parsed.data.maxAisGapHours,
      },
    });

    return NextResponse.json(audit);
  } catch (e) {
    return apiError(e, "v1/claims/geofence-audit/POST", {
      PORT_NOT_GEOCODED: 422,
      NO_EVENTS: 409,
      AIS_UNAVAILABLE: 422,
    });
  }
}
