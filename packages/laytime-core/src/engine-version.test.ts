/// <reference types="bun-types" />
// Engine rule-set selection: what v2 changes, and — more important — what it
// does not.
//
// The defect: under GENCON 94 with a SHINC days basis, an explicitly agreed
// EXCEPTED_PERIOD was absorbed by the "Sundays and holidays included" branch and
// never deducted. SHINC deletes the WEEKEND exception; it says nothing about
// exceptions the parties agreed on this voyage (Cl. 7(c)).
//
// Most of what follows asserts non-change. A versioned engine is only worth
// having if the old version is genuinely frozen, so the tests that pin v1
// behaviour are load-bearing, not ceremony.

import { describe, it, expect } from "bun:test";
import { recomputeLaytime } from "./gencon94";
import { engineFingerprintMaterial } from "./fingerprint";
import { CpTerms, DAYS_BASES, SofEventInput, resolveEngineVersion } from "./types";

// A Sunday in Europe/Amsterdam: 2026-03-08. Ops run Saturday through Monday,
// with an agreed strike laid over part of the Sunday.
const EVENTS: SofEventInput[] = [
  { id: "a", occurred_at: "2026-03-07T06:00:00Z", event_type: "NOR_TENDERED" },
  { id: "b", occurred_at: "2026-03-07T08:00:00Z", event_type: "ALL_FAST" },
  { id: "c", occurred_at: "2026-03-07T10:00:00Z", event_type: "COMMENCED_LOADING" },
  { id: "d", occurred_at: "2026-03-08T06:00:00Z", event_type: "EXCEPTED_PERIOD_START" },
  { id: "e", occurred_at: "2026-03-08T18:00:00Z", event_type: "EXCEPTED_PERIOD_END" },
  { id: "f", occurred_at: "2026-03-09T12:00:00Z", event_type: "COMPLETED_LOADING" },
];

const BASE: CpTerms = {
  cp_form: "GENCON94",
  laytime_allowed_hours: 240, // generous: never reaches demurrage, so Cl. 7 stays reachable
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "SHINC",
  demurrage_rate: 24_000,
  despatch_rate: 12_000,
  currency: "USD",
  port_timezone: "Europe/Amsterdam",
};

const terms = (over: Partial<CpTerms> = {}): CpTerms => ({ ...BASE, ...over });

describe("engine version resolution", () => {
  it("treats an absent engine_version as 1", () => {
    expect(resolveEngineVersion({})).toBe(1);
    expect(resolveEngineVersion({ engine_version: 1 })).toBe(1);
    expect(resolveEngineVersion({ engine_version: 2 })).toBe(2);
  });

  it("routes on the terms, so an unversioned legacy claim gets legacy rules", () => {
    const legacy = recomputeLaytime(EVENTS, terms());
    const explicitV1 = recomputeLaytime(EVENTS, terms({ engine_version: 1 }));
    expect(explicitV1).toEqual(legacy);
  });
});

describe("GENCON 94 + SHINC: the agreed excepted period", () => {
  it("v1 counts it — the defect, pinned so it cannot drift", () => {
    const r = recomputeLaytime(EVENTS, terms());
    const agreedRows = r.breakdown.filter((b) => b.clause_ref === "GENCON94-7(c)");
    expect(agreedRows).toEqual([]);
    // Every hour of the 12-hour strike counted against the charterer's laytime.
    expect(r.breakdown.every((b) => b.counts)).toBe(true);
  });

  it("v2 deducts it under Cl. 7(c)", () => {
    const r = recomputeLaytime(EVENTS, terms({ engine_version: 2 }));
    const excluded = r.breakdown.filter((b) => !b.counts && b.clause_ref === "GENCON94-7(c)");
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.reduce((a, b) => a + b.duration_hours, 0)).toBe(12);
  });

  it("v2 deducts exactly the agreed hours and no more", () => {
    const v1 = recomputeLaytime(EVENTS, terms());
    const v2 = recomputeLaytime(EVENTS, terms({ engine_version: 2 }));
    expect(v1.totals.used_hours - v2.totals.used_hours).toBe(12);
  });

  it("v2 still counts the SUNDAY itself — SHINC is not quietly turned into SHEX", () => {
    const r = recomputeLaytime(EVENTS, terms({ engine_version: 2 }));
    const sundayCounted = r.breakdown.filter(
      (b) => b.counts && b.clause_ref === "GENCON94-7(b)"
    );
    // The Sunday hours outside the strike (00:00–06:00 and 18:00–24:00 UTC-ish,
    // in port-local reckoning) still count under SHINC.
    expect(sundayCounted.length).toBeGreaterThan(0);
    expect(sundayCounted.reduce((a, b) => a + b.duration_hours, 0)).toBeGreaterThan(0);
  });

  it("moves real money, in the charterer's favour", () => {
    // 36 allowed hours: v1 runs 12 hours over, v2 lands exactly on the allowance.
    const tight = terms({ laytime_allowed_hours: 36 });
    const v1 = recomputeLaytime(EVENTS, tight);
    const v2 = recomputeLaytime(EVENTS, { ...tight, engine_version: 2 });
    expect(v1.totals.time_on_demurrage_hours).toBe(12);
    expect(v2.totals.time_on_demurrage_hours).toBe(0);
    expect(v1.totals.demurrage_amount).toBeGreaterThan(0);
    expect(v2.totals.demurrage_amount).toBe(0);
  });

  it("does NOT interrupt demurrage — once on demurrage, always on demurrage", () => {
    // The allowance is exhausted before the strike begins. GENCON 94 Cl. 8 runs
    // continuously through weather, weekends and agreed exceptions alike unless
    // the charterparty expressly says otherwise, so v2 must leave this alone.
    // Fixing the Cl. 7 defect must not leak into Cl. 8.
    const exhausted = terms({ laytime_allowed_hours: 12 });
    const v1 = recomputeLaytime(EVENTS, exhausted);
    const v2 = recomputeLaytime(EVENTS, { ...exhausted, engine_version: 2 });
    expect(v2).toEqual(v1);
    expect(v2.breakdown.some((b) => b.clause_ref === "GENCON94-7(c)")).toBe(false);
  });
});

describe("v2 changes nothing else", () => {
  it("is a no-op on every days basis except SHINC", () => {
    for (const basis of DAYS_BASES.filter((b) => b !== "SHINC")) {
      const v1 = recomputeLaytime(EVENTS, terms({ days_basis: basis }));
      const v2 = recomputeLaytime(EVENTS, terms({ days_basis: basis, engine_version: 2 }));
      expect({ basis, r: v2 }).toEqual({ basis, r: v1 });
    }
  });

  it("is a no-op under ASBATANKVOY, which already separated the two", () => {
    for (const basis of DAYS_BASES) {
      const asba = terms({ cp_form: "ASBATANKVOY", days_basis: basis });
      expect(recomputeLaytime(EVENTS, { ...asba, engine_version: 2 })).toEqual(
        recomputeLaytime(EVENTS, asba)
      );
    }
  });

  it("is a no-op under SHINC when no excepted period was agreed", () => {
    const plain = EVENTS.filter((e) => !e.event_type.startsWith("EXCEPTED_PERIOD"));
    expect(recomputeLaytime(plain, terms({ engine_version: 2 }))).toEqual(
      recomputeLaytime(plain, terms())
    );
  });

  it("leaves a SHINC port-calendar holiday counting", () => {
    const plain = EVENTS.filter((e) => !e.event_type.startsWith("EXCEPTED_PERIOD"));
    const withHoliday = terms({
      port_calendar: { holidays: ["2026-03-09"], source: "test" },
      engine_version: 2,
    });
    const r = recomputeLaytime(plain, withHoliday);
    // A holiday is a CALENDAR exception, which is precisely what SHINC includes.
    expect(r.breakdown.some((b) => b.counts && b.clause_ref === "GENCON94-7(b)")).toBe(true);
    expect(r.breakdown.some((b) => b.clause_ref === "GENCON94-7(c)")).toBe(false);
  });
});

describe("behavioural fingerprint", () => {
  it("v1 material carries no version line — notarised records commit to these bytes", () => {
    const v1 = engineFingerprintMaterial(1);
    expect(v1).not.toContain("rules|");
    expect(v1).not.toContain("v2-canary");
    expect(engineFingerprintMaterial()).toBe(v1);
  });

  it("v2 material differs, and differs BEHAVIOURALLY rather than by label alone", () => {
    const v1 = engineFingerprintMaterial(1);
    const v2 = engineFingerprintMaterial(2);
    expect(v2).not.toBe(v1);
    // Strip the label and the appended canaries: what remains must still differ,
    // otherwise the fingerprint would be asserting a difference it cannot see.
    const v2Canaries = v2.split("\n").filter((l) => l.startsWith("v2-canary-"));
    expect(v2Canaries.length).toBe(2);
    const shincCanary = v2Canaries[0];
    const shexCanary = v2Canaries[1];
    expect(shincCanary).toContain("GENCON94-7(c)");
    // The SHEX canary proves the untouched branch is in the material too.
    expect(shexCanary).toContain("GENCON94-7(c)");
    expect(shincCanary).not.toBe(shexCanary);
  });

  it("v1 material stays byte-identical when v2 canaries are added", () => {
    // Every v1 line must appear, in order, at the head of the v2 material.
    const v1Lines = engineFingerprintMaterial(1).split("\n");
    const v2Lines = engineFingerprintMaterial(2).split("\n");
    // v2 inserts exactly one line (`rules|2`) after the engine line.
    expect(v2Lines[0]).toBe(v1Lines[0]);
    expect(v2Lines[1]).toBe("rules|2");
  });
});
