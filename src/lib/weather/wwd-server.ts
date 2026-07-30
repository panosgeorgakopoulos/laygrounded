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
  type StoppageDimension,
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
  origin: "baseline",
  overriddenDimensions: [],
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

/**
 * Which dimensions a tenant row actually changed, by diffing it against the
 * baseline it shadows.
 *
 * Derived rather than stored. An override row copies every threshold from the
 * global at creation, so the row alone cannot say what was deliberately
 * changed — and a stored "I edited precipitation" flag would drift the moment
 * someone edited the row another way. The diff is always true by construction.
 */
function overriddenDimensions(
  tenant: ProfileRow,
  base: ProfileRow | undefined
): StoppageDimension[] {
  if (!base) return [];
  const out: StoppageDimension[] = [];
  if (tenant.precip_mm_per_hr !== base.precip_mm_per_hr) out.push("precipitation");
  if (tenant.wind_kn !== base.wind_kn) out.push("wind");
  if (tenant.gust_kn !== base.gust_kn) out.push("gust");
  if (tenant.min_temp_c !== base.min_temp_c || tenant.max_temp_c !== base.max_temp_c) {
    out.push("temperature");
  }
  return out;
}

function toProfile(r: ProfileRow, base?: ProfileRow): CargoWeatherProfile {
  const isTenant = r.company_id !== null;
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
    origin: isTenant ? "tenant" : "baseline",
    overriddenDimensions: isTenant ? overriddenDimensions(r, base) : [],
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
export interface ResolvedProfile {
  profile: CargoWeatherProfile;
  /** The published baseline this shadows, when the profile is a tenant override. */
  baseline: CargoWeatherProfile | null;
}

export async function resolveCargoProfile(
  db: SupabaseClient,
  companyId: string,
  cargo: string
): Promise<ResolvedProfile> {
  const key = normalizeCargoKey(cargo);

  const { data } = await db
    .from("cargo_weather_profiles")
    .select(
      "company_id, cargo_key, aliases, label, precip_mm_per_hr, wind_kn, gust_kn, min_temp_c, max_temp_c, min_stoppage_minutes, source_label"
    )
    .or(`company_id.eq.${companyId},company_id.is.null`);

  const rows = (data ?? []) as ProfileRow[];
  if (rows.length === 0) return { profile: GENERIC_PROFILE, baseline: null };

  // Tenant rows first, so an override always beats the curated default.
  const ranked = [...rows].sort((a, b) => (a.company_id ? -1 : 1) - (b.company_id ? -1 : 1));

  // A tenant row's provenance is only meaningful against the baseline it
  // shadows, so the global for the same cargo travels with it.
  const baseFor = (row: ProfileRow) =>
    rows.find((r) => r.company_id === null && r.cargo_key === row.cargo_key);

  // Most specific match first. `claims.cargo` is free text — "Soybeans, 54,000
  // MT", "Iron Ore Fines" — so key-only matching misses nearly every real
  // claim, which would make the seeded defaults useless in practice.
  const pack = (row: ProfileRow): ResolvedProfile => {
    const base = baseFor(row);
    return {
      profile: toProfile(row, base),
      // Only meaningful for a tenant row; a baseline shadows nothing.
      baseline: row.company_id !== null && base ? toProfile(base) : null,
    };
  };

  const exact = ranked.find((r) => r.cargo_key === key);
  if (exact) return pack(exact);

  const byKey = ranked.find((r) => key.includes(r.cargo_key));
  if (byKey) return pack(byKey);

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
  if (best) return pack(best.row);

  return { profile: GENERIC_PROFILE, baseline: null };
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

  const { profile, baseline } = await resolveCargoProfile(
    supabase,
    claim.company_id,
    claim.cargo ?? ""
  );
  const resolution = resolveWeatherWorkingTime({
    window,
    hourly,
    profile,
    claimed,
    // Supplied so a tenant override's effect is measured rather than trusted.
    baselineProfile: baseline ?? undefined,
  });

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
