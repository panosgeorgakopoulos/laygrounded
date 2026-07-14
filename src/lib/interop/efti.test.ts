import { describe, expect, test } from "bun:test";
import {
  buildEftiConsignment,
  verifyEftiConsignment,
  EFTI_SCHEMA_VERSION,
  EFTI_SIGNATURE_ALGO,
  type EftiConsignmentInput,
} from "./efti";

const input = (overrides: Partial<EftiConsignmentInput> = {}): EftiConsignmentInput => ({
  claim: {
    id: "claim-1",
    vessel: "MV IRON DUKE",
    vesselImo: "9700001",
    voyageRef: "V-2026-031",
    port: "Piraeus",
    cargo: "72,000 MT iron ore",
    counterpartyName: "Aegean Chartering SA",
  },
  events: [
    { event_type: "NOR_TENDERED", occurred_at: "2026-03-01T09:00:00+03:00", ais_geofence_verified: true },
    { event_type: "BERTHED", occurred_at: "2026-03-01T14:30:00+03:00", ais_geofence_verified: false },
    { event_type: "WEATHER_DELAY", occurred_at: "2026-03-03T11:00:00+03:00" },
    { event_type: "COMPLETED_LOADING", occurred_at: "2026-03-05T18:45:00+03:00" },
  ],
  totals: {
    allowed_hours: 72,
    used_hours: 96.5,
    demurrage_amount: 24_500,
    despatch_amount: 0,
    currency: "USD",
  },
  anchorMerkleRoot: "ab".repeat(32),
  generatedAt: "2026-03-10T12:00:00Z",
  ...overrides,
});

describe("buildEftiConsignment", () => {
  test("exports port-call milestones and excludes laytime internals", () => {
    const c = buildEftiConsignment(input());
    expect(c.schema).toBe(EFTI_SCHEMA_VERSION);
    expect(c.port_call.milestones.map((m) => m.code)).toEqual([
      "NOTICE_OF_READINESS",
      "ARRIVAL_AT_BERTH",
      "LOADING_COMPLETED",
    ]);
    // Geofence verdicts travel with the milestones; unchecked → null.
    expect(c.port_call.milestones.map((m) => m.geofence_verified)).toEqual([true, false, null]);
    expect(c.transport_movement.vessel_imo).toBe("9700001");
    expect(c.laytime_summary?.demurrage_amount).toBe(24_500);
  });

  test("signs the payload and anchors it to the notarized Merkle root", () => {
    const c = buildEftiConsignment(input());
    expect(c.integrity.algo).toBe(EFTI_SIGNATURE_ALGO);
    expect(c.integrity.data_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.integrity.anchored_merkle_root).toBe("ab".repeat(32));
    expect(c.integrity.anchor_algo).toBe("sha256-merkle-v1");
    expect(verifyEftiConsignment(c)).toBe(true);
  });

  test("no anchor when the claim has never been notarized", () => {
    const c = buildEftiConsignment(input({ anchorMerkleRoot: null }));
    expect(c.integrity.anchored_merkle_root).toBeNull();
    expect(c.integrity.anchor_algo).toBeNull();
    expect(verifyEftiConsignment(c)).toBe(true);
  });

  test("is deterministic and tamper-evident", () => {
    const a = buildEftiConsignment(input());
    const b = buildEftiConsignment(input());
    expect(b.integrity.data_sha256).toBe(a.integrity.data_sha256);

    const tampered = structuredClone(a);
    tampered.port_call.milestones[0].occurred_at = "2026-03-01T08:00:00+03:00";
    expect(verifyEftiConsignment(tampered)).toBe(false);

    const differentClaim = buildEftiConsignment(
      input({ claim: { ...input().claim, id: "claim-2" } })
    );
    expect(differentClaim.integrity.data_sha256).not.toBe(a.integrity.data_sha256);
  });

  test("omits the laytime summary pre-calculation", () => {
    const c = buildEftiConsignment(input({ totals: null }));
    expect(c.laytime_summary).toBeNull();
    expect(verifyEftiConsignment(c)).toBe(true);
  });

  test("refuses an export with nothing a logistics consumer can use", () => {
    expect(() =>
      buildEftiConsignment(
        input({ events: [{ event_type: "WEATHER_DELAY", occurred_at: "2026-03-03T11:00:00+03:00" }] })
      )
    ).toThrow("NO_EXPORTABLE_MILESTONES");
    expect(() => buildEftiConsignment(input({ generatedAt: "garbage" }))).toThrow(
      "INVALID_GENERATED_AT"
    );
  });
});
