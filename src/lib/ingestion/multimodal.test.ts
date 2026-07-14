import { describe, expect, test } from "bun:test";
import {
  auditTimelineAgainstAis,
  extractSofTimeline,
  GEOFENCE_CLAUSE_REF,
  haversineNm,
  positionAt,
  verifyEventAgainstGeofence,
  type AisFix,
  type PortGeofence,
} from "./multimodal";

// === extractSofTimeline ===

const SOF_TEXT = `STATEMENT OF FACTS — MV IRON DUKE
2026-03-01 08:20 +03:00 VESSEL ARRIVED PILOT STATION
01.03.2026 09:00 NOTICE OF READINESS TENDERED
01.03.2026 14:30 VESSEL BERTHED
01.03.2026 15:10 ALL FAST
02.03.2026 06:00 COMMENCED LOADING
03.03.2026 11:00 WORK SUSPENDED DUE TO HEAVY RAIN
03.03.2026 15:30 RAIN CEASED WORK RESUMED
05.03.2026 18:45 COMPLETED LOADING
Master signed without prejudice`;

describe("extractSofTimeline", () => {
  test("extracts a realistic SoF chronology with naive DD.MM.YYYY timestamps", () => {
    const r = extractSofTimeline(SOF_TEXT, { defaultUtcOffset: "+03:00" });
    expect(r.events.map((e) => e.event_type)).toEqual([
      "NOR_TENDERED",
      "BERTHED",
      "ALL_FAST",
      "COMMENCED_LOADING",
      "WEATHER_DELAY",
      "WEATHER_DELAY_END",
      "COMPLETED_LOADING",
    ]);
    expect(r.events[0].occurred_at).toBe("2026-03-01T09:00:00+03:00");
    expect(r.events[6].occurred_at).toBe("2026-03-05T18:45:00+03:00");
    expect(r.matchedLines).toBe(7);
    expect(r.warnings).toHaveLength(0);
    // Chronological order and source-line traceability.
    expect(r.events[4].raw_text).toContain("HEAVY RAIN");
    expect(r.events[4].line).toBe(7);
  });

  test("accepts ISO timestamps with explicit offsets as-is", () => {
    const r = extractSofTimeline("Loading commenced 2026-03-02T06:00:00+02:00");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      event_type: "COMMENCED_LOADING",
      occurred_at: "2026-03-02T06:00:00+02:00",
    });
  });

  test("refuses to guess a timezone for naive timestamps", () => {
    const r = extractSofTimeline("01.03.2026 09:00 NOR TENDERED");
    expect(r.events).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("defaultUtcOffset");
  });

  test("warns about event lines with no timestamp instead of inventing one", () => {
    const r = extractSofTimeline("VESSEL BERTHED IN THE MORNING", {
      defaultUtcOffset: "+03:00",
    });
    expect(r.events).toHaveLength(0);
    expect(r.warnings[0]).toContain("BERTHED");
  });

  test("rejects implausible day-month combinations", () => {
    const r = extractSofTimeline("25.13.2026 09:00 NOR TENDERED", {
      defaultUtcOffset: "+03:00",
    });
    expect(r.events).toHaveLength(0);
    expect(r.warnings[0]).toContain("implausible");
  });
});

// === geofencing ===

describe("haversineNm", () => {
  test("zero for the same point, ~60 nm per degree of latitude", () => {
    expect(haversineNm(36, 24, 36, 24)).toBe(0);
    expect(haversineNm(0, 0, 1, 0)).toBeCloseTo(60.04, 1);
  });
});

describe("positionAt", () => {
  const track: AisFix[] = [
    { at: "2026-03-01T00:00:00Z", lat: 10.0, lon: 20.0 },
    { at: "2026-03-01T02:00:00Z", lat: 10.2, lon: 20.2 },
  ];

  test("interpolates linearly between bracketing fixes", () => {
    const p = positionAt(track, "2026-03-01T01:00:00Z");
    expect(p).not.toBeNull();
    expect(p!.method).toBe("interpolated");
    expect(p!.lat).toBeCloseTo(10.1, 6);
    expect(p!.lon).toBeCloseTo(20.1, 6);
    expect(p!.gapHours).toBe(2);
  });

  test("returns the exact fix when the timestamp matches", () => {
    const p = positionAt(track, "2026-03-01T02:00:00Z");
    expect(p!.method).toBe("exact");
    expect(p!.lat).toBe(10.2);
  });

  test("falls back to the nearest fix within half the max gap", () => {
    const p = positionAt(track, "2026-03-01T04:00:00Z"); // 2h after last fix
    expect(p!.method).toBe("nearest");
    expect(p!.lat).toBe(10.2);
  });

  test("returns null when the track is too thin to say", () => {
    expect(positionAt(track, "2026-03-01T09:00:00Z")).toBeNull(); // 7h gap
    expect(positionAt([], "2026-03-01T01:00:00Z")).toBeNull();
  });
});

describe("verifyEventAgainstGeofence", () => {
  const fence: PortGeofence = { lat: 36.0, lon: 24.0 };
  // ~14.6 nm east of the port center.
  const offshore: AisFix[] = [{ at: "2026-03-01T10:00:00Z", lat: 36.0, lon: 24.3 }];
  // ~7.3 nm east — outside the basin, inside the anchorage.
  const roads: AisFix[] = [{ at: "2026-03-01T10:00:00Z", lat: 36.0, lon: 24.15 }];

  test("flags BERTHED outside the breakwater as a discrepancy", () => {
    const c = verifyEventAgainstGeofence(
      { event_type: "BERTHED", occurred_at: "2026-03-01T10:00:00Z" },
      offshore,
      fence
    );
    expect(c!.verdict).toBe("discrepancy");
    expect(c!.distanceNm!).toBeCloseTo(14.6, 0);
    expect(c!.allowedRadiusNm).toBe(3);
    expect(c!.summary).toContain("Geofence discrepancy");
  });

  test("NOR at the anchorage passes the wider fence that BERTHED would fail", () => {
    const nor = verifyEventAgainstGeofence(
      { event_type: "NOR_TENDERED", occurred_at: "2026-03-01T10:00:00Z" },
      roads,
      fence
    );
    expect(nor!.verdict).toBe("verified");
    expect(nor!.allowedRadiusNm).toBe(12);
    const berthed = verifyEventAgainstGeofence(
      { event_type: "BERTHED", occurred_at: "2026-03-01T10:00:00Z" },
      roads,
      fence
    );
    expect(berthed!.verdict).toBe("discrepancy");
  });

  test("returns unverifiable when no AIS fix is close enough", () => {
    const c = verifyEventAgainstGeofence(
      { event_type: "BERTHED", occurred_at: "2026-03-02T10:00:00Z" },
      offshore,
      fence
    );
    expect(c!.verdict).toBe("unverifiable");
    expect(c!.distanceNm).toBeNull();
  });

  test("weather and shifting events are not position-bound", () => {
    expect(
      verifyEventAgainstGeofence(
        { event_type: "WEATHER_DELAY", occurred_at: "2026-03-01T10:00:00Z" },
        offshore,
        fence
      )
    ).toBeNull();
  });
});

describe("auditTimelineAgainstAis", () => {
  test("tallies verdicts and emits critical flags only for discrepancies", () => {
    const fence: PortGeofence = { lat: 36.0, lon: 24.0 };
    const track: AisFix[] = [
      { at: "2026-03-01T08:00:00Z", lat: 36.0, lon: 24.15 }, // at the roads
      { at: "2026-03-01T14:00:00Z", lat: 36.0, lon: 24.01 }, // in the basin
    ];
    const events = [
      { id: "e1", event_type: "NOR_TENDERED" as const, occurred_at: "2026-03-01T08:00:00Z" },
      // SoF says berthed at 09:00 — AIS still has the hull ~6 nm out.
      { id: "e2", event_type: "BERTHED" as const, occurred_at: "2026-03-01T09:00:00Z" },
      { id: "e3", event_type: "COMMENCED_LOADING" as const, occurred_at: "2026-03-01T14:00:00Z" },
      { id: "e4", event_type: "WEATHER_DELAY" as const, occurred_at: "2026-03-01T15:00:00Z" },
      { id: "e5", event_type: "COMPLETED_LOADING" as const, occurred_at: "2026-03-02T23:00:00Z" },
    ];
    const audit = auditTimelineAgainstAis(events, track, fence);
    expect(audit.verified).toBe(2); // NOR at the roads, loading in the basin
    expect(audit.discrepancies).toBe(1); // the premature BERTHED
    expect(audit.unverifiable).toBe(1); // completion far past the track
    expect(audit.skipped).toBe(1); // weather is not position-bound
    expect(audit.flags).toHaveLength(1);
    expect(audit.flags[0]).toMatchObject({
      clause_ref: GEOFENCE_CLAUSE_REF,
      severity: "critical",
    });
    expect(audit.flags[0].event.id).toBe("e2");
  });
});
