import { describe, expect, test } from "bun:test";
import {
  resolveWeatherWorkingTime,
  evaluateHour,
  blocksToSofEvents,
  originOf,
  type CargoWeatherProfile,
  type HourlyObservation,
  type WwdResolverInput,
} from "./wwd-resolver";
import { geocodeCandidates } from "@/lib/evidence/weather";

const GRAIN: CargoWeatherProfile = {
  cargoKey: "grain",
  label: "Grain and agribulk",
  precipMmPerHr: 0.2,
  windKn: null, // insensitive
  gustKn: 35,
  minTempC: null,
  maxTempC: null,
  minStoppageMinutes: 60,
  sourceLabel: "test baseline",
  origin: "baseline",
  overriddenDimensions: [],
};

const STEEL: CargoWeatherProfile = {
  ...GRAIN,
  cargoKey: "steel",
  label: "Steel",
  precipMmPerHr: null, // insensitive to rain
  windKn: 40,
  gustKn: 50,
};

const DAY = "2026-03-01";
const at = (h: number) => `${DAY}T${String(h).padStart(2, "0")}:00:00.000Z`;

function obs(h: number, over: Partial<HourlyObservation> = {}): HourlyObservation {
  return {
    at: at(h),
    precipitationMm: 0,
    windSpeedKn: 5,
    windGustKn: 8,
    ...over,
  };
}

/** A calm 12-hour window, with `over` applied to the named hours. */
function hours(overrides: Record<number, Partial<HourlyObservation>> = {}): HourlyObservation[] {
  return Array.from({ length: 12 }, (_, h) => obs(h, overrides[h] ?? {}));
}

function run(over: Partial<WwdResolverInput> = {}) {
  return resolveWeatherWorkingTime({
    window: { from: at(0), to: at(12) },
    hourly: hours(),
    profile: GRAIN,
    ...over,
  });
}

describe("evaluateHour — cargo sensitivity", () => {
  test("rain stops grain", () => {
    const r = evaluateHour(obs(0, { precipitationMm: 0.5 }), GRAIN);
    expect(r.stopped).toBe(true);
    expect(r.dimensions).toEqual(["precipitation"]);
  });

  // The distinction the whole profile concept exists for.
  test("the SAME rain does NOT stop steel", () => {
    expect(evaluateHour(obs(0, { precipitationMm: 0.5 }), STEEL).stopped).toBe(false);
  });

  test("torrential rain still does not stop steel — null means insensitive, not a high number", () => {
    expect(evaluateHour(obs(0, { precipitationMm: 500 }), STEEL).stopped).toBe(false);
  });

  test("wind stops steel but is ignored for grain, which has no wind threshold", () => {
    const windy = obs(0, { windSpeedKn: 45 });
    expect(evaluateHour(windy, STEEL).dimensions).toEqual(["wind"]);
    expect(evaluateHour(windy, GRAIN).stopped).toBe(false);
  });

  test("the threshold is inclusive at the boundary", () => {
    expect(evaluateHour(obs(0, { precipitationMm: 0.2 }), GRAIN).stopped).toBe(true);
    expect(evaluateHour(obs(0, { precipitationMm: 0.199 }), GRAIN).stopped).toBe(false);
  });

  test("several dimensions can fire at once", () => {
    const r = evaluateHour(obs(0, { precipitationMm: 1, windGustKn: 40 }), GRAIN);
    expect(r.dimensions.sort()).toEqual(["gust", "precipitation"]);
  });

  // A null READING and a null THRESHOLD both mean "no", for opposite reasons.
  test("a null reading cannot assert a stoppage", () => {
    expect(evaluateHour(obs(0, { precipitationMm: null }), GRAIN).stopped).toBe(false);
  });

  test("temperature bounds fire when configured", () => {
    const cold: CargoWeatherProfile = { ...GRAIN, minTempC: -5 };
    expect(evaluateHour({ ...obs(0), temperatureC: -10 }, cold).dimensions).toEqual([
      "temperature",
    ]);
    expect(evaluateHour({ ...obs(0), temperatureC: 5 }, cold).stopped).toBe(false);
  });
});

describe("min_stoppage continuity", () => {
  test("a single wet hour meets a 60-minute floor exactly", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }) });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].hours).toBe(1);
    expect(r.totalExceptedHours).toBe(1);
  });

  test("a run shorter than the floor is DISCARDED, and the discard is reported", () => {
    const strict: CargoWeatherProfile = { ...GRAIN, minStoppageMinutes: 120 };
    const r = run({ profile: strict, hourly: hours({ 3: { precipitationMm: 1 } }) });
    expect(r.blocks).toHaveLength(0);
    expect(r.totalExceptedHours).toBe(0);
    expect(r.warnings.some((w) => w.includes("shorter than") && w.includes("120"))).toBe(true);
  });

  test("a run exactly at a 2-hour floor is kept", () => {
    const strict: CargoWeatherProfile = { ...GRAIN, minStoppageMinutes: 120 };
    const r = run({
      profile: strict,
      hourly: hours({ 3: { precipitationMm: 1 }, 4: { precipitationMm: 1 } }),
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].hours).toBe(2);
  });

  test("consecutive wet hours merge into ONE block", () => {
    const r = run({
      hourly: hours({ 2: { precipitationMm: 1 }, 3: { precipitationMm: 2 }, 4: { precipitationMm: 1 } }),
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].hours).toBe(3);
    expect(r.blocks[0].from).toBe(at(2));
    expect(r.blocks[0].to).toBe(at(5));
  });

  test("a dry hour between two wet runs splits them into two blocks", () => {
    const r = run({
      hourly: hours({ 2: { precipitationMm: 1 }, 4: { precipitationMm: 1 } }),
    });
    expect(r.blocks).toHaveLength(2);
    expect(r.totalExceptedHours).toBe(2);
  });

  test("a long run survives a strict floor while its short neighbour does not", () => {
    const strict: CargoWeatherProfile = { ...GRAIN, minStoppageMinutes: 180 };
    const r = run({
      profile: strict,
      hourly: hours({
        1: { precipitationMm: 1 }, // 1h — discarded
        5: { precipitationMm: 1 },
        6: { precipitationMm: 1 },
        7: { precipitationMm: 1 }, // 3h — kept
      }),
    });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].hours).toBe(3);
    expect(r.blocks[0].from).toBe(at(5));
  });

  test("a stoppage running to the end of the window is closed at the window edge", () => {
    const r = run({ hourly: hours({ 10: { precipitationMm: 1 }, 11: { precipitationMm: 1 } }) });
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].to).toBe(at(12));
  });
});

describe("gaps — a missing hour is unknown, never fair weather", () => {
  test("absent readings are reported as gaps", () => {
    const sparse = hours().filter((o) => ![4, 5].includes(new Date(o.at).getUTCHours()));
    const r = run({ hourly: sparse });
    expect(r.gapHours).toBe(2);
    expect(r.gaps).toHaveLength(1);
    expect(r.observedHours).toBe(10);
    expect(r.warnings.some((w) => w.includes("NOT treated as workable"))).toBe(true);
  });

  // The rule that stops the resolver quietly inventing continuity.
  test("a gap SPLITS a stoppage rather than bridging it", () => {
    const list = hours({ 2: { precipitationMm: 1 }, 4: { precipitationMm: 1 } }).filter(
      (o) => new Date(o.at).getUTCHours() !== 3
    );
    const r = run({ hourly: list });
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0].to).toBe(at(3));
    expect(r.blocks[1].from).toBe(at(4));
  });

  test("a gap is never counted as excepted time", () => {
    const r = run({ hourly: [] });
    expect(r.blocks).toHaveLength(0);
    expect(r.totalExceptedHours).toBe(0);
    expect(r.gapHours).toBe(12);
    expect(r.warnings.some((w) => w.includes("No observations at all"))).toBe(true);
  });

  test("out-of-order readings are indexed correctly, not treated as gaps", () => {
    const r = run({ hourly: [...hours()].reverse() });
    expect(r.gapHours).toBe(0);
    expect(r.observedHours).toBe(12);
  });
});

describe("agreement with the SoF", () => {
  const wet = hours({ 3: { precipitationMm: 1 }, 4: { precipitationMm: 1 } });

  test("an exactly-matching claim lands in `both`", () => {
    const r = run({ hourly: wet, claimed: [{ from: at(3), to: at(5) }] });
    expect(r.agreement.both).toEqual([{ from: at(3), to: at(5) }]);
    expect(r.agreement.claimedOnly).toEqual([]);
    expect(r.agreement.resolvedOnly).toEqual([]);
  });

  test("a claim the data does not support is reported, not deleted", () => {
    const r = run({ hourly: wet, claimed: [{ from: at(8), to: at(10) }] });
    expect(r.agreement.claimedOnly).toEqual([{ from: at(8), to: at(10) }]);
    expect(r.agreement.both).toEqual([]);
    // The Master's record is untouched — the resolver reports, never overwrites.
    expect(r.blocks.map((b) => b.from)).toEqual([at(3)]);
  });

  test("a stoppage the SoF missed is surfaced as resolvedOnly", () => {
    const r = run({ hourly: wet, claimed: [] });
    expect(r.agreement.resolvedOnly).toEqual([{ from: at(3), to: at(5) }]);
  });

  test("a partial overlap splits into all three buckets", () => {
    const r = run({ hourly: wet, claimed: [{ from: at(4), to: at(6) }] });
    expect(r.agreement.both).toEqual([{ from: at(4), to: at(5) }]);
    expect(r.agreement.claimedOnly).toEqual([{ from: at(5), to: at(6) }]);
    expect(r.agreement.resolvedOnly).toEqual([{ from: at(3), to: at(4) }]);
  });

  test("overlapping claims are merged before comparison", () => {
    const r = run({
      hourly: wet,
      claimed: [
        { from: at(3), to: at(4) },
        { from: at(3), to: at(5) },
      ],
    });
    expect(r.agreement.both).toEqual([{ from: at(3), to: at(5) }]);
  });
});

describe("reporting", () => {
  test("every block names the threshold and the reading that crossed it", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1.4 } }) });
    const b = r.blocks[0];
    expect(b.reason).toContain("1.4 mm/h");
    expect(b.reason).toContain("0.2 mm/h");
    expect(b.reason).toContain("Grain and agribulk");
    expect(b.dimensions).toEqual(["precipitation"]);
  });

  test("peaks are the maximum across the run, not the first hour", () => {
    const r = run({
      hourly: hours({ 2: { precipitationMm: 0.5 }, 3: { precipitationMm: 9 }, 4: { precipitationMm: 1 } }),
    });
    expect(r.blocks[0].peaks.precipitationMm).toBe(9);
  });

  test("the profile and its provenance travel with the result", () => {
    const r = run();
    expect(r.profile).toEqual({
      cargoKey: "grain",
      label: "Grain and agribulk",
      sourceLabel: "test baseline",
      origin: "baseline",
      overriddenDimensions: [],
    });
  });

  test("a clean window produces no blocks and no warnings about stoppages", () => {
    const r = run();
    expect(r.blocks).toEqual([]);
    expect(r.totalExceptedHours).toBe(0);
    expect(r.gapHours).toBe(0);
  });
});

describe("determinism", () => {
  test("repeated resolution is byte-identical", () => {
    const input = {
      hourly: hours({ 3: { precipitationMm: 1 }, 7: { windGustKn: 40 } }),
      claimed: [{ from: at(3), to: at(4) }],
    };
    expect(JSON.stringify(run(input))).toBe(JSON.stringify(run(input)));
  });

  test("reading order does not affect the outcome", () => {
    const h = hours({ 3: { precipitationMm: 1 }, 4: { precipitationMm: 1 } });
    expect(JSON.stringify(run({ hourly: h }))).toBe(
      JSON.stringify(run({ hourly: [...h].reverse() }))
    );
  });
});

describe("blocksToSofEvents — engine integration", () => {
  // The decision that keeps the charterparty as the final arbiter.
  test("emits WEATHER_DELAY pairs, NEVER EXCEPTED_PERIOD", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }) });
    const events = blocksToSofEvents(r.blocks);
    expect(events.map((e) => e.event_type)).toEqual(["WEATHER_DELAY", "WEATHER_DELAY_END"]);
    for (const e of events) {
      expect(e.event_type).not.toContain("EXCEPTED");
    }
  });

  test("each block becomes exactly one open/close pair at its own boundaries", () => {
    const r = run({
      hourly: hours({ 2: { precipitationMm: 1 }, 6: { precipitationMm: 1 } }),
    });
    const events = blocksToSofEvents(r.blocks);
    expect(events).toHaveLength(4);
    expect(events[0].occurred_at).toBe(at(2));
    expect(events[1].occurred_at).toBe(at(3));
    expect(events[2].occurred_at).toBe(at(6));
    expect(events[3].occurred_at).toBe(at(7));
  });

  test("the opening event carries the reason, so the SoF row explains itself", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }) });
    const [open] = blocksToSofEvents(r.blocks);
    expect(open.raw_text).toContain("mm/h");
  });

  test("no blocks means no events", () => {
    expect(blocksToSofEvents([])).toEqual([]);
  });
});

describe("geocodeCandidates — the 'City, CC' fallback", () => {
  // Regression: claims.port is written as "Rotterdam, NL", and the Open-Meteo
  // geocoder returns nothing for that form while resolving "Rotterdam"
  // instantly. Two of three demo ports were ungeocodable, which silently
  // disabled weather verification AND this resolver for them.
  test("tries the full string first, then the bare city", () => {
    expect(geocodeCandidates("Rotterdam, NL")).toEqual(["Rotterdam, NL", "Rotterdam"]);
    expect(geocodeCandidates("Santos, BR")).toEqual(["Santos, BR", "Santos"]);
  });

  test("a bare name yields a single candidate, not a duplicate", () => {
    expect(geocodeCandidates("Rotterdam")).toEqual(["Rotterdam"]);
  });

  test("handles multi-comma and padded names", () => {
    expect(geocodeCandidates("  Port Hedland , AU ")).toEqual(["Port Hedland , AU", "Port Hedland"]);
  });

  test("an empty name yields nothing to try", () => {
    expect(geocodeCandidates("   ")).toEqual([]);
  });
});

describe("tenant threshold overrides", () => {
  // A tenant whose charterparty says 0.4 mm/h, against our 0.2 baseline.
  const TENANT_LOOSER: CargoWeatherProfile = {
    ...GRAIN,
    precipMmPerHr: 0.4,
    sourceLabel: "Tuned by your company",
    origin: "tenant",
    overriddenDimensions: ["precipitation"],
  };
  const TENANT_TIGHTER: CargoWeatherProfile = {
    ...GRAIN,
    precipMmPerHr: 0.1,
    sourceLabel: "Tuned by your company",
    origin: "tenant",
    overriddenDimensions: ["precipitation"],
  };

  // THE case this feature exists for: one measurement, two answers.
  test("0.3 mm/h stops work on the baseline but NOT on a looser tenant threshold", () => {
    const wet = hours({ 3: { precipitationMm: 0.3 } });
    expect(run({ hourly: wet }).totalExceptedHours).toBe(1); // baseline 0.2 fires
    expect(run({ hourly: wet, profile: TENANT_LOOSER }).totalExceptedHours).toBe(0);
  });

  test("0.15 mm/h is ignored on the baseline but stops work on a tighter tenant threshold", () => {
    const drizzle = hours({ 3: { precipitationMm: 0.15 } });
    expect(run({ hourly: drizzle }).totalExceptedHours).toBe(0); // below baseline 0.2
    expect(run({ hourly: drizzle, profile: TENANT_TIGHTER }).totalExceptedHours).toBe(1);
  });

  test("a wind override changes the answer independently of precipitation", () => {
    const windy = hours({ 3: { windSpeedKn: 25 } });
    // Baseline grain has NO wind threshold, so wind cannot stop it.
    expect(run({ hourly: windy }).totalExceptedHours).toBe(0);
    const tenantWind: CargoWeatherProfile = {
      ...GRAIN,
      windKn: 20,
      origin: "tenant",
      overriddenDimensions: ["wind"],
    };
    expect(run({ hourly: windy, profile: tenantWind }).totalExceptedHours).toBe(1);
  });

  test("a gust override fires where the baseline would not", () => {
    const gusty = hours({ 3: { windGustKn: 30 } }); // baseline gust is 35
    expect(run({ hourly: gusty }).totalExceptedHours).toBe(0);
    const tenantGust: CargoWeatherProfile = {
      ...GRAIN,
      gustKn: 28,
      origin: "tenant",
      overriddenDimensions: ["gust"],
    };
    expect(run({ hourly: gusty, profile: tenantGust }).totalExceptedHours).toBe(1);
  });
});

describe("threshold provenance", () => {
  const TENANT_PRECIP: CargoWeatherProfile = {
    ...GRAIN,
    precipMmPerHr: 0.1,
    gustKn: 35, // untouched — still ours
    origin: "tenant",
    overriddenDimensions: ["precipitation"],
  };

  test("a baseline block attributes every threshold to LayGrounded", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }) });
    const b = r.blocks[0];
    expect(b.usedTenantThreshold).toBe(false);
    expect(b.thresholdSources).toEqual([
      { dimension: "precipitation", threshold: 0.2, origin: "baseline" },
    ]);
    expect(b.reason).toContain("[LayGrounded baseline]");
    expect(b.reason).not.toContain("tenant custom");
  });

  test("a tenant-decided block says so, in the reason a tribunal will read", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }), profile: TENANT_PRECIP });
    const b = r.blocks[0];
    expect(b.usedTenantThreshold).toBe(true);
    expect(b.thresholdSources).toEqual([
      { dimension: "precipitation", threshold: 0.1, origin: "tenant" },
    ]);
    expect(b.reason).toContain("[tenant custom threshold]");
  });

  // The reason per-dimension provenance exists: a partial override must not
  // let an untouched threshold be blamed on the tenant, or vice versa.
  test("an UNTOUCHED dimension is still attributed to the baseline on a tenant profile", () => {
    const r = run({ hourly: hours({ 3: { windGustKn: 40 } }), profile: TENANT_PRECIP });
    const b = r.blocks[0];
    expect(b.dimensions).toEqual(["gust"]);
    expect(b.thresholdSources).toEqual([
      { dimension: "gust", threshold: 35, origin: "baseline" },
    ]);
    expect(b.usedTenantThreshold).toBe(false);
    expect(b.reason).toContain("[LayGrounded baseline]");
  });

  test("a mixed block attributes each dimension separately", () => {
    const r = run({
      hourly: hours({ 3: { precipitationMm: 1, windGustKn: 40 } }),
      profile: TENANT_PRECIP,
    });
    const b = r.blocks[0];
    const byDim = Object.fromEntries(b.thresholdSources.map((s) => [s.dimension, s.origin]));
    expect(byDim).toEqual({ precipitation: "tenant", gust: "baseline" });
    expect(b.usedTenantThreshold).toBe(true);
    expect(b.reason).toContain("[tenant custom threshold]");
    expect(b.reason).toContain("[LayGrounded baseline]");
  });

  test("the resolution carries the profile's origin and which dimensions were tuned", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }), profile: TENANT_PRECIP });
    expect(r.profile.origin).toBe("tenant");
    expect(r.profile.overriddenDimensions).toEqual(["precipitation"]);
  });

  test("a tenant profile warns up front which dimensions are custom", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }), profile: TENANT_PRECIP });
    const w = r.warnings.find((x) => x.includes("TENANT CUSTOM THRESHOLDS"));
    expect(w).toBeDefined();
    expect(w).toContain("precipitation");
    expect(w).toContain("decided by a threshold set by this company");
  });

  // Honesty in the other direction: a tenant override that changed nothing
  // material must not let a counterparty imply the figure was engineered.
  test("a tenant profile whose overrides did NOT decide any block says exactly that", () => {
    const r = run({ hourly: hours({ 3: { windGustKn: 40 } }), profile: TENANT_PRECIP });
    const w = r.warnings.find((x) => x.includes("TENANT CUSTOM THRESHOLDS"));
    expect(w).toContain("No excepted block here was decided by them");
  });

  test("a pure baseline profile raises no tenant warning at all", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }) });
    expect(r.warnings.some((w) => w.includes("TENANT CUSTOM"))).toBe(false);
  });

  test("originOf reports per-dimension attribution directly", () => {
    expect(originOf("precipitation", TENANT_PRECIP)).toBe("tenant");
    expect(originOf("gust", TENANT_PRECIP)).toBe("baseline");
    expect(originOf("precipitation", GRAIN)).toBe("baseline");
  });
});

describe("baseline comparison — making suppression visible", () => {
  const LOOSER: CargoWeatherProfile = {
    ...GRAIN,
    precipMmPerHr: 0.4,
    origin: "tenant",
    overriddenDimensions: ["precipitation"],
  };
  const TIGHTER: CargoWeatherProfile = {
    ...GRAIN,
    precipMmPerHr: 0.1,
    origin: "tenant",
    overriddenDimensions: ["precipitation"],
  };

  // THE failure this exists to prevent. Loosening a threshold until a stoppage
  // vanishes leaves NO trace in the blocks — the result simply reports zero.
  // Without the comparison, three suppressed hours are invisible.
  test("a loosened threshold that REMOVES excepted time reports the removal", () => {
    const wet = hours({ 3: { precipitationMm: 0.3 } });
    const r = run({ hourly: wet, profile: LOOSER, baselineProfile: GRAIN });
    expect(r.totalExceptedHours).toBe(0);
    expect(r.baselineComparison).toEqual({
      baselineExceptedHours: 1,
      tenantExceptedHours: 0,
      deltaHours: -1,
    });
    const w = r.warnings.find((x) => x.includes("TENANT CUSTOM THRESHOLDS"))!;
    expect(w).toContain("REMOVED 1h");
    expect(w).toContain("1h → 0h");
  });

  test("a tightened threshold that ADDS excepted time reports the addition", () => {
    const drizzle = hours({ 3: { precipitationMm: 0.15 } });
    const r = run({ hourly: drizzle, profile: TIGHTER, baselineProfile: GRAIN });
    expect(r.baselineComparison).toEqual({
      baselineExceptedHours: 0,
      tenantExceptedHours: 1,
      deltaHours: 1,
    });
    expect(r.warnings.find((x) => x.includes("TENANT CUSTOM"))!).toContain("ADDED 1h");
  });

  test("an override that changes nothing says so plainly", () => {
    const wet = hours({ 3: { precipitationMm: 5 } }); // over both thresholds
    const r = run({ hourly: wet, profile: LOOSER, baselineProfile: GRAIN });
    expect(r.baselineComparison!.deltaHours).toBe(0);
    expect(r.warnings.find((x) => x.includes("TENANT CUSTOM"))!).toContain(
      "did not change the outcome"
    );
  });

  test("a baseline profile has no comparison to make", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }) });
    expect(r.baselineComparison).toBeNull();
  });

  test("a tenant profile with no baseline supplied degrades honestly", () => {
    const r = run({ hourly: hours({ 3: { precipitationMm: 1 } }), profile: TIGHTER });
    expect(r.baselineComparison).toBeNull();
    expect(r.warnings.find((x) => x.includes("TENANT CUSTOM"))).toBeDefined();
  });

  test("the comparison does not recurse", () => {
    // The inner run omits baselineProfile; a recursive call would blow the stack.
    const r = run({
      hourly: hours({ 3: { precipitationMm: 0.3 } }),
      profile: LOOSER,
      baselineProfile: GRAIN,
    });
    expect(r.baselineComparison).not.toBeNull();
  });
});
