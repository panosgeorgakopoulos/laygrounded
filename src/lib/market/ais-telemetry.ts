// Derives live Eco-Speed telemetry from an AIS track — the F1 "connect the
// engine live to the ship's AIS" piece. Pure and deterministic: the I/O
// (fetchAisTrack) lives in evidence/ais.ts; this turns the returned fixes into
// the { currentSpeedKnots, distanceToPortNm } the optimizer needs.

import type { AisFix } from "@/lib/ingestion/multimodal";

const EARTH_RADIUS_NM = 3440.065; // mean earth radius in nautical miles

export interface LatLon {
  lat: number;
  lon: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in nautical miles (haversine). */
export function haversineNm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface DerivedTelemetry {
  currentSpeedKnots: number;
  distanceToPortNm: number;
  fixesUsed: number;
  // ISO timestamp of the most recent fix the telemetry is derived from.
  asOf: string;
}

// Ignore fix pairs closer together in time than this — a near-zero dt turns
// tiny GPS jitter into an absurd speed.
const MIN_DT_SECONDS = 60;
// Speeds above this are physically impossible for a bulk carrier and signal a
// bad pair (teleporting fix, clock skew) — reject rather than trust.
const MAX_PLAUSIBLE_KNOTS = 30;

/**
 * Turns an AIS track (ascending or descending by time) plus the destination
 * port into optimizer telemetry: speed over ground from the most recent usable
 * fix pair, and great-circle distance from the latest fix to the port. Returns
 * null when the track is too thin or too jittery to read a plausible speed —
 * "unverifiable", never a fabricated figure (mirrors the AIS honesty posture).
 */
export function deriveTelemetryFromAisTrack(
  track: AisFix[],
  port: LatLon
): DerivedTelemetry | null {
  if (!track || track.length < 2) return null;

  // Sort ascending by time so "latest" is unambiguous whatever the provider sent.
  const fixes = [...track].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const latest = fixes[fixes.length - 1];

  // Walk backwards from the latest fix for the first pair with a usable dt and
  // a plausible resulting speed.
  for (let i = fixes.length - 2; i >= 0; i--) {
    const prev = fixes[i];
    const dtSec = (new Date(latest.at).getTime() - new Date(prev.at).getTime()) / 1000;
    if (dtSec < MIN_DT_SECONDS) continue;
    const distNm = haversineNm(prev, latest);
    const speedKnots = distNm / (dtSec / 3600);
    if (speedKnots > MAX_PLAUSIBLE_KNOTS) continue;
    return {
      currentSpeedKnots: Math.round(speedKnots * 100) / 100,
      distanceToPortNm: Math.round(haversineNm(latest, port) * 100) / 100,
      fixesUsed: fixes.length,
      asOf: latest.at,
    };
  }
  return null;
}
