// Autopilot SoF ingestion + AIS geofencing — the pure halves.
//
// Two capabilities behind the zero-touch data-entry pipeline:
//   * extractSofTimeline — a deterministic, line-based extractor that turns
//     already-parsed multimodal text (a PDF text layer, an OCR pass, a
//     forwarded email body) into timeline event candidates. Deliberately NOT
//     an AI call, for the same reason as the recap parser: this path must be
//     instant, free, and reproducible; the Claude-vision pipeline in
//     src/lib/ai/extraction.ts remains the high-fidelity route for scanned
//     documents. Anything the extractor cannot date with an explicit
//     timezone is reported in warnings, never guessed.
//   * verifyEventAgainstGeofence / auditTimelineAgainstAis — cross-reference
//     each position-bound SoF event against the vessel's AIS track: if the
//     SoF says "berthed 10:00" but AIS puts the hull outside the breakwater,
//     the event gets a Geofence Discrepancy verdict before anyone relies on
//     it. Verdicts are three-state (verified / discrepancy / unverifiable) —
//     a thin AIS track yields "unverifiable", never a silent pass.
//
// Pure module: no I/O, no Supabase; the routes own persistence and flags.

import type { EventTypeEnum } from "@/lib/laytime/types";

// === SoF text extraction ===

export interface ExtractedSofEvent {
  event_type: EventTypeEnum;
  occurred_at: string; // ISO 8601 with explicit offset
  raw_text: string;
  line: number; // 1-based line number in the source text
}

export interface SofTextExtraction {
  events: ExtractedSofEvent[];
  warnings: string[];
  matchedLines: number;
  totalLines: number;
}

const OFFSET_ONLY_RE = /^(?:Z|[+-]\d{2}:?\d{2})$/;

// Keyword rules, first match wins. Order is load-bearing:
//   * END-side weather/shifting phrases before their START counterparts
//     ("rain ceased, work resumed" contains RAIN too);
//   * ALL FAST before BERTHED ("all fast alongside");
//   * COMPLETED before COMMENCED never conflicts (disjoint verbs).
const EVENT_RULES: Array<{ event: EventTypeEnum; re: RegExp }> = [
  { event: "NOR_TENDERED", re: /\bNOR\b|NOTICE OF READINESS/ },
  { event: "ALL_FAST", re: /ALL (?:MADE )?FAST/ },
  { event: "SHIFTING_END", re: /(?:COMPLETED|FINISHED) SHIFTING|SHIFTING COMPLETED/ },
  { event: "SHIFTING", re: /COMMENCED SHIFTING|SHIFTING COMMENCED|SHIFTED (?:FROM|TO)/ },
  { event: "BERTHED", re: /BERTHED|ALONGSIDE/ },
  { event: "COMPLETED_LOADING", re: /(?:COMPLETED|FINISHED) LOADING|LOADING COMPLETED/ },
  { event: "COMPLETED_DISCHARGE", re: /(?:COMPLETED|FINISHED) DISCH|DISCHARGE COMPLETED/ },
  { event: "COMMENCED_LOADING", re: /(?:COMMENCED|STARTED) LOADING|LOADING COMMENCED/ },
  { event: "COMMENCED_DISCHARGE", re: /(?:COMMENCED|STARTED) DISCH|DISCHARGE COMMENCED/ },
  {
    event: "WEATHER_DELAY_END",
    re: /(?:RAIN|WEATHER|WIND|SWELL)[^\n]*(?:CEASED|ENDED|ABATED)|RESUMED/,
  },
  {
    event: "WEATHER_DELAY",
    re: /(?:RAIN|HEAVY WEATHER|WEATHER|WIND|SWELL)[^\n]*(?:STOPPED|SUSPENDED)|(?:STOPPED|SUSPENDED)[^\n]*(?:RAIN|WEATHER|WIND|SWELL)|RAIN (?:COMMENCED|STARTED)/,
  },
  { event: "HATCH_OPEN", re: /HATCH(?:ES)? OPEN/ },
  { event: "HATCH_CLOSE", re: /HATCH(?:ES)? CLOSED/ },
];

const ISO_WITH_OFFSET_RE =
  /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)\s?(Z|[+-]\d{2}:?\d{2})/;
const ISO_NAIVE_RE = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)\b/;
// Maritime SoF convention: day first ("01.03.2026 14:30", "01/03/2026 1430").
const DMY_RE = /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\s+(\d{2}):?(\d{2})\b/;

const pad = (n: number) => String(n).padStart(2, "0");

// Extracts the line's timestamp as ISO-with-offset. Naive timestamps get
// defaultUtcOffset (the port's UTC offset, supplied by the caller); without
// one they are rejected — a guessed timezone is worse than no event.
function parseLineTimestamp(
  line: string,
  defaultUtcOffset: string | undefined
): { iso: string } | { error: string } | null {
  const withOffset = line.match(ISO_WITH_OFFSET_RE);
  if (withOffset) {
    const iso = `${withOffset[1]}T${withOffset[2].length === 5 ? `${withOffset[2]}:00` : withOffset[2]}${withOffset[3]}`;
    return Number.isNaN(Date.parse(iso)) ? { error: `unparseable timestamp "${withOffset[0]}"` } : { iso };
  }

  let datePart: string | null = null;
  let timePart: string | null = null;
  const naiveIso = line.match(ISO_NAIVE_RE);
  const dmy = line.match(DMY_RE);
  if (naiveIso) {
    datePart = naiveIso[1];
    timePart = naiveIso[2].length === 5 ? `${naiveIso[2]}:00` : naiveIso[2];
  } else if (dmy) {
    const [, dd, mm, yyyy, hh, min] = dmy;
    if (Number(mm) > 12 || Number(dd) > 31) return { error: `implausible date "${dmy[0]}"` };
    datePart = `${yyyy}-${pad(Number(mm))}-${pad(Number(dd))}`;
    timePart = `${hh}:${min}:00`;
  }
  if (!datePart || !timePart) return null;

  if (!defaultUtcOffset || !OFFSET_ONLY_RE.test(defaultUtcOffset)) {
    return {
      error: `naive timestamp "${datePart} ${timePart.slice(0, 5)}" skipped — supply defaultUtcOffset (the port's UTC offset) to ingest it`,
    };
  }
  const iso = `${datePart}T${timePart}${defaultUtcOffset}`;
  return Number.isNaN(Date.parse(iso)) ? { error: `unparseable timestamp "${datePart} ${timePart}"` } : { iso };
}

export function extractSofTimeline(
  text: string,
  opts: { defaultUtcOffset?: string } = {}
): SofTextExtraction {
  const lines = text.split(/\r?\n/);
  const events: ExtractedSofEvent[] = [];
  const warnings: string[] = [];
  let matchedLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const upper = raw.toUpperCase();
    const rule = EVENT_RULES.find((r) => r.re.test(upper));
    if (!rule) continue;
    matchedLines++;

    const ts = parseLineTimestamp(raw, opts.defaultUtcOffset);
    if (!ts) {
      warnings.push(`line ${i + 1}: "${raw.slice(0, 60)}" looks like ${rule.event} but carries no timestamp`);
      continue;
    }
    if ("error" in ts) {
      warnings.push(`line ${i + 1}: ${ts.error}`);
      continue;
    }
    events.push({
      event_type: rule.event,
      occurred_at: ts.iso,
      raw_text: raw.slice(0, 300),
      line: i + 1,
    });
  }

  events.sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  return { events, warnings, matchedLines, totalLines: lines.length };
}

// === AIS geofencing ===

export interface AisFix {
  at: string; // ISO 8601
  lat: number;
  lon: number;
}

export interface PortGeofence {
  lat: number;
  lon: number;
}

export interface GeofenceOptions {
  // Berth/harbor-basin radius: events that require the vessel IN the port.
  portRadiusNm?: number;
  // Anchorage/roads radius: NOR under WIBON is legitimately tendered outside
  // the breakwater, so it gets the wider fence.
  anchorageRadiusNm?: number;
  // AIS fixes further apart than this cannot support a verdict.
  maxAisGapHours?: number;
}

export const GEOFENCE_DEFAULTS = {
  PORT_RADIUS_NM: 3,
  ANCHORAGE_RADIUS_NM: 12,
  MAX_AIS_GAP_HOURS: 6,
} as const;

// Event types that pin the hull to a location, and which fence applies.
export const GEOFENCED_EVENT_TYPES: Partial<Record<EventTypeEnum, "port" | "anchorage">> = {
  NOR_TENDERED: "anchorage",
  BERTHED: "port",
  ALL_FAST: "port",
  HATCH_OPEN: "port",
  HATCH_CLOSE: "port",
  COMMENCED_LOADING: "port",
  COMPLETED_LOADING: "port",
  COMMENCED_DISCHARGE: "port",
  COMPLETED_DISCHARGE: "port",
};

const EARTH_RADIUS_NM = 3440.065;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface InterpolatedPosition {
  lat: number;
  lon: number;
  method: "exact" | "interpolated" | "nearest";
  gapHours: number;
}

// Vessel position at a timestamp from its AIS track. Bracketing fixes no
// more than maxGapHours apart → linear interpolation; a single fix within
// maxGapHours/2 → nearest; otherwise null (the track cannot say).
export function positionAt(
  history: AisFix[],
  atISO: string,
  maxGapHours: number = GEOFENCE_DEFAULTS.MAX_AIS_GAP_HOURS
): InterpolatedPosition | null {
  const t = new Date(atISO).getTime();
  if (Number.isNaN(t) || history.length === 0) return null;
  const track = history
    .map((f) => ({ ...f, ms: new Date(f.at).getTime() }))
    .filter((f) => !Number.isNaN(f.ms) && Number.isFinite(f.lat) && Number.isFinite(f.lon))
    .sort((a, b) => a.ms - b.ms);
  if (track.length === 0) return null;

  let before: (typeof track)[number] | null = null;
  let after: (typeof track)[number] | null = null;
  for (const fix of track) {
    if (fix.ms <= t) before = fix;
    if (fix.ms >= t) {
      after = fix;
      break;
    }
  }

  const HOUR = 3600_000;
  if (before && after) {
    if (before.ms === after.ms) {
      return { lat: before.lat, lon: before.lon, method: "exact", gapHours: 0 };
    }
    const gapHours = (after.ms - before.ms) / HOUR;
    if (gapHours <= maxGapHours) {
      const w = (t - before.ms) / (after.ms - before.ms);
      return {
        lat: before.lat + (after.lat - before.lat) * w,
        lon: before.lon + (after.lon - before.lon) * w,
        method: "interpolated",
        gapHours,
      };
    }
  }
  const nearest = before ?? after;
  if (nearest) {
    const gapHours = Math.abs(t - nearest.ms) / HOUR;
    if (gapHours <= maxGapHours / 2) {
      return { lat: nearest.lat, lon: nearest.lon, method: "nearest", gapHours };
    }
  }
  return null;
}

export type GeofenceVerdict = "verified" | "discrepancy" | "unverifiable";

export interface GeofenceCheck {
  verdict: GeofenceVerdict;
  distanceNm: number | null;
  allowedRadiusNm: number | null;
  method: InterpolatedPosition["method"] | null;
  summary: string;
}

// Cross-references one SoF event against the AIS track. Returns null for
// event types that do not pin the hull to a location (weather, shifting,
// excepted periods) — those are matters of record, not of position.
export function verifyEventAgainstGeofence(
  event: { event_type: EventTypeEnum; occurred_at: string },
  aisHistory: AisFix[],
  fence: PortGeofence,
  opts: GeofenceOptions = {}
): GeofenceCheck | null {
  const fenceKind = GEOFENCED_EVENT_TYPES[event.event_type];
  if (!fenceKind) return null;

  const allowedRadiusNm =
    fenceKind === "port"
      ? opts.portRadiusNm ?? GEOFENCE_DEFAULTS.PORT_RADIUS_NM
      : opts.anchorageRadiusNm ?? GEOFENCE_DEFAULTS.ANCHORAGE_RADIUS_NM;
  const pos = positionAt(
    aisHistory,
    event.occurred_at,
    opts.maxAisGapHours ?? GEOFENCE_DEFAULTS.MAX_AIS_GAP_HOURS
  );
  if (!pos) {
    return {
      verdict: "unverifiable",
      distanceNm: null,
      allowedRadiusNm,
      method: null,
      summary: `No AIS fix close enough to ${event.event_type} at ${event.occurred_at} — position unverifiable.`,
    };
  }

  const distanceNm = haversineNm(pos.lat, pos.lon, fence.lat, fence.lon);
  const rounded = Math.round(distanceNm * 10) / 10;
  if (distanceNm <= allowedRadiusNm) {
    return {
      verdict: "verified",
      distanceNm: rounded,
      allowedRadiusNm,
      method: pos.method,
      summary: `AIS places the vessel ${rounded} nm from the port center at ${event.event_type} (allowed ${allowedRadiusNm} nm) — corroborated.`,
    };
  }
  return {
    verdict: "discrepancy",
    distanceNm: rounded,
    allowedRadiusNm,
    method: pos.method,
    summary: `Geofence discrepancy: SoF records ${event.event_type} at ${event.occurred_at}, but AIS places the vessel ${rounded} nm from the port center (allowed ${allowedRadiusNm} nm).`,
  };
}

export const GEOFENCE_CLAUSE_REF = "AIS-GEOFENCE";

export interface TimelineAuditResult<T> {
  checks: Array<{ event: T; check: GeofenceCheck }>;
  verified: number;
  discrepancies: number;
  unverifiable: number;
  skipped: number; // events that are not position-bound
  // Ready-to-insert clause flag payloads for the discrepancies.
  flags: Array<{ event: T; clause_ref: string; severity: "critical"; note: string }>;
}

export function auditTimelineAgainstAis<
  T extends { event_type: EventTypeEnum; occurred_at: string },
>(
  events: T[],
  aisHistory: AisFix[],
  fence: PortGeofence,
  opts: GeofenceOptions = {}
): TimelineAuditResult<T> {
  const result: TimelineAuditResult<T> = {
    checks: [],
    verified: 0,
    discrepancies: 0,
    unverifiable: 0,
    skipped: 0,
    flags: [],
  };
  for (const event of events) {
    const check = verifyEventAgainstGeofence(event, aisHistory, fence, opts);
    if (!check) {
      result.skipped++;
      continue;
    }
    result.checks.push({ event, check });
    if (check.verdict === "verified") result.verified++;
    else if (check.verdict === "unverifiable") result.unverifiable++;
    else {
      result.discrepancies++;
      result.flags.push({
        event,
        clause_ref: GEOFENCE_CLAUSE_REF,
        severity: "critical",
        note: check.summary,
      });
    }
  }
  return result;
}
