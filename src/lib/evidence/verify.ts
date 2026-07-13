// Evidence verification orchestrator: cross-references what the SoF claims
// against independent data (historical weather archives, AIS when configured)
// and persists one evidence_checks row per finding. Re-running replaces the
// claim's previous checks — verification is a snapshot, not an append log.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  assessWeatherWindow,
  fetchHourlyWeather,
  geocodePort,
  WEATHER_THRESHOLDS,
} from "./weather";
import { checkVesselPosition } from "./ais";
import { LineageRecorder } from "@/lib/observability/lineage";

export interface EvidenceCheckRow {
  id: string;
  claim_id: string;
  event_id: string | null;
  check_type: "weather" | "position";
  verdict: "corroborated" | "contradicted" | "inconclusive" | "unavailable";
  summary: string;
  data: Record<string, unknown>;
  checked_at: string;
}

interface WeatherInterval {
  startEventId: string;
  start: string;
  end: string;
}

// Pairs WEATHER_DELAY / WEATHER_DELAY_END among non-rejected events. An open
// delay is capped at the last event on the claim — verifying an interval that
// extends past the SoF would judge hours nobody has claimed.
function pairWeatherIntervals(
  events: Array<{ id: string; event_type: string; occurred_at: string }>
): WeatherInterval[] {
  const sorted = [...events].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );
  const lastEventAt = sorted[sorted.length - 1]?.occurred_at;
  const intervals: WeatherInterval[] = [];
  let open: { id: string; at: string } | null = null;

  for (const e of sorted) {
    if (e.event_type === "WEATHER_DELAY" && !open) {
      open = { id: e.id, at: e.occurred_at };
    } else if (e.event_type === "WEATHER_DELAY_END" && open) {
      intervals.push({ startEventId: open.id, start: open.at, end: e.occurred_at });
      open = null;
    }
  }
  if (open && lastEventAt && lastEventAt > open.at) {
    intervals.push({ startEventId: open.id, start: open.at, end: lastEventAt });
  }
  return intervals;
}

export async function verifyClaimEvidence(
  claimId: string,
  client?: SupabaseClient
): Promise<EvidenceCheckRow[]> {
  const supabase = client ?? (await createClient());

  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("id, vessel, port, port_lat, port_lon")
    .eq("id", claimId)
    .maybeSingle();
  if (claimErr || !claim) throw new Error("CLAIM_NOT_FOUND");

  const { data: events } = await supabase
    .from("sof_events")
    .select("id, event_type, occurred_at, status")
    .eq("claim_id", claimId)
    .neq("status", "rejected")
    .order("occurred_at", { ascending: true });

  const activeEvents = events || [];
  const checks: Array<Omit<EvidenceCheckRow, "id" | "checked_at">> = [];
  const lineage = new LineageRecorder();

  // --- Resolve port coordinates (geocode once, cache on the claim) ---
  let lat: number | null = claim.port_lat;
  let lon: number | null = claim.port_lon;
  let portLabel = claim.port;
  if (lat == null || lon == null) {
    const loc = await geocodePort(claim.port);
    lineage.record({
      source: "open-meteo-geocoding",
      sourceRef: "https://geocoding-api.open-meteo.com/v1/search",
      step: "geocode_port → cache port_lat/port_lon on claim",
      inputs: { port: claim.port },
      outputSummary: loc
        ? { resolved: true, lat: loc.lat, lon: loc.lon, label: loc.label }
        : { resolved: false },
      output: loc,
    });
    if (loc) {
      lat = loc.lat;
      lon = loc.lon;
      portLabel = loc.label;
      await supabase
        .from("claims")
        .update({ port_lat: lat, port_lon: lon })
        .eq("id", claimId);
    }
  }

  // --- Weather checks: one per claimed WEATHER_DELAY interval ---
  const weatherIntervals = pairWeatherIntervals(activeEvents);
  for (const interval of weatherIntervals) {
    if (lat == null || lon == null) {
      checks.push({
        claim_id: claimId,
        event_id: interval.startEventId,
        check_type: "weather",
        verdict: "unavailable",
        summary: `Could not geocode port "${claim.port}" — weather archive not queried.`,
        data: { interval },
      });
      continue;
    }

    const window = await fetchHourlyWeather(lat, lon, interval.start, interval.end);
    if (!window) {
      checks.push({
        claim_id: claimId,
        event_id: interval.startEventId,
        check_type: "weather",
        verdict: "unavailable",
        summary:
          "Weather archive has no readings for this window (reanalysis lags ~5 days behind real time).",
        data: { interval, port: portLabel, lat, lon },
      });
      lineage.record({
        source: "open-meteo-era5",
        sourceRef: "https://archive-api.open-meteo.com/v1/era5",
        step: "fetch_hourly_weather → no readings for window",
        inputs: { lat, lon, interval },
        outputSummary: { available: false },
        output: null,
        checkIndex: checks.length - 1,
      });
      continue;
    }

    const a = assessWeatherWindow(window);
    lineage.record({
      source: "open-meteo-era5",
      sourceRef: "https://archive-api.open-meteo.com/v1/era5",
      step: "fetch_hourly_weather → assess_weather_window against WEATHER_THRESHOLDS",
      inputs: { lat, lon, interval, thresholds: WEATHER_THRESHOLDS },
      outputSummary: {
        verdict: a.verdict,
        max_precip_mm: a.maxPrecipMm,
        max_wind_kn: a.maxWindKn,
        max_gust_kn: a.maxGustKn,
      },
      output: window, // hashed — the exact archive payload the verdict rests on
      checkIndex: checks.length, // the check pushed immediately below
    });
    const range = `${interval.start.slice(0, 16).replace("T", " ")}–${interval.end.slice(0, 16).replace("T", " ")} UTC`;
    let summary: string;
    if (a.verdict === "corroborated") {
      summary = `SoF weather delay ${range} corroborated: archive shows up to ${a.maxPrecipMm.toFixed(1)} mm/h precipitation, wind ${a.maxWindKn.toFixed(0)} kn, gusts ${a.maxGustKn.toFixed(0)} kn at ${portLabel}.`;
    } else if (a.verdict === "contradicted") {
      summary = `SoF claims weather delay ${range}, but the archive shows ≤${a.maxPrecipMm.toFixed(1)} mm/h precipitation and gusts ≤${a.maxGustKn.toFixed(0)} kn at ${portLabel} — conditions unlikely to stop cargo operations.`;
    } else {
      summary = `Weather during ${range} at ${portLabel} is borderline (max ${a.maxPrecipMm.toFixed(1)} mm/h, gusts ${a.maxGustKn.toFixed(0)} kn) — human review recommended.`;
    }

    checks.push({
      claim_id: claimId,
      event_id: interval.startEventId,
      check_type: "weather",
      verdict: a.verdict,
      summary,
      data: {
        interval,
        port: portLabel,
        lat,
        lon,
        assessment: a,
        thresholds: WEATHER_THRESHOLDS,
        source: "Open-Meteo ERA5 reanalysis",
      },
    });
  }

  // --- Position check: NOR tendered (AIS, when a provider is configured) ---
  const nor = activeEvents.find((e) => e.event_type === "NOR_TENDERED");
  if (nor) {
    const pos = await checkVesselPosition(claim.vessel, nor.occurred_at);
    checks.push({
      claim_id: claimId,
      event_id: nor.id,
      check_type: "position",
      verdict: pos.verdict,
      summary: pos.summary,
      data: pos.data,
    });
    lineage.record({
      source: "ais-provider",
      sourceRef: process.env.AIS_PROVIDER_URL ?? "unconfigured",
      step: "check_vessel_position at NOR_TENDERED timestamp",
      inputs: { vessel: claim.vessel, at: nor.occurred_at },
      outputSummary: { verdict: pos.verdict },
      output: pos.data,
      checkIndex: checks.length - 1,
    });
  }

  // --- Persist snapshot ---
  const { error: delErr } = await supabase
    .from("evidence_checks")
    .delete()
    .eq("claim_id", claimId);
  if (delErr) throw new Error(`PERSIST_FAILED: ${delErr.message}`);

  if (checks.length === 0) {
    // Still persist provenance of any external calls made (e.g. geocoding).
    await lineage.persist(supabase, claimId);
    return [];
  }

  const { data: inserted, error: insErr } = await supabase
    .from("evidence_checks")
    .insert(checks)
    .select("*");
  if (insErr) throw new Error(`PERSIST_FAILED: ${insErr.message}`);

  const rows = (inserted || []) as EvidenceCheckRow[];
  // Append-only provenance: link each lineage entry to the check row its
  // data fed (rows come back in insert order).
  await lineage.persist(supabase, claimId, rows.map((r) => r.id));

  return rows;
}
