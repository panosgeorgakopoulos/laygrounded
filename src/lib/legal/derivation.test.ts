import { describe, expect, test } from "bun:test";
import {
  generateCryptographicSnapshot,
  verifySnapshot,
  type SnapshotLedger,
} from "./prosecution";
import { buildDerivationRecord, engineFingerprint, ORDERING_RULE } from "./derivation";
import { canonicalEventOrder } from "@laygrounded/laytime-core/gencon94";
import { TZDATA_DIGEST } from "@laygrounded/laytime-core/tzdata";
import { engineFingerprintMaterial } from "@laygrounded/laytime-core/fingerprint";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";

const CLAIM_ID = "11111111-2222-3333-4444-555555555555";

const CP_TERMS: CpTerms = {
  cp_form: "GENCON94",
  laytime_allowed_hours: 72,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "SHEX",
  demurrage_rate: 24_000,
  despatch_rate: 12_000,
  currency: "USD",
  port_timezone: "Europe/Amsterdam",
};

const EVENTS: SofEventInput[] = [
  { id: "e1", occurred_at: "2026-03-02T06:00:00Z", event_type: "NOR_TENDERED" },
  { id: "e2", occurred_at: "2026-03-02T14:00:00Z", event_type: "ALL_FAST" },
  { id: "e3", occurred_at: "2026-03-06T12:00:00Z", event_type: "COMPLETED_LOADING" },
];

function ledger(over: Partial<SnapshotLedger> = {}): SnapshotLedger {
  return {
    cpTerms: CP_TERMS,
    totals: {
      allowed_hours: 72,
      used_hours: 90,
      time_on_demurrage_hours: 18,
      time_saved_hours: 0,
      demurrage_amount: 18_000,
      despatch_amount: 0,
      currency: "USD",
    },
    breakdown: [
      {
        start_time: "2026-03-02T14:00:00.000Z",
        end_time: "2026-03-06T12:00:00.000Z",
        duration_hours: 94,
        status: "laytime",
        counts: true,
        clause_ref: "GENCON94-6",
        reasoning: "Laytime running.",
      },
    ],
    events: EVENTS.map((e) => ({
      id: e.id,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
    })),
    asOf: "2026-07-27T00:00:00.000Z",
    ...over,
  };
}

describe("backward compatibility — the property that protects existing anchors", () => {
  test("a ledger WITHOUT derivation produces the same root it always did", () => {
    // Roots already anchored in compliance_ledger were computed before
    // derivation leaves existed. If adding the field changed the legacy path,
    // every historical proof would stop verifying.
    const legacy = generateCryptographicSnapshot(CLAIM_ID, ledger());
    expect(legacy.leafCount).toBe(
      1 /* header */ + 1 /* cp_terms */ + 1 /* totals */ + EVENTS.length + 1 /* breakdown row */,
    );
    expect(legacy.leaves.some((l) => l.kind === "engine")).toBe(false);
    expect(verifySnapshot(CLAIM_ID, ledger(), legacy.merkleRoot)).toBe(true);
  });

  test("an explicitly undefined derivation is the same as omitting it", () => {
    expect(generateCryptographicSnapshot(CLAIM_ID, ledger({ derivation: undefined })).merkleRoot)
      .toBe(generateCryptographicSnapshot(CLAIM_ID, ledger()).merkleRoot);
  });
});

describe("committing to the derivation", () => {
  const derivation = buildDerivationRecord(EVENTS, CP_TERMS.port_timezone);

  test("three leaves are appended, after the existing ones", () => {
    const snap = generateCryptographicSnapshot(CLAIM_ID, ledger({ derivation }));
    const kinds = snap.leaves.map((l) => l.kind);
    expect(kinds.slice(-3)).toEqual(["engine", "tzdata", "ordering"]);
    // Appending, not interleaving, is what keeps the legacy prefix identical.
    const legacy = generateCryptographicSnapshot(CLAIM_ID, ledger());
    expect(snap.leaves.slice(0, legacy.leafCount).map((l) => l.hash)).toEqual(
      legacy.leaves.map((l) => l.hash),
    );
  });

  test("the root differs from the legacy root", () => {
    expect(generateCryptographicSnapshot(CLAIM_ID, ledger({ derivation })).merkleRoot).not.toBe(
      generateCryptographicSnapshot(CLAIM_ID, ledger()).merkleRoot,
    );
  });

  test("it still verifies against itself", () => {
    const snap = generateCryptographicSnapshot(CLAIM_ID, ledger({ derivation }));
    expect(verifySnapshot(CLAIM_ID, ledger({ derivation }), snap.merkleRoot)).toBe(true);
  });
});

describe("tampering with the derivation breaks the proof", () => {
  const derivation = buildDerivationRecord(EVENTS, CP_TERMS.port_timezone);
  const root = generateCryptographicSnapshot(CLAIM_ID, ledger({ derivation })).merkleRoot;

  test("swapping the engine fingerprint is detected", () => {
    const tampered = structuredClone(derivation);
    tampered.engine.fingerprint = "0".repeat(64);
    expect(verifySnapshot(CLAIM_ID, ledger({ derivation: tampered }), root)).toBe(false);
  });

  test("editing a single timezone transition is detected", () => {
    // The attack this closes: re-run the claim under a doctored tz table so a
    // weekend exclusion falls differently, and present the result as notarized.
    const tampered = structuredClone(derivation);
    expect(tampered.tzdata.transitions.length).toBeGreaterThan(0);
    tampered.tzdata.transitions[1] += 60;
    expect(verifySnapshot(CLAIM_ID, ledger({ derivation: tampered }), root)).toBe(false);
  });

  test("reordering the events is detected", () => {
    const tampered = structuredClone(derivation);
    tampered.ordering.eventIds.reverse();
    expect(verifySnapshot(CLAIM_ID, ledger({ derivation: tampered }), root)).toBe(false);
  });
});

describe("the record's contents", () => {
  test("carries the zone's own transitions, not the whole table", () => {
    const d = buildDerivationRecord(EVENTS, "Europe/Amsterdam");
    expect(d.tzdata.zone).toBe("Europe/Amsterdam");
    expect(d.tzdata.transitions.length).toBeGreaterThan(0);
    // Under a kilobyte for the zone, versus ~200 KB for all 463.
    expect(JSON.stringify(d.tzdata.transitions).length).toBeLessThan(2000);
    expect(d.tzdata.digest).toBe(TZDATA_DIGEST);
  });

  test("an absent port timezone is recorded as null, and resolves UTC", () => {
    // Honest about the fact that the claim had no zone, rather than asserting
    // one it never had.
    const d = buildDerivationRecord(EVENTS, null);
    expect(d.tzdata.zone).toBeNull();
    expect(d.tzdata.transitions.length).toBeGreaterThan(0);
  });

  test("pins the ordering actually used, in canonical order", () => {
    const ordered = canonicalEventOrder(EVENTS);
    const d = buildDerivationRecord(ordered, CP_TERMS.port_timezone);
    expect(d.ordering.eventIds).toEqual(ordered.map((e) => e.id));
    expect(d.ordering.rule).toBe(ORDERING_RULE);
  });

  test("the ordering rule is stated, so a third party can reimplement it", () => {
    expect(ORDERING_RULE).toContain("occurred_at");
    expect(ORDERING_RULE).toContain("terminators");
    expect(ORDERING_RULE).toContain("id");
  });
});

describe("engine fingerprint", () => {
  test("is a stable sha256 across calls", () => {
    expect(engineFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(engineFingerprint()).toBe(engineFingerprint());
  });

  test("is behavioural — it embeds the pinned tzdata digest", () => {
    // A different timezone table is a different engine as far as the answer is
    // concerned, even with byte-identical code.
    expect(engineFingerprintMaterial()).toContain(TZDATA_DIGEST);
  });
});
