// Micro-movement verification: does the vessel's own track agree with what the
// Master said she was doing?
//
// The existing geofence check answers "was she at the port". This answers the
// harder and more valuable question: "was she DOING what the SoF claims". A
// vessel genuinely working cargo sits at near-zero speed with small positional
// corrections as she is warped along the berth. A vessel that shifted berth
// moved. A vessel under way did not work cargo. None of that requires new data
// — it is derivable from the position fixes already fetched for geofencing.
//
// TWO RULES CARRIED OVER FROM THE WEATHER VERIFIER, BOTH LOAD-BEARING:
//
//   1. A GAP IS UNKNOWN, NEVER "STATIONARY". Two fixes three hours apart and
//      fifty metres apart do not prove the vessel stayed put — she could have
//      sailed and returned. Sparse coverage yields `inconclusive`, never
//      `corroborated`. Getting this wrong would manufacture evidence, which is
//      far worse than having none.
//   2. NO TRACK IS `unavailable`, NOT "no movement". An absent feed must never
//      read as a finding.
//
// This module deliberately does NOT use draught. `AisFix` carries position
// only, and draught is master-entered — so it evidences a *claim* about cargo
// rather than measuring it. Adding it later is an adapter change plus a
// provider check, behind this same verdict interface.
//
// Pure: no I/O, no clock. The caller supplies the track.

import type { SofEventInput } from "@/lib/laytime/types";

export interface AisFix {
  /** ISO 8601. */
  at: string;
  lat: number;
  lon: number;
}

export type MotionState = "moored" | "shifting" | "underway" | "unknown";

export type MotionVerdict = "corroborated" | "contradicted" | "inconclusive" | "unavailable";

/**
 * Thresholds separating the three motion states.
 *
 * These are judgement calls about physics and instrument noise, so they are
 * stated as one overridable object with a mandatory `sourceLabel` — the same
 * discipline as the cargo weather profiles, and for the same reason: a number
 * that decides whether real money counts must be able to say where it came from.
 */
export interface MicroMovementThresholds {
  /**
   * Displacement a moored vessel may show without being "moving".
   *
   * Not instrument noise alone: a 300m hull warped along a berth under gantry
   * cranes moves its AIS antenna a long way while unambiguously working cargo.
   */
  mooredDisplacementM: number;
  /** Below this, derived speed is warping and GPS jitter, not way. */
  mooredSpeedKn: number;
  /** At or above this the vessel is making way, not adjusting position. */
  underwaySpeedKn: number;
  /**
   * Longest interval between fixes that still counts as observation.
   *
   * Beyond it the track is silent, and silence is not evidence of stillness.
   */
  maxGapMinutes: number;
  /** Share of a window that must be observed before a verdict is decisive. */
  minCoverage: number;
  sourceLabel: string;
}

export const DEFAULT_THRESHOLDS: MicroMovementThresholds = {
  mooredDisplacementM: 200,
  mooredSpeedKn: 0.5,
  underwaySpeedKn: 3,
  maxGapMinutes: 60,
  minCoverage: 0.7,
  sourceLabel: "LayGrounded micro-movement baseline — overridable",
};

const EARTH_RADIUS_M = 6_371_000;
const MS_PER_HOUR = 3_600_000;
const M_PER_NM = 1852;

/** Great-circle distance in metres. */
export function haversineMetres(a: AisFix, b: AisFix): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface MotionSegment {
  from: string;
  to: string;
  hours: number;
  distanceM: number;
  /** Average speed over the segment. A LOWER BOUND when the segment is long. */
  speedKn: number;
  state: MotionState;
  /** True when the fixes bounding this segment are too far apart to observe it. */
  isGap: boolean;
}

/**
 * Turns a position track into classified motion segments.
 *
 * Segments run between consecutive fixes, so a segment's speed is an AVERAGE.
 * Over a long interval that average is only a lower bound on what happened
 * inside it — which is exactly why long intervals are flagged `isGap` and
 * classified `unknown` rather than being read as evidence of stillness.
 */
export function deriveMotionSegments(
  track: AisFix[],
  thresholds: MicroMovementThresholds = DEFAULT_THRESHOLDS
): MotionSegment[] {
  // Providers do not agree on ordering; sort defensively rather than trusting.
  const sorted = [...track]
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && !Number.isNaN(Date.parse(f.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Collapse duplicate timestamps, keeping the first.
  //
  // Two positions at the same instant is a corrupt feed — the vessel cannot be
  // in two places — and skipping only the zero-duration segment is not enough:
  // the outlier would still anchor the NEXT segment and manufacture a jump of
  // hundreds of metres, which classifies as "under way" and could contradict a
  // perfectly honest Statement of Facts. Deduping is the difference between
  // reporting a feed artefact and inventing a finding from one.
  const fixes: AisFix[] = [];
  for (const f of sorted) {
    if (fixes.length > 0 && Date.parse(f.at) === Date.parse(fixes[fixes.length - 1].at)) continue;
    fixes.push(f);
  }

  const segments: MotionSegment[] = [];

  for (let i = 1; i < fixes.length; i++) {
    const prev = fixes[i - 1];
    const cur = fixes[i];
    const ms = Date.parse(cur.at) - Date.parse(prev.at);

    // Duplicate or out-of-order timestamps would divide by zero and yield an
    // infinite speed that classifies as "underway" — a fabricated finding from
    // a feed artefact.
    if (ms <= 0) continue;

    const hours = ms / MS_PER_HOUR;
    const distanceM = haversineMetres(prev, cur);
    const speedKn = distanceM / M_PER_NM / hours;
    const isGap = ms > thresholds.maxGapMinutes * 60_000;

    let state: MotionState;
    if (isGap) {
      state = "unknown";
    } else if (speedKn >= thresholds.underwaySpeedKn) {
      state = "underway";
    } else if (speedKn <= thresholds.mooredSpeedKn && distanceM <= thresholds.mooredDisplacementM) {
      state = "moored";
    } else {
      state = "shifting";
    }

    segments.push({ from: prev.at, to: cur.at, hours, distanceM, speedKn, state, isGap });
  }

  return segments;
}

export interface WindowMotion {
  from: string;
  to: string;
  hours: number;
  /** Observed share of the window, 0–1. Gaps do not count as observation. */
  coverage: number;
  /** Duration in each state, hours. */
  stateHours: Record<MotionState, number>;
  dominantState: MotionState;
  /** Straight-line distance between the first and last observed positions. */
  netDisplacementM: number;
  /** Furthest the vessel got from where the window started. */
  maxExcursionM: number;
  observedFixes: number;
}

/** Summarises what the track says about one time window. */
export function summariseWindow(
  track: AisFix[],
  fromISO: string,
  toISO: string,
  thresholds: MicroMovementThresholds = DEFAULT_THRESHOLDS
): WindowMotion {
  const from = Date.parse(fromISO);
  const to = Date.parse(toISO);
  const windowHours = Math.max(0, (to - from) / MS_PER_HOUR);

  const stateHours: Record<MotionState, number> = {
    moored: 0,
    shifting: 0,
    underway: 0,
    unknown: 0,
  };

  const inWindow = [...track]
    .filter((f) => {
      const t = Date.parse(f.at);
      return Number.isFinite(t) && t >= from && t <= to;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  for (const seg of deriveMotionSegments(track, thresholds)) {
    // Clip each segment to the window so a segment straddling the boundary
    // contributes only the part that actually falls inside it.
    const segFrom = Math.max(Date.parse(seg.from), from);
    const segTo = Math.min(Date.parse(seg.to), to);
    if (segTo <= segFrom) continue;
    stateHours[seg.state] += (segTo - segFrom) / MS_PER_HOUR;
  }

  const observedHours = stateHours.moored + stateHours.shifting + stateHours.underway;
  const coverage = windowHours > 0 ? Math.min(1, observedHours / windowHours) : 0;

  let netDisplacementM = 0;
  let maxExcursionM = 0;
  if (inWindow.length >= 2) {
    netDisplacementM = haversineMetres(inWindow[0], inWindow[inWindow.length - 1]);
    for (const f of inWindow) {
      maxExcursionM = Math.max(maxExcursionM, haversineMetres(inWindow[0], f));
    }
  }

  const dominantState = (Object.entries(stateHours) as Array<[MotionState, number]>).reduce(
    (best, [state, hours]) => (hours > stateHours[best] ? state : best),
    "unknown" as MotionState
  );

  return {
    from: fromISO,
    to: toISO,
    hours: windowHours,
    coverage,
    stateHours,
    dominantState,
    netDisplacementM,
    maxExcursionM,
    observedFixes: inWindow.length,
  };
}

export type MicroMovementCheckType =
  | "motion_cargo_operations"
  | "motion_shifting"
  | "motion_at_berth";

export interface MicroMovementCheck {
  checkType: MicroMovementCheckType;
  verdict: MotionVerdict;
  summary: string;
  /** The event whose claim this tests, when the check is anchored to one. */
  eventId: string | null;
  window: WindowMotion | null;
  thresholdSource: string;
}

const OPS_START = new Set(["COMMENCED_LOADING", "COMMENCED_DISCHARGE"]);
const OPS_END = new Set(["COMPLETED_LOADING", "COMPLETED_DISCHARGE"]);

function ordered(events: SofEventInput[]): SofEventInput[] {
  return [...events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
}

/** Pairs each opening event with the next closing one after it. */
function pairWindows(
  events: SofEventInput[],
  opens: (e: SofEventInput) => boolean,
  closes: (e: SofEventInput) => boolean
): Array<{ open: SofEventInput; close: SofEventInput }> {
  const out: Array<{ open: SofEventInput; close: SofEventInput }> = [];
  const seq = ordered(events);
  for (let i = 0; i < seq.length; i++) {
    if (!opens(seq[i])) continue;
    const close = seq.slice(i + 1).find(closes);
    if (close) out.push({ open: seq[i], close });
  }
  return out;
}

/**
 * Cross-references the claimed timeline against the track.
 *
 * Returns one check per testable claim. An empty result means the timeline
 * contained nothing this module can speak to — which is reported as such, not
 * as a clean bill of health.
 */
export function verifyTimelineMotion(
  track: AisFix[] | null,
  events: SofEventInput[],
  thresholds: MicroMovementThresholds = DEFAULT_THRESHOLDS
): MicroMovementCheck[] {
  const checks: MicroMovementCheck[] = [];

  const unavailable = (
    checkType: MicroMovementCheckType,
    eventId: string | null,
    reason: string
  ): MicroMovementCheck => ({
    checkType,
    verdict: "unavailable",
    summary: reason,
    eventId,
    window: null,
    thresholdSource: thresholds.sourceLabel,
  });

  // No track at all is "we could not look", never "nothing happened".
  if (track === null) {
    return [
      unavailable(
        "motion_at_berth",
        null,
        "No AIS track was available for this claim, so the Statement of Facts could not be cross-checked against vessel movement."
      ),
    ];
  }
  if (track.length < 2) {
    return [
      unavailable(
        "motion_at_berth",
        null,
        `The AIS track holds ${track.length} position${track.length === 1 ? "" : "s"}, too few to derive any movement.`
      ),
    ];
  }

  // ── Cargo operations: she should be alongside and essentially still ────────
  for (const { open, close } of pairWindows(
    events,
    (e) => OPS_START.has(e.event_type as string),
    (e) => OPS_END.has(e.event_type as string)
  )) {
    const w = summariseWindow(track, open.occurred_at, close.occurred_at, thresholds);
    checks.push({
      checkType: "motion_cargo_operations",
      eventId: open.id ?? null,
      window: w,
      thresholdSource: thresholds.sourceLabel,
      ...judgeCargoOperations(w, thresholds),
    });
  }

  // ── Shifting: a claimed shift must actually have moved the vessel ──────────
  for (const { open, close } of pairWindows(
    events,
    (e) => (e.event_type as string) === "SHIFTING",
    (e) => (e.event_type as string) === "SHIFTING_END"
  )) {
    const w = summariseWindow(track, open.occurred_at, close.occurred_at, thresholds);
    checks.push({
      checkType: "motion_shifting",
      eventId: open.id ?? null,
      window: w,
      thresholdSource: thresholds.sourceLabel,
      ...judgeShifting(w, thresholds),
    });
  }

  if (checks.length === 0) {
    return [
      unavailable(
        "motion_at_berth",
        null,
        "The confirmed timeline contains no cargo-operation or shifting window to test against the track."
      ),
    ];
  }

  return checks;
}

function judgeCargoOperations(
  w: WindowMotion,
  t: MicroMovementThresholds
): { verdict: MotionVerdict; summary: string } {
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  if (w.coverage < t.minCoverage) {
    return {
      verdict: "inconclusive",
      summary:
        `Only ${pct(w.coverage)} of the ${w.hours.toFixed(1)}h cargo window is covered by AIS ` +
        `(${w.observedFixes} fixes). Too sparse to say what the vessel was doing — sparse ` +
        `coverage is not evidence that she sat still.`,
    };
  }

  // Making way during cargo operations is the decisive contradiction.
  if (w.stateHours.underway > 0.5) {
    return {
      verdict: "contradicted",
      summary:
        `The vessel was making way for ${w.stateHours.underway.toFixed(1)}h during a claimed ` +
        `${w.hours.toFixed(1)}h of cargo operations, travelling up to ` +
        `${Math.round(w.maxExcursionM)}m from where the window began. Cargo cannot be worked ` +
        `under way.`,
    };
  }

  if (w.dominantState === "moored") {
    return {
      verdict: "corroborated",
      summary:
        `The vessel held station for ${w.stateHours.moored.toFixed(1)}h of the ` +
        `${w.hours.toFixed(1)}h claimed (${pct(w.coverage)} observed), moving no more than ` +
        `${Math.round(w.maxExcursionM)}m — consistent with working cargo alongside.`,
    };
  }

  return {
    verdict: "inconclusive",
    summary:
      `The vessel shifted position for ${w.stateHours.shifting.toFixed(1)}h during the claimed ` +
      `cargo window (net ${Math.round(w.netDisplacementM)}m). Consistent with warping along a ` +
      `berth, but not decisive either way.`,
  };
}

function judgeShifting(
  w: WindowMotion,
  t: MicroMovementThresholds
): { verdict: MotionVerdict; summary: string } {
  if (w.coverage < t.minCoverage) {
    return {
      verdict: "inconclusive",
      summary:
        `Only ${Math.round(w.coverage * 100)}% of the claimed ${w.hours.toFixed(1)}h shift is ` +
        `covered by AIS, which cannot confirm or refute that the vessel moved.`,
    };
  }

  const moved = Math.max(w.netDisplacementM, w.maxExcursionM);
  if (moved <= t.mooredDisplacementM) {
    return {
      verdict: "contradicted",
      summary:
        `A ${w.hours.toFixed(1)}h shifting period is claimed, but the vessel moved at most ` +
        `${Math.round(moved)}m — within the ${t.mooredDisplacementM}m a moored vessel shows ` +
        `from warping alone. The track does not support a shift.`,
    };
  }

  return {
    verdict: "corroborated",
    summary:
      `The vessel moved ${Math.round(moved)}m during the claimed ${w.hours.toFixed(1)}h shift, ` +
      `consistent with a genuine change of berth or position.`,
  };
}
