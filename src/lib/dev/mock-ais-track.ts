// A synthetic AIS track, for looking at the map.
//
// WHY THIS EXISTS. `AisVerificationMap` had never rendered a real track: no AIS
// provider is configured anywhere, so every run exercised the "unavailable"
// path and the projection, segment colouring, gap dashing and event-to-fix
// matching were all unverified. Code nobody has seen draw is code nobody has
// tested.
//
// WHAT IT IS NOT. This is a DEV FIXTURE, not a data source. It is refused in
// production (`isMockAisEnabled`), labelled synthetic everywhere it surfaces,
// and the verdicts derived from it are computed in memory and never written to
// `evidence_checks`. A fabricated position track that reached a persisted
// verdict would put invented evidence into a claim — and evidence is the one
// thing this product exists to be trusted about.
//
// The shape is deliberately awkward rather than tidy: a real track has a
// drifting anchor, a berth shift, a feed gap and duplicate timestamps, and a
// map that only ever draws a clean line has not been tested against anything.

/** Matches `AisFix` in `@/lib/evidence/micro-movement`, without importing it. */
export interface MockAisFix {
  at: string;
  lat: number;
  lon: number;
}

export interface MockTrackOptions {
  /** Anchorage centre. Defaults to Port Hedland's outer anchorage. */
  lat?: number;
  lon?: number;
  /** Deterministic seed, so the same claim always draws the same track. */
  seed?: string;
}

/** xmur3 + mulberry32 — the same shape the corpus generator uses. Never Math.random. */
function makeRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_PER_DEG_LAT = 111_320;

/**
 * Builds a track spanning `fromISO`..`toISO` with four distinct phases.
 *
 * The phases exist so every branch of the map has something to draw:
 *
 *   1. AT ANCHOR — small random drift around a point. Classifies `moored`, and
 *      is what makes a "vessel was shifting" claim contradictable.
 *   2. A FEED GAP — a deliberate hole longer than the gap threshold. Must draw
 *      DASHED and classify `unknown`; a straight solid line across it would
 *      assert a course nobody recorded.
 *   3. SHIFTING — a steady run to the berth at a few knots. Classifies
 *      `shifting`.
 *   4. AT BERTH — tight drift plus a warping excursion, because a 300m hull
 *      under gantry cranes moves its antenna a long way while unambiguously
 *      working cargo. This is the case a naive displacement threshold gets
 *      wrong, so the map should be looked at with it present.
 */
export function generateMockAisTrack(
  fromISO: string,
  toISO: string,
  opts: MockTrackOptions = {}
): MockAisFix[] {
  const from = Date.parse(fromISO);
  const to = Date.parse(toISO);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const rng = makeRng(opts.seed ?? `${fromISO}|${toISO}`);
  const anchorLat = opts.lat ?? -20.25;
  const anchorLon = opts.lon ?? 118.5;
  // Berth roughly 6 km inshore of the anchorage.
  const berthLat = anchorLat + 0.05;
  const berthLon = anchorLon - 0.02;

  const span = to - from;
  const fixes: MockAisFix[] = [];
  const push = (t: number, lat: number, lon: number) =>
    fixes.push({ at: new Date(t).toISOString(), lat, lon });

  // Metres → degrees, longitude corrected for latitude.
  const dLat = (m: number) => m / M_PER_DEG_LAT;
  const dLon = (m: number) =>
    m / (M_PER_DEG_LAT * Math.cos((anchorLat * Math.PI) / 180) || M_PER_DEG_LAT);

  // --- 1. At anchor: first 40% of the window, 20-minute fixes ---
  const anchorEnd = from + span * 0.4;
  for (let t = from; t < anchorEnd; t += 20 * 60_000) {
    // A vessel at anchor swings around her cable; tens of metres, not hundreds.
    push(t, anchorLat + dLat((rng() - 0.5) * 60), anchorLon + dLon((rng() - 0.5) * 60));
  }

  // --- 2. Shifting to berth, with the feed dropping out part-way ---
  //
  // Durations are ABSOLUTE, not fractions of the window. An earlier version
  // spread 8 fixes across a proportional slice, which on a five-day claim put
  // 78 minutes between them — past `maxGapMinutes` (60) — so every leg of the
  // shift classified as an unobserved gap and the map drew NINE dashed segments
  // where one was intended.
  //
  // The gap sits between 30% and 70% of the transit so the dashed segment spans
  // real distance. Placed while she sat at anchor it drew as a zero-length dot,
  // which verified nothing.
  const SHIFT_MS = 3 * 60 * 60_000;
  const SHIFT_FIX_MS = 10 * 60_000;
  const shiftEnd = Math.min(anchorEnd + SHIFT_MS, to);
  const shiftSpan = Math.max(shiftEnd - anchorEnd, 1);
  for (let t = anchorEnd; t <= shiftEnd; t += SHIFT_FIX_MS) {
    const p = Math.min((t - anchorEnd) / shiftSpan, 1);
    if (p > 0.3 && p < 0.7) continue; // the feed is down
    push(
      t,
      anchorLat + (berthLat - anchorLat) * p + dLat((rng() - 0.5) * 15),
      anchorLon + (berthLon - anchorLon) * p + dLon((rng() - 0.5) * 15)
    );
  }

  // --- 3. At berth: to the end of the window, 30-minute fixes, with a warp ---
  for (let t = shiftEnd; t <= to; t += 30 * 60_000) {
    const progress = (t - shiftEnd) / Math.max(to - shiftEnd, 1);
    // Warping along the berth mid-operation: a real displacement, not noise.
    const warp = progress > 0.4 && progress < 0.55 ? 120 : 0;
    push(
      t,
      berthLat + dLat((rng() - 0.5) * 25),
      berthLon + dLon((rng() - 0.5) * 25 + warp)
    );
  }

  // A duplicate timestamp, because real feeds emit them and the engine
  // deliberately dedupes rather than letting an outlier anchor the next segment
  // and manufacture a jump. Including one keeps that path exercised.
  if (fixes.length > 4) {
    fixes.splice(3, 0, { ...fixes[3], lat: fixes[3].lat + dLat(400) });
  }

  return fixes;
}

/**
 * Whether the synthetic track may be served.
 *
 * Opt-in AND non-production. The environment check is not belt-and-braces: a
 * mock track is fabricated evidence, and the one deployment where nobody is
 * watching the console is the one where it must be impossible.
 */
export function isMockAisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AIS_PROVIDER_URL === "mock" && env.NODE_ENV !== "production";
}
