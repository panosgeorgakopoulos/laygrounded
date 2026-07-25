import { describe, it, expect } from "bun:test";
import { normalizeBunkerQuote } from "./bunker";
import { haversineNm, deriveTelemetryFromAisTrack } from "./ais-telemetry";

describe("normalizeBunkerQuote", () => {
  it("reads a flat grade→price map", () => {
    expect(normalizeBunkerQuote({ VLSFO: 620, HFO: 480 }, "VLSFO")).toBe(620);
    expect(normalizeBunkerQuote({ VLSFO: 620, HFO: 480 }, "HFO")).toBe(480);
  });

  it("reads a flat map with nested price objects and aliases", () => {
    expect(normalizeBunkerQuote({ ifo380: { price: 475 } }, "HFO")).toBe(475);
    expect(normalizeBunkerQuote({ "gas oil": { usd_per_mt: 790 } }, "MGO")).toBe(790);
  });

  it("reads an array of quotes under an envelope key", () => {
    const payload = {
      data: [
        { grade: "VLSFO", usd_per_mt: 615 },
        { grade: "MGO", usd_per_mt: 800 },
      ],
    };
    expect(normalizeBunkerQuote(payload, "VLSFO")).toBe(615);
    expect(normalizeBunkerQuote(payload, "MGO")).toBe(800);
  });

  it("parses string prices", () => {
    expect(normalizeBunkerQuote([{ fuel: "LNG", price: "540.5" }], "LNG")).toBe(540.5);
  });

  it("returns null when the fuel is absent or the price is nonsense — never a guess", () => {
    expect(normalizeBunkerQuote({ HFO: 480 }, "LNG")).toBeNull();
    expect(normalizeBunkerQuote({ VLSFO: -5 }, "VLSFO")).toBeNull();
    expect(normalizeBunkerQuote(null, "VLSFO")).toBeNull();
    expect(normalizeBunkerQuote("not an object", "VLSFO")).toBeNull();
  });
});

describe("haversineNm", () => {
  it("is zero for identical points", () => {
    expect(haversineNm({ lat: 1, lon: 2 }, { lat: 1, lon: 2 })).toBeCloseTo(0, 5);
  });

  it("1 degree of latitude ≈ 60 nm", () => {
    expect(haversineNm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(60, 0);
  });

  it("Singapore → Rotterdam ≈ 5,700 nm great-circle (straight line, not the ~8,300 nm sea route)", () => {
    const d = haversineNm({ lat: 1.29, lon: 103.85 }, { lat: 51.95, lon: 4.14 });
    expect(d).toBeGreaterThan(5400);
    expect(d).toBeLessThan(6000);
  });
});

describe("deriveTelemetryFromAisTrack", () => {
  const port = { lat: 0, lon: 0 };

  it("derives speed from the latest usable fix pair and distance to port", () => {
    // Two fixes 1 hour apart, 12 nm of longitude ~ at the equator → ~12 kn.
    const track = [
      { at: "2026-01-01T00:00:00Z", lat: 0, lon: 1.0 },
      { at: "2026-01-01T01:00:00Z", lat: 0, lon: 0.8 },
    ];
    const t = deriveTelemetryFromAisTrack(track, port)!;
    expect(t).not.toBeNull();
    expect(t.currentSpeedKnots).toBeGreaterThan(10);
    expect(t.currentSpeedKnots).toBeLessThan(14);
    // Latest fix at lon 0.8 ≈ 48 nm from port at (0,0).
    expect(t.distanceToPortNm).toBeGreaterThan(40);
    expect(t.distanceToPortNm).toBeLessThan(56);
    expect(t.asOf).toBe("2026-01-01T01:00:00Z");
  });

  it("skips a jittery near-zero-dt pair for an earlier plausible one", () => {
    const track = [
      { at: "2026-01-01T00:00:00Z", lat: 0, lon: 0.5 },
      { at: "2026-01-01T01:00:00Z", lat: 0, lon: 0.3 },
      { at: "2026-01-01T01:00:10Z", lat: 0, lon: 0.3001 }, // 10s later → skipped
    ];
    const t = deriveTelemetryFromAisTrack(track, port)!;
    expect(t).not.toBeNull();
    expect(t.currentSpeedKnots).toBeLessThan(30);
  });

  it("returns null for a track that is too thin", () => {
    expect(deriveTelemetryFromAisTrack([{ at: "2026-01-01T00:00:00Z", lat: 0, lon: 1 }], port)).toBeNull();
    expect(deriveTelemetryFromAisTrack([], port)).toBeNull();
  });
});
