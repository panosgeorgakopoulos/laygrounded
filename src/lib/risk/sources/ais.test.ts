import { describe, expect, test } from "bun:test";
import { parseDatalasticPayload, normalizePortKey } from "@/lib/risk/sources/ais-congestion";
import { mockSnapshot } from "@/lib/risk/sources/ais-mock";
import { selectCongestionAdapter } from "@/lib/risk/sources/resolve-congestion";
import { isDecisionGrade, provenanceCaveats } from "@/lib/risk/provenance";

describe("parseDatalasticPayload", () => {
  test("maps per-vessel waits into an ascending ECDF", () => {
    const parsed = parseDatalasticPayload(
      {
        data: {
          port_name: "Rotterdam",
          vessels_at_anchorage: 4,
          vessels_in_port: 21,
          last_updated: "2026-07-30T08:00:00.000Z",
          anchorage_vessels: [
            { waiting_time_hours: 30 },
            { waiting_time_hours: 4 },
            { waiting_time_hours: 12 },
          ],
        },
      },
      "Rotterdam, NL"
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.waitingHoursSorted).toEqual([4, 12, 30]);
    expect(parsed!.vesselsAtAnchorage).toBe(4);
    expect(parsed!.vesselsInPort).toBe(21);
    expect(parsed!.portKey).toBe("rotterdam, nl");
  });

  test("accepts the alternate wait_hours field name", () => {
    const parsed = parseDatalasticPayload(
      { data: { anchorage_vessels: [{ wait_hours: 8 }, { wait_hours: 2 }] } },
      "Santos"
    );
    expect(parsed!.waitingHoursSorted).toEqual([2, 8]);
  });

  test("REFUSES a payload carrying only an average", () => {
    // Expanding a mean into a synthetic spread would manufacture exactly the
    // tail behaviour the simulation exists to measure.
    const parsed = parseDatalasticPayload(
      { data: { port_name: "Santos", vessels_at_anchorage: 9, average_waiting_time_hours: 36 } },
      "Santos"
    );
    expect(parsed).toBeNull();
  });

  test("drops unusable per-vessel entries and refuses if none survive", () => {
    expect(
      parseDatalasticPayload(
        { data: { anchorage_vessels: [{ waiting_time_hours: -1 }, {}, { wait_hours: NaN }] } },
        "X"
      )
    ).toBeNull();
  });

  test("returns null for junk rather than inventing a quiet port", () => {
    expect(parseDatalasticPayload(null, "X")).toBeNull();
    expect(parseDatalasticPayload({}, "X")).toBeNull();
    expect(parseDatalasticPayload({ data: {} }, "X")).toBeNull();
  });

  test("falls back to the sample count when the anchorage count is missing", () => {
    const parsed = parseDatalasticPayload(
      { data: { anchorage_vessels: [{ wait_hours: 1 }, { wait_hours: 2 }] } },
      "X"
    );
    expect(parsed!.vesselsAtAnchorage).toBe(2);
  });
});

describe("mock AIS", () => {
  test("is deterministic within a day", () => {
    const a = mockSnapshot("Santos, BR", "2026-07-30T09:00:00.000Z");
    const b = mockSnapshot("Santos, BR", "2026-07-30T21:30:00.000Z");
    expect(a.waitingHoursSorted).toEqual(b.waitingHoursSorted);
    expect(a.vesselsAtAnchorage).toBe(b.vesselsAtAnchorage);
  });

  test("moves between days", () => {
    const a = mockSnapshot("Santos, BR", "2026-07-30T09:00:00.000Z");
    const b = mockSnapshot("Santos, BR", "2026-07-31T09:00:00.000Z");
    expect(a.waitingHoursSorted).not.toEqual(b.waitingHoursSorted);
  });

  test("varies by port", () => {
    const busy = mockSnapshot("Santos, BR", "2026-07-30T09:00:00.000Z");
    const quiet = mockSnapshot("Rotterdam, NL", "2026-07-30T09:00:00.000Z");
    expect(busy.waitingHoursSorted).not.toEqual(quiet.waitingHoursSorted);
  });

  test("always yields a usable, ascending, non-negative ECDF", () => {
    for (const port of ["Rotterdam, NL", "Newcastle, AU", "Nowhere", "Santos, BR"]) {
      const s = mockSnapshot(port, "2026-07-30T09:00:00.000Z");
      expect(s.waitingHoursSorted.length).toBeGreaterThanOrEqual(6);
      expect([...s.waitingHoursSorted].sort((x, y) => x - y)).toEqual(s.waitingHoursSorted);
      expect(s.waitingHoursSorted.every((h) => h >= 0)).toBe(true);
    }
  });

  test("is stamped as synthetic and can never be decision-grade", () => {
    const s = mockSnapshot("Rotterdam, NL", "2026-07-30T09:00:00.000Z");
    expect(s.provenance.source).toBe("mock");

    const provenance = {
      weather: { source: "live" as const, provider: "open-meteo", observedAt: null, label: "" },
      congestion: s.provenance,
      cargoThresholds: {
        source: "public_archive" as const, provider: "baseline", observedAt: null, label: "",
      },
      eta: { source: "assumption" as const, provider: "user", observedAt: null, label: "" },
    };
    expect(isDecisionGrade(provenance)).toBe(false);
    expect(provenanceCaveats(provenance).some((c) => c.includes("SYNTHETIC DATA"))).toBe(true);
  });
});

describe("provider selection", () => {
  test("unset means unavailable, NOT mock", () => {
    // The load-bearing default. A missing env var in production must never
    // silently produce invented congestion.
    const { adapter, reason } = selectCongestionAdapter({});
    expect(adapter).toBeNull();
    expect(reason).toContain("AIS_CONGESTION_PROVIDER");
  });

  test("datalastic without a key is unavailable", () => {
    const { adapter, reason } = selectCongestionAdapter({
      AIS_CONGESTION_PROVIDER: "datalastic",
    });
    expect(adapter).toBeNull();
    expect(reason).toContain("DATALASTIC_API_KEY");
  });

  test("datalastic with a key selects the live adapter", () => {
    const { adapter } = selectCongestionAdapter({
      AIS_CONGESTION_PROVIDER: "datalastic",
      DATALASTIC_API_KEY: "k",
    });
    expect(adapter?.id).toBe("datalastic");
  });

  test("mock is allowed outside production", () => {
    const { adapter } = selectCongestionAdapter({
      AIS_CONGESTION_PROVIDER: "mock",
      NODE_ENV: "development",
    });
    expect(adapter?.id).toBe("mock");
  });

  test("mock is REFUSED in production unless explicitly allowed", () => {
    const refused = selectCongestionAdapter({
      AIS_CONGESTION_PROVIDER: "mock",
      NODE_ENV: "production",
    });
    expect(refused.adapter).toBeNull();
    expect(refused.reason).toContain("refused in production");

    const allowed = selectCongestionAdapter({
      AIS_CONGESTION_PROVIDER: "mock",
      NODE_ENV: "production",
      ALLOW_MOCK_AIS_IN_PRODUCTION: "1",
    });
    expect(allowed.adapter?.id).toBe("mock");
  });

  test("an unknown provider is unavailable, not a silent default", () => {
    const { adapter, reason } = selectCongestionAdapter({ AIS_CONGESTION_PROVIDER: "spire" });
    expect(adapter).toBeNull();
    expect(reason).toContain("Unknown AIS congestion provider");
  });
});

describe("normalizePortKey", () => {
  test("folds case and whitespace", () => {
    expect(normalizePortKey("  Rotterdam, NL ")).toBe("rotterdam, nl");
  });
});
