// WWD resolver — the database and network half.
//
// Loads the claim's operational window, geocodes the port (reusing the cached
// coordinates), pulls the hourly archive, picks the cargo profile, runs the
// pure resolver, and — only when asked — writes the resolved stoppages back as
// SUGGESTED events.
//
// Suggested, never confirmed. A machine-derived weather stoppage is evidence
// for a human to accept, not a fact about the voyage. Confirmed events feed
// legally-operative figures and notarized proofs, and arriving from an archive
// query is not review. Same rule as API-pushed events.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchHourlyWeather, geocodePort } from "@/lib/evidence/weather";
import {
  resolveWeatherWorkingTime,
  blocksToSofEvents,
  type CargoWeatherProfile,
  type HourlyObservation,
  type Interval,
  type WwdResolution,
} from "./wwd-resolver";

/** Fallback when a cargo has no profile: the generic thresholds, named as such. */
export const GENERIC_PROFILE: CargoWeatherProfile = {
  cargoKey: "__generic__",
  label: "Generic cargo (no profile matched)",
  precipMmPerHr: 0.5,
  windKn: 20,
  gustKn: 25,
  minTempC: null,
  maxTempC: null,
  minStoppageMinutes: 60,
  sourceLabel: "LayGrounded generic fallback — no cargo profile matched",
};

/** Cargo strings are free text; match on a normalised, contained key. */
export function normalizeCargoKey(cargo: string): string {
  return cargo.trim().toLowerCase();
}

interface ProfileRow {
  company_id: string | null;
  cargo_key: string;
  aliases: string[] | null;
  label: string;
  precip_mm_per_hr: number | null;
  wind_kn: number | null;
  gust_kn: number | null;
  min_temp_c: number | null;
  max_temp_c: number | null;
  min_stoppage_minutes: number;
  source_label: string;
}

function toProfile(r: ProfileRow): CargoWeatherProfile {
  return {
    cargoKey: r.cargo_key,
    label: r.label,
    precipMmPerHr: r.precip_mm_per_hr,
    windKn: r.wind_kn,
    gustKn: r.gust_kn,
    minTempC: r.min_temp_c,
    maxTempC: r.max_temp_c,
    minStoppageMinutes: r.min_stoppage_minutes,
    sourceLabel: r.source_label,
  };
}

/**
 * The profile for a cargo, tenant override winning over the curated global.
 *
 * Matching is substring-based in both directions because `claims.cargo` is free
 * text: "60,000 MT Soybeans" should find "grain" only if a profile says so, but
 * "Iron Ore Fines" should find "iron ore". Exact-key equality is tried first so
 * a precise profile always beats a loose match.
 */
export async function resolveCargoProfile(
  db: SupabaseClient,
  companyId: string,
  cargo: string
): Promise<CargoWeatherProfile> {
  const key = normalizeCargoKey(cargo);

  const { data } = await db
    .from("cargo_weather_profiles")
    .select(
      "company_id, cargo_key, aliases, label, precip_mm_per_hr, wind_kn, gust_kn, min_temp_c, max_temp_c, min_stoppage_minutes, source_label"
    )
    .or(`company_id.eq.${companyId},company_id.is.null`);

  const rows = (data ?? []) as ProfileRow[];
  if (rows.length === 0) return GENERIC_PROFILE;

  // Tenant rows first, so an override always beats the curated default.
  const ranked = [...rows].sort((a, b) => (a.company_id ? -1 : 1) - (b.company_id ? -1 : 1));

  // Most specific match first. `claims.cargo` is free text — "Soybeans, 54,000
  // MT", "Iron Ore Fines" — so key-only matching misses nearly every real
  // claim, which would make the seeded defaults useless in practice.
  const exact = ranked.find((r) => r.cargo_key === key);
  if (exact) return toProfile(exact);

  const byKey = ranked.find((r) => key.includes(r.cargo_key));
  if (byKey) return toProfile(byKey);

  // Longest alias wins, so "coking coal" beats a bare "coal" when both match.
  let best: { row: ProfileRow; len: number } | null = null;
  for (const r of ranked) {
    for (const alias of r.aliases ?? []) {
      const a = alias.trim().toLowerCase();
      if (a && key.includes(a) && (!best || a.length > best.len)) {
        best = { row: r, len: a.length };
      }
    }
  }
  if (best) return toProfile(best.row);

  return GENERIC_PROFILE;
}

export interface WwdRunResult {
  resolution: WwdResolution | null;
  /** Set when nothing could be resolved, with the reason stated plainly. */
  unavailable: string | null;
  window: Interval | null;
  port: { name: string; lat: number; lon: number } | null;
  /** Ids of the suggested events written, when `apply` was set. */
  createdEventIds: string[];
}

const CONFIRMED = ["accepted", "edited"];

/**
 * Runs the resolver for a claim.
 *
 * `apply: false` (the default) computes and returns without writing anything —
 * the operator sees what would be suggested before any row is created.
 */
export async function runWwdResolver(
  claimId: string,
  supabase: SupabaseClient,
  opts: { apply?: boolean; createdBy?: string | null } = {}
): Promise<WwdRunResult> {
  const empty: WwdRunResult = {
    resolution: null,
    unavailable: null,
    window: null,
    port: null,
    createdEventIds: [],
  };

  const { data: claim } = await supabase
    .from("claims")
    .select("id, company_id, port, cargo, port_lat, port_lon")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) throw new Error("CLAIM_NOT_FOUND");

  // The window is the confirmed operational span. Resolving outside it would
  // except time that was never laytime in the first place.
  const { data: events } = await supabase
    .from("sof_events")
    .select("event_type, occurred_at")
    .eq("claim_id", claimId)
    .in("status", CONFIRMED)
    .order("occurred_at", { ascending: true });

  const confirmed = events ?? [];
  if (confirmed.length < 2) {
    return {
      ...empty,
      unavailable:
        "This claim needs at least two confirmed events before a weather window can be resolved.",
    };
  }

  const window: Interval = {
    from: confirmed[0].occurred_at,
    to: confirmed[confirmed.length - 1].occurred_at,
  };

  // Coordinates, cached on the claim by whichever surface geocoded first.
  let lat = claim.port_lat as number | null;
  let lon = claim.port_lon as number | null;
  if (lat === null || lon === null) {
    const loc = await geocodePort(claim.port);
    if (!loc) {
      return {
        ...empty,
        window,
        unavailable: `The port "${claim.port}" could not be geocoded, so no weather archive could be queried. No stoppage is asserted either way.`,
      };
    }
    lat = loc.lat;
    lon = loc.lon;
    void supabase.from("claims").update({ port_lat: lat, port_lon: lon }).eq("id", claimId);
  }

  const hourlyWindow = await fetchHourlyWeather(lat, lon, window.from, window.to);
  if (!hourlyWindow) {
    return {
      ...empty,
      window,
      port: { name: claim.port, lat, lon },
      unavailable:
        "The weather archive returned nothing for this window. ERA5 reanalysis lags by about five days, so a very recent voyage may simply not be published yet. Nothing is assumed about the weather.",
    };
  }

  // Parallel arrays → one observation per hour.
  const hourly: HourlyObservation[] = hourlyWindow.times.map((t, i) => ({
    at: new Date(`${t}:00Z`).toISOString(),
    precipitationMm: hourlyWindow.precipitationMm[i] ?? null,
    windSpeedKn: hourlyWindow.windSpeedKn[i] ?? null,
    windGustKn: hourlyWindow.windGustKn[i] ?? null,
  }));

  // Weather the SoF already claims, for the agreement report.
  const claimed: Interval[] = [];
  let openFrom: string | null = null;
  for (const e of confirmed) {
    if (e.event_type === "WEATHER_DELAY" && openFrom === null) openFrom = e.occurred_at;
    else if (e.event_type === "WEATHER_DELAY_END" && openFrom !== null) {
      claimed.push({ from: openFrom, to: e.occurred_at });
      openFrom = null;
    }
  }
  if (openFrom !== null) claimed.push({ from: openFrom, to: window.to });

  const profile = await resolveCargoProfile(supabase, claim.company_id, claim.cargo ?? "");
  const resolution = resolveWeatherWorkingTime({ window, hourly, profile, claimed });

  if (profile.cargoKey === GENERIC_PROFILE.cargoKey) {
    resolution.warnings.push(
      `No cargo profile matched "${claim.cargo}", so generic thresholds were used. Add a profile for this cargo to resolve it on its own sensitivities.`
    );
  }

  const result: WwdRunResult = {
    resolution,
    unavailable: null,
    window,
    port: { name: claim.port, lat, lon },
    createdEventIds: [],
  };

  if (!opts.apply || resolution.blocks.length === 0) return result;

  // --- Write suggested events ---
  // Only the stoppages the SoF does NOT already claim. Re-suggesting what the
  // Master already recorded would duplicate the interval and double-count the
  // exclusion once both were confirmed.
  const unclaimed = new Set(resolution.agreement.resolvedOnly.map((i) => i.from));
  const newBlocks = resolution.blocks.filter((b) => unclaimed.has(b.from));
  if (newBlocks.length === 0) return result;

  const documentId = await ensureResolverDocument(supabase, claimId);
  const rows = blocksToSofEvents(newBlocks).map((e) => ({
    claim_id: claimId,
    document_id: documentId,
    event_type: e.event_type,
    occurred_at: e.occurred_at,
    raw_text: e.raw_text,
    // The whole point: a human decides. Never 'accepted'.
    status: "suggested",
    source: "wwd_resolver",
    ai_reasoning: e.raw_text,
  }));

  const { data: inserted, error } = await supabase.from("sof_events").insert(rows).select("id");
  if (error) throw new Error(`WWD_EVENT_INSERT_FAILED: ${error.message}`);

  result.createdEventIds = (inserted ?? []).map((r) => r.id as string);
  return result;
}

/**
 * A stub document to hang resolver-derived events off.
 *
 * `sof_events.document_id` is NOT NULL, and these events come from an archive
 * query rather than a paper SoF. Reusing a real uploaded document would
 * misattribute them to the Master's statement — which is exactly the confusion
 * this feature exists to remove. Mirrors `chain/ripple.ts`, which creates a
 * `mime: 'chain'` stub for the same reason.
 */
async function ensureResolverDocument(
  supabase: SupabaseClient,
  claimId: string
): Promise<string> {
  const { data: existing } = await supabase
    .from("documents")
    .select("id")
    .eq("claim_id", claimId)
    .eq("mime", "wwd-resolver")
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data, error } = await supabase
    .from("documents")
    .insert({
      claim_id: claimId,
      storage_path: `wwd-resolver/${claimId}`,
      mime: "wwd-resolver",
      original_filename: "Weather Working Day resolver",
      extraction_status: "complete",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`WWD_DOCUMENT_FAILED: ${error?.message}`);
  return data.id as string;
}
