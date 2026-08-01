// The vessel's AIS track for this claim's timeline, with the motion the engine
// derived from it and the verdicts already persisted against each event.
//
// FETCHED ON DEMAND, NOT STORED. `verifyClaimEvidence` persists motion VERDICTS
// into `evidence_checks` but deliberately not the fixes themselves: a position
// track is licensed provider data, it is large, and a stale copy would let the
// map show a track that no longer supports the verdict beside it. So the map
// asks the provider, and says so when it cannot.
//
// AN ABSENT PROVIDER IS A FIRST-CLASS ANSWER. `fetchAisTrack` returns null —
// never [] — when there is no provider, the call fails, or the payload is
// unreadable. Null and empty mean different things ("we could not look" versus
// "we looked and she was nowhere"), and collapsing them is how a map ends up
// implying a vessel was missing from a feed nobody ever queried.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { fetchAisTrack } from "@/lib/evidence/ais";
import { deriveMotionSegments, type AisFix } from "@/lib/evidence/micro-movement";

/** Verdicts the micro-movement checks write. */
const MOTION_CHECK_TYPES = [
  "motion_cargo_operations",
  "motion_shifting",
  "motion_at_berth",
] as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, vessel, vessel_imo, port, port_lat, port_lon")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    // Confirmed events only — the same set the engine computes from, so the map
    // and the figure are describing one timeline.
    const { data: events } = await supabase
      .from("sof_events")
      .select("id, event_type, occurred_at, status")
      .eq("claim_id", claimId)
      .in("status", ["accepted", "edited"])
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true });

    const timeline = events ?? [];

    const { data: checks } = await supabase
      .from("evidence_checks")
      .select("event_id, check_type, verdict, summary, data")
      .eq("claim_id", claimId)
      .in("check_type", MOTION_CHECK_TYPES as unknown as string[]);

    // One verdict per event: an event can carry at most one motion check.
    const verdictByEvent = new Map(
      (checks ?? []).map((c) => [
        c.event_id as string,
        {
          checkType: c.check_type as string,
          verdict: c.verdict as string,
          summary: c.summary as string,
          window: (c.data as Record<string, unknown> | null)?.window ?? null,
        },
      ])
    );

    // Nothing to bound a request with. Reported rather than fetched over an
    // invented window — a track for the wrong period is worse than no track.
    if (timeline.length < 2) {
      return NextResponse.json({
        available: false,
        reason:
          timeline.length === 0
            ? "This claim has no confirmed events, so there is no window to request a track for."
            : "A track needs at least two confirmed events to bound it.",
        vessel: claim.vessel,
        port: { name: claim.port, lat: claim.port_lat, lon: claim.port_lon },
        events: timeline.map((e) => ({ ...e, motion: verdictByEvent.get(e.id) ?? null })),
        track: [],
        segments: [],
      });
    }

    const from = timeline[0].occurred_at as string;
    const to = timeline[timeline.length - 1].occurred_at as string;

    // IMO first: a vessel NAME is not unique and providers key on the number.
    const track: AisFix[] | null = await fetchAisTrack(
      claim.vessel_imo || claim.vessel,
      from,
      to
    );

    if (!track) {
      return NextResponse.json({
        available: false,
        reason: process.env.AIS_PROVIDER_URL
          ? "The AIS provider returned no usable track for this vessel and period."
          : "No AIS provider is configured (AIS_PROVIDER_URL / AIS_PROVIDER_KEY are unset), so the vessel's track could not be retrieved.",
        // Whether the gap is configuration or coverage decides who fixes it.
        providerConfigured: Boolean(process.env.AIS_PROVIDER_URL),
        vessel: claim.vessel,
        window: { from, to },
        port: { name: claim.port, lat: claim.port_lat, lon: claim.port_lon },
        events: timeline.map((e) => ({ ...e, motion: verdictByEvent.get(e.id) ?? null })),
        track: [],
        segments: [],
      });
    }

    const segments = deriveMotionSegments(track);

    return NextResponse.json({
      available: true,
      providerConfigured: true,
      vessel: claim.vessel,
      window: { from, to },
      port: { name: claim.port, lat: claim.port_lat, lon: claim.port_lon },
      track,
      segments,
      events: timeline.map((e) => ({ ...e, motion: verdictByEvent.get(e.id) ?? null })),
      counts: {
        fixes: track.length,
        // Long intervals classify as `unknown` rather than as stillness — a gap
        // in the feed is not evidence the vessel sat still.
        gaps: segments.filter((s) => s.isGap).length,
        contradicted: timeline.filter(
          (e) => verdictByEvent.get(e.id)?.verdict === "contradicted"
        ).length,
        corroborated: timeline.filter(
          (e) => verdictByEvent.get(e.id)?.verdict === "corroborated"
        ).length,
      },
    });
  } catch (e) {
    return apiError(e, "claims/ais-track/GET");
  }
}
