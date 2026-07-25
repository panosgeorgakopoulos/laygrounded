/// <reference types="bun-types" />
// Run with: bun test src/lib/interop/efti-federation.test.ts

import { describe, it, expect } from "bun:test";
import { buildEftiConsignment } from "./efti";
import {
  scopeConsignment,
  verifyScopedConsignment,
  normalizeScopes,
  MVSD_SCOPES,
} from "./efti-federation";

const full = buildEftiConsignment({
  claim: {
    id: "c1",
    vessel: "MV Test",
    vesselImo: "9111111",
    voyageRef: "VR-1",
    port: "Rotterdam",
    cargo: "Iron ore",
    counterpartyName: "Acme Chartering",
  },
  events: [
    { event_type: "NOR_TENDERED", occurred_at: "2026-01-05T08:00:00Z", ais_geofence_verified: true },
    { event_type: "COMPLETED_LOADING", occurred_at: "2026-01-08T17:00:00Z", ais_geofence_verified: null },
  ],
  totals: { allowed_hours: 72, used_hours: 120, demurrage_amount: 50000, despatch_amount: 0, currency: "EUR" },
  anchorMerkleRoot: null,
  generatedAt: "2026-01-10T00:00:00Z",
});

describe("normalizeScopes", () => {
  it("keeps known scopes, drops unknown, dedupes and sorts", () => {
    expect(normalizeScopes(["laytime", "nope", "transport", "transport"])).toEqual([
      "laytime",
      "transport",
    ]);
    expect(normalizeScopes("not-an-array")).toEqual([]);
  });
});

describe("scopeConsignment — MVSD (basic carriage metadata, no commercials)", () => {
  const scoped = scopeConsignment(full, MVSD_SCOPES);

  it("exposes transport, consignment and milestones but NOT laytime", () => {
    expect(scoped.transport_movement).not.toBeNull();
    expect(scoped.consignment).not.toBeNull();
    expect(scoped.port_call).not.toBeNull();
    expect(scoped.laytime_summary).toBeNull(); // commercial outcome withheld
    expect([...scoped.scopes].sort()).toEqual(["consignment", "milestones", "transport"]);
  });

  it("re-signs so the scoped packet verifies on its own", () => {
    expect(verifyScopedConsignment(scoped)).toBe(true);
  });

  it("carries a different signature than the full export (not confusable)", () => {
    expect(scoped.integrity.data_sha256).not.toBe(full.integrity.data_sha256);
  });
});

describe("scopeConsignment — laytime only", () => {
  const scoped = scopeConsignment(full, ["laytime"]);
  it("exposes only the laytime summary", () => {
    expect(scoped.transport_movement).toBeNull();
    expect(scoped.consignment).toBeNull();
    expect(scoped.port_call).toBeNull();
    expect(scoped.laytime_summary).toEqual(full.laytime_summary);
    expect(verifyScopedConsignment(scoped)).toBe(true);
  });
});

describe("verifyScopedConsignment — tamper detection", () => {
  it("fails when a shared field is altered", () => {
    const scoped = scopeConsignment(full, MVSD_SCOPES);
    const tampered = {
      ...scoped,
      transport_movement: { ...scoped.transport_movement!, vessel_name: "MV Other" },
    };
    expect(verifyScopedConsignment(tampered)).toBe(false);
  });

  it("fails when the scope list is widened after signing", () => {
    const scoped = scopeConsignment(full, MVSD_SCOPES);
    const tampered = { ...scoped, scopes: [...scoped.scopes, "laytime" as const] };
    expect(verifyScopedConsignment(tampered)).toBe(false);
  });
});
