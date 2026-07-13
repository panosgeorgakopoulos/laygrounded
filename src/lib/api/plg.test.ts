import { describe, expect, test } from "bun:test";
import {
  parseFixtureRecap,
  TelemetryBatchSchema,
  telemetryToSofEventRows,
} from "./plg";

const RECAP = `
FIXTURE RECAP — CLEAN

VESSEL: MV IRON DUKE
CHARTERERS: ACME CHARTERING PTE LTD
LOAD PORT: SANTOS, BRAZIL
CARGO: 72,000 MTS IRON ORE FINES
VOYAGE: VOY-2026-018

LAYTIME 84 HRS TOTAL SHINC REVERSIBLE
TURN TIME 6 HRS
NOR WIBON WIPON
DEM USD 28,500 PDPR / HD
OTHERWISE AS PER GENCON 94
`;

describe("parseFixtureRecap", () => {
  test("parses a realistic broker recap into claim fields + CpTerms", () => {
    const r = parseFixtureRecap(RECAP);
    expect(r.claim.vessel).toBe("MV IRON DUKE");
    expect(r.claim.port).toBe("SANTOS, BRAZIL");
    expect(r.claim.cargo).toBe("72,000 MTS IRON ORE FINES");
    expect(r.claim.voyageRef).toBe("VOY-2026-018");
    expect(r.claim.counterpartyName).toBe("ACME CHARTERING PTE LTD");
    expect(r.cpTerms.laytime_allowed_hours).toBe(84);
    expect(r.cpTerms.turn_time_hours).toBe(6);
    expect(r.cpTerms.days_basis).toBe("SHINC");
    expect(r.cpTerms.nor_variant).toBe("WIBON");
    expect(r.cpTerms.cp_form).toBe("GENCON94");
    expect(r.cpTerms.demurrage_rate).toBe(28_500);
    expect(r.cpTerms.despatch_rate).toBe(14_250); // HD
    expect(r.cpTerms.currency).toBe("USD");
    expect(r.warnings.some((w) => w.includes("half demurrage"))).toBe(true);
  });

  test("SSHEX UU is not half-matched as SHEX; laytime derives from rate + quantity", () => {
    const r = parseFixtureRecap(
      "MV OCEAN STAR / 50,000 MTS COAL / 10,000 MT PWWD SSHEX UU / DEMURRAGE EUR 18,000 PDPR"
    );
    expect(r.cpTerms.days_basis).toBe("SSHEX-UU");
    expect(r.cpTerms.laytime_allowed_hours).toBe(120); // 50,000 / 10,000 × 24
    expect(r.cpTerms.currency).toBe("EUR");
    expect(r.claim.vessel).toBe("OCEAN STAR");
    expect(r.warnings.some((w) => w.includes("derived"))).toBe(true);
  });

  test("missing fields fall back to defaults with explicit warnings", () => {
    const r = parseFixtureRecap("VESSEL: MV LONELY\nNOTHING ELSE AGREED YET");
    expect(r.claim.vessel).toBe("MV LONELY");
    expect(r.cpTerms.laytime_allowed_hours).toBe(72); // DEFAULT_CP_TERMS
    expect(r.missing).toContain("laytime_allowed_hours");
    expect(r.missing).toContain("demurrage_rate");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test("arbitrary prose is refused, not silently defaulted", () => {
    expect(() => parseFixtureRecap("the quick brown fox jumped over the lazy dog")).toThrow(
      "RECAP_UNPARSEABLE"
    );
  });
});

describe("TelemetryBatchSchema", () => {
  const valid = {
    batch_id: "crane4-2026-07-14-001",
    external_ref: "VOY-2026-018",
    vessel: "MV IRON DUKE",
    readings: [
      {
        reading_id: "r-1",
        event_type: "ALL_FAST",
        occurred_at: "2026-07-14T06:30:00+02:00",
        source: "gantry-crane-4",
      },
    ],
  };

  test("accepts a well-formed batch", () => {
    expect(TelemetryBatchSchema.safeParse(valid).success).toBe(true);
  });

  test("rejects naive timestamps (no timezone)", () => {
    const bad = structuredClone(valid);
    bad.readings[0].occurred_at = "2026-07-14T06:30:00";
    expect(TelemetryBatchSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects unknown event types and empty batches", () => {
    const badType = structuredClone(valid);
    badType.readings[0].event_type = "CRANE_LUNCH_BREAK";
    expect(TelemetryBatchSchema.safeParse(badType).success).toBe(false);
    expect(TelemetryBatchSchema.safeParse({ ...valid, readings: [] }).success).toBe(false);
  });
});

describe("telemetryToSofEventRows", () => {
  test("maps validated readings onto accepted m2m sof_events rows", () => {
    const rows = telemetryToSofEventRows("claim-1", "doc-1", [
      {
        reading_id: "r-1",
        event_type: "NOR_TENDERED",
        occurred_at: "2026-07-14T04:00:00Z",
        source: "bridge-stack",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claim_id: "claim-1",
      document_id: "doc-1",
      event_type: "NOR_TENDERED",
      source: "m2m",
      status: "accepted",
      confidence: 1.0,
    });
    expect(String(rows[0].raw_text)).toContain("bridge-stack");
  });
});
