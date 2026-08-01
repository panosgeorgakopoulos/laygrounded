/// <reference types="bun-types" />
// The synthetic track is a dev fixture. Two things must hold: it must be
// REFUSED in production (a fabricated position track is fabricated evidence),
// and it must actually exercise the map branches it exists to exercise —
// otherwise it is a clean line that proves nothing.

import { describe, expect, test } from "bun:test";
import { generateMockAisTrack, isMockAisEnabled } from "./mock-ais-track";
import { deriveMotionSegments } from "@/lib/evidence/micro-movement";

const FROM = "2024-03-04T00:00:00.000Z";
const TO = "2024-03-06T00:00:00.000Z";

describe("gating", () => {
  test("off by default", () => {
    expect(isMockAisEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  test("on when explicitly set outside production", () => {
    expect(
      isMockAisEnabled({ AIS_PROVIDER_URL: "mock", NODE_ENV: "development" } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  test("REFUSED in production even when explicitly set", () => {
    // The load-bearing case. A fabricated track that reached a production claim
    // would be invented evidence in a document somebody relies on.
    expect(
      isMockAisEnabled({ AIS_PROVIDER_URL: "mock", NODE_ENV: "production" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  test("a real provider URL is not mistaken for the mock", () => {
    expect(
      isMockAisEnabled({
        AIS_PROVIDER_URL: "https://ais.example.com/{imo}",
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("determinism", () => {
  test("the same seed draws the same track", () => {
    const a = generateMockAisTrack(FROM, TO, { seed: "claim-1" });
    const b = generateMockAisTrack(FROM, TO, { seed: "claim-1" });
    expect(a).toEqual(b);
  });

  test("different seeds draw different tracks", () => {
    const a = generateMockAisTrack(FROM, TO, { seed: "claim-1" });
    const b = generateMockAisTrack(FROM, TO, { seed: "claim-2" });
    expect(a).not.toEqual(b);
  });

  test("an inverted or malformed window yields nothing rather than throwing", () => {
    expect(generateMockAisTrack(TO, FROM)).toEqual([]);
    expect(generateMockAisTrack("nonsense", TO)).toEqual([]);
  });
});

describe("it exercises the branches it exists for", () => {
  const track = generateMockAisTrack(FROM, TO, { seed: "visual-qa" });
  const segments = deriveMotionSegments(track);

  test("produces a usable number of fixes inside the window", () => {
    expect(track.length).toBeGreaterThan(30);
    for (const f of track) {
      const t = Date.parse(f.at);
      expect(t).toBeGreaterThanOrEqual(Date.parse(FROM));
      expect(t).toBeLessThanOrEqual(Date.parse(TO));
      expect(Number.isFinite(f.lat)).toBe(true);
      expect(Number.isFinite(f.lon)).toBe(true);
    }
  });

  test("contains EXACTLY ONE feed gap — the dashed, unobserved branch", () => {
    // Exactly one, not "at least one". An earlier version spread the shift
    // across proportional steps that exceeded maxGapMinutes on a long claim,
    // so the map drew nine dashed segments where one was intended — and a
    // `> 0` assertion passed the whole time. The count is the property.
    const gaps = segments.filter((s) => s.isGap);
    expect(gaps.length).toBe(1);
    expect(gaps[0].state).toBe("unknown");
  });

  test("no ordinary sampling interval is mistaken for a gap", () => {
    // Every non-gap segment must sit inside the 60-minute threshold, whatever
    // the claim window length — the mock's phases are absolute, not fractions.
    for (const s of segments.filter((x) => !x.isGap)) {
      expect(s.hours).toBeLessThanOrEqual(1);
    }
  });

  test("contains a moored phase and a moving phase", () => {
    const states = new Set(segments.map((s) => s.state));
    expect(states.has("moored")).toBe(true);
    // The run to the berth must classify as movement of some kind, or the
    // shifting colour never appears on the map.
    expect(states.has("shifting") || states.has("underway")).toBe(true);
  });

  test("the track has real extent, so the projection is not a point", () => {
    const lats = track.map((f) => f.lat);
    const lons = track.map((f) => f.lon);
    expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(0.01);
    expect(Math.max(...lons) - Math.min(...lons)).toBeGreaterThan(0.001);
  });

  test("includes a duplicate timestamp, and the engine dedupes it", () => {
    const stamps = track.map((f) => f.at);
    expect(new Set(stamps).size).toBeLessThan(stamps.length);
    // Deduping is the difference between reporting a feed artefact and
    // inventing a hundreds-of-metres jump that reads as "under way".
    for (const s of segments) expect(s.hours).toBeGreaterThan(0);
  });
});
