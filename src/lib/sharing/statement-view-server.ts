// Loading the data behind the counterparty statement view.
//
// Split from `statement-view.ts` so the allowlist stays pure and testable
// against a literal row: that file decides WHAT a counterparty may see, this one
// fetches it. The split is the reason `statement-view.test.ts` can stuff a row
// with every internal column in the schema without touching a database.
//
// SERVICE-ROLE, AFTER THE TOKEN IS VALIDATED. Identical to the claim-room
// pattern in `rooms.ts`: the reader has no Supabase session, so RLS cannot
// scope anything for them, and the token IS the authorisation. The critical
// discipline — the same one `requireClaim()` enforces for MCP — is that the
// claim id comes out of the resolved share and is NEVER accepted from the
// caller. A guest cannot nominate the claim they would like to read.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { fetchAisTrack } from "@/lib/evidence/ais";
import type { ResolvedShare } from "@/lib/rooms";
import { buildStatementView, type StatementPosition, type StatementView } from "./statement-view";

/**
 * Assembles the statement view for a validated read-only share.
 *
 * Every query below is pinned to `resolved.share.claim_id`.
 */
export async function loadStatementView(
  resolved: ResolvedShare,
  client?: SupabaseClient
): Promise<StatementView> {
  const supabase = client ?? createServiceRoleClient();
  const { share, claim } = resolved;

  // The full claim row is loaded and then narrowed by `buildStatementView`.
  // Selecting only the shared columns here would be a second, implicit
  // allowlist in a different file — and the one that drifts, because nothing
  // tests it. One allowlist, in the place the leakage test points at.
  const { data: claimRow } = await supabase
    .from("claims")
    .select("*")
    .eq("id", share.claim_id)
    .maybeSingle();

  // CONFIRMED EVENTS ONLY. `suggested` rows are unreviewed machine extractions;
  // `loadClaimComputationInputs` already refuses to compute on them, and sending
  // them to the opposing party as though they were the owner's position is how
  // a claim gets undermined by its own evidence pack.
  const { data: events } = await supabase
    .from("sof_events")
    .select("occurred_at, event_type, raw_text, source")
    .eq("claim_id", share.claim_id)
    .in("status", ["accepted", "edited"])
    .order("occurred_at", { ascending: true });

  // The latest calculation. A claim can carry several as terms are corrected;
  // the newest is the one the owner is presenting.
  const { data: calculation } = await supabase
    .from("laytime_calculations")
    .select("*")
    .eq("claim_id", share.claim_id)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const track = await loadTrack(claimRow ?? {}, events ?? []);

  return buildStatementView({
    share: { counterparty_label: share.counterparty_label, expires_at: share.expires_at },
    claim: claimRow ?? (claim as unknown as Record<string, unknown>),
    calculation: calculation ?? null,
    events: events ?? [],
    track,
  });
}

/**
 * The vessel's position track over the window the events cover.
 *
 * Fetched on demand and never stored, matching `ais-verification-map.tsx`: the
 * app persists motion VERDICTS into `evidence_checks` but not the fixes, and a
 * stale copy would show a track that no longer supports the verdict beside it.
 *
 * Returns null — never `[]` — when there is no IMO or no provider configured.
 * The distinction is load-bearing on this surface above all others: `[]` tells a
 * counterparty "we looked and she was nowhere", which is evidence. `null` says
 * "we could not look", which is not.
 */
async function loadTrack(
  claimRow: Record<string, unknown>,
  events: Array<Record<string, unknown>>
): Promise<StatementPosition[] | null> {
  const imo = typeof claimRow.vessel_imo === "string" ? claimRow.vessel_imo : "";
  if (!imo || events.length === 0) return null;

  const first = events[0]?.occurred_at as string | undefined;
  const last = events[events.length - 1]?.occurred_at as string | undefined;
  if (!first || !last) return null;

  // A day either side, so the approach and departure are visible rather than a
  // track that begins abruptly at the first recorded event.
  const from = new Date(new Date(first).getTime() - 86_400_000).toISOString();
  const to = new Date(new Date(last).getTime() + 86_400_000).toISOString();

  try {
    const fixes = await fetchAisTrack(imo, from, to);
    if (!fixes) return null;
    // Narrowed to three fields. An AIS fix from a provider can carry course,
    // speed, destination and draught; none of that is part of what this surface
    // undertakes to show, and passing the provider's object through would make
    // the payload depend on a third party's schema.
    return fixes.map((f) => ({
      timestamp: f.at,
      lat: f.lat,
      lon: f.lon,
    }));
  } catch {
    // An upstream failure is "we could not look", which is exactly null.
    return null;
  }
}
