// The leakage test.
//
// `buildStatementView` copies every field across by name, which is the correct
// discipline and is also exactly the kind of discipline that decays: somebody
// adds a column to `claims`, a future refactor "simplifies" the mapping to a
// spread, and the opposing party in a live dispute quietly starts receiving the
// owner's settlement history over the network.
//
// So the guarantee is structural. The row below is stuffed with EVERY internal
// field the schema actually carries, plus a few that do not exist yet, and the
// test serialises the built view and fails if any of them appears anywhere in
// it. A spread cannot survive this file.

import { describe, expect, test } from "bun:test";
import { buildStatementView } from "./statement-view";

/**
 * A claim row as it really comes back from `select("*")`, with sentinel values
 * that are trivially greppable in a JSON blob.
 *
 * Every key here is a real `public.claims` column except the three marked
 * "future" — those stand in for whatever gets added next, which is the actual
 * failure mode this file guards.
 */
const HOSTILE_CLAIM: Record<string, unknown> = {
  // ── Legitimately shared ──
  id: "11111111-1111-4111-8111-111111111111",
  vessel: "MV ODYSSEY",
  voyage_ref: "VOY-2024-01",
  port: "Santos, Brazil",
  terminal_name: "Terminal 39",
  cargo: "Soybeans, 62,000 MT",
  cp_form: "GENCON94",
  port_lat: -23.98,
  port_lon: -46.3,
  engine_version: 2,
  // THE REAL `CpTerms` KEYS, copied from the engine package rather than
  // guessed. An earlier draft of the projection invented plausible names
  // (`laytime_allowance_hours`, `demurrage_rate_per_day`); every field read as
  // null and the whole terms block rendered as em-dashes on the live page,
  // which no leakage assertion could ever have caught.
  cp_terms: {
    laytime_allowed_hours: 96,
    turn_time_hours: 6,
    demurrage_rate: 36000,
    despatch_rate: 18000,
    days_basis: "SHINC",
    nor_variant: "WIBON",
    currency: "USD",
    engine_version: 2,
  },

  // ── Internal: must never reach a counterparty ──
  company_id: "LEAK_company_id",
  created_by: "LEAK_created_by",
  status: "LEAK_status",
  settled_amount: 999999,
  settled_at: "LEAK_settled_at",
  agreed_at: "LEAK_agreed_at",
  agreed_by: "LEAK_agreed_by",
  agreed_calculation_id: "LEAK_agreed_calculation_id",
  // The single worst one: it tells the opposing party exactly when the owner
  // started preparing to fight them.
  negotiation_opened_at: "LEAK_negotiation_opened_at",
  negotiation_opened_by: "LEAK_negotiation_opened_by",
  external_source: "LEAK_external_source",
  external_ref: "LEAK_external_ref",
  counterparty_name: "LEAK_counterparty_name",
  time_bar_days: 90,
  tenant_role: "LEAK_tenant_role",
  parent_claim_id: "LEAK_parent_claim_id",
  chain_role: "LEAK_chain_role",
  chain_depth: 3,
  is_locked: true,
  has_bimco_ets_clause: true,
  ets_applicable: true,
  vessel_imo: "LEAK_vessel_imo",
  created_at: "LEAK_created_at",
  updated_at: "LEAK_updated_at",

  // ── "future" columns: the actual regression this file exists to catch ──
  internal_notes: "LEAK_internal_notes",
  negotiation_floor_usd: "LEAK_negotiation_floor",
  owner_walk_away_price: "LEAK_walk_away",
};

const HOSTILE_CALCULATION: Record<string, unknown> = {
  id: "LEAK_calculation_id",
  claim_id: "LEAK_calc_claim_id",
  computed_at: "2026-08-09T10:00:00Z",
  allowed_hours: 96,
  used_hours: 110.5,
  time_on_demurrage_hours: 14.5,
  time_saved_hours: 0,
  demurrage_amount: 21750,
  despatch_amount: 0,
  currency: "USD",
  created_at: "LEAK_calc_created_at",
  updated_at: "LEAK_calc_updated_at",
  breakdown: [
    {
      start_time: "2024-03-04T06:30:00Z",
      end_time: "2024-03-04T11:45:00Z",
      duration_hours: 5.25,
      status: "laytime",
      counts: true,
      clause_ref: "GENCON94-6(c)",
      reasoning: "Laytime running",
      // A blob field nobody expected. Passing `breakdown` straight through
      // would carry this to the counterparty.
      internal_confidence_note: "LEAK_breakdown_internal",
    },
  ],
};

const HOSTILE_EVENTS: Array<Record<string, unknown>> = [
  {
    id: "LEAK_event_id",
    claim_id: "LEAK_event_claim_id",
    occurred_at: "2024-03-04T06:30:00Z",
    event_type: "NOR_TENDERED",
    raw_text: "Notice of Readiness tendered",
    source: "vision",
    status: "accepted",
    confidence: 0.91,
    locked_reason: "LEAK_locked_reason",
    created_by: "LEAK_event_created_by",
    extraction_metadata: { model: "LEAK_model_name" },
  },
];

function build() {
  return buildStatementView({
    share: { counterparty_label: "Cargill Ocean Transportation", expires_at: "2026-09-08T00:00:00Z" },
    claim: HOSTILE_CLAIM,
    calculation: HOSTILE_CALCULATION,
    events: HOSTILE_EVENTS,
    track: [{ timestamp: "2024-03-04T05:00:00Z", lat: -23.9, lon: -46.2 }],
    now: new Date("2026-08-09T12:00:00Z"),
  });
}

describe("no internal data reaches the counterparty", () => {
  // THE TEST. Everything marked LEAK_ is internal; none of it may appear
  // anywhere in the serialised payload, at any depth, under any key.
  test("no LEAK sentinel survives the projection", () => {
    const serialised = JSON.stringify(build());

    // Scanned against the payload rather than against the input keys, so a leak
    // is caught regardless of which field it arrived on or how deeply it nests.
    // Reported by name, because "expected false to be true" would send the next
    // reader hunting for which field escaped.
    const leaked = [...serialised.matchAll(/LEAK_[a-z_]+/gi)].map((m) => m[0]);
    expect(leaked).toEqual([]);
  });

  test("the sentinels are actually present in the input", () => {
    // Guards the guard. If the fixture ever stopped carrying internal fields,
    // every assertion above would pass vacuously and this file would be
    // certifying nothing at all.
    const inputs = JSON.stringify([HOSTILE_CLAIM, HOSTILE_CALCULATION, HOSTILE_EVENTS]);
    expect([...inputs.matchAll(/LEAK_[a-z_]+/gi)].length).toBeGreaterThan(20);
  });

  test("the settlement history is absent", () => {
    // A number, so it has no LEAK_ prefix to catch it. What the owner accepted
    // previously is the single most valuable thing a counterparty could learn.
    const serialised = JSON.stringify(build());
    expect(serialised).not.toContain("999999");
  });

  test("the time bar is absent", () => {
    // 90 days to the deadline is a negotiating clock. A counterparty who knows
    // it can simply wait.
    const view = build();
    expect(JSON.stringify(view)).not.toContain("time_bar");
    expect(JSON.stringify(view)).not.toContain("timeBar");
  });

  test("no company or user identifier appears", () => {
    const serialised = JSON.stringify(build());
    for (const key of ["company_id", "companyId", "created_by", "createdBy", "agreed_by"]) {
      expect(serialised).not.toContain(key);
    }
  });

  test("breakdown rows are rebuilt field by field, not passed through", () => {
    const view = build();
    const row = view.calculation!.breakdown[0];
    expect(Object.keys(row).sort()).toEqual([
      "clause_ref",
      "counts",
      "duration_hours",
      "end_time",
      "reasoning",
      "start_time",
      "status",
    ]);
    expect(JSON.stringify(row)).not.toContain("internal_confidence_note");
  });

  test("events are rebuilt field by field", () => {
    const view = build();
    expect(Object.keys(view.events[0]).sort()).toEqual([
      "eventType",
      "occurredAt",
      "rawText",
      "source",
    ]);
  });

  test("the top-level shape is exactly the documented surface", () => {
    // A new top-level key is how a whole new category of data arrives at once.
    expect(Object.keys(build()).sort()).toEqual([
      "calculation",
      "claim",
      "events",
      "generatedAt",
      "share",
      "terms",
      "track",
      "verifier",
    ]);
  });

  test("the claim projection carries only the agreed fields", () => {
    expect(Object.keys(build().claim).sort()).toEqual([
      "cargo",
      "cpForm",
      "port",
      "portLat",
      "portLon",
      "terminal",
      "vessel",
      "voyageRef",
    ]);
  });
});

describe("what the counterparty SHOULD receive", () => {
  // The other half. A projection that leaked nothing because it contained
  // nothing would pass every assertion above and be useless.

  test("the claim identity and the figures", () => {
    const view = build();
    expect(view.claim.vessel).toBe("MV ODYSSEY");
    expect(view.claim.port).toBe("Santos, Brazil");
    expect(view.calculation!.totals.demurrage_amount).toBe(21750);
    expect(view.calculation!.totals.used_hours).toBe(110.5);
    expect(view.calculation!.breakdown).toHaveLength(1);
  });

  test("the charterparty terms, so the arithmetic can be checked", () => {
    // These are the counterparty's OWN contract terms — withholding them would
    // make the statement unverifiable, which defeats the purpose of sending it.
    //
    // EVERY field asserted with a real value, not just a couple. This block is
    // the regression guard for the em-dash bug: a projection reading a
    // misspelled key returns null and looks perfectly healthy to any test that
    // only checks the shape.
    const view = build();
    expect(view.terms).toEqual({
      laytimeAllowedHours: 96,
      turnTimeHours: 6,
      demurrageRate: 36000,
      despatchRate: 18000,
      daysBasis: "SHINC",
      norVariant: "WIBON",
      currency: "USD",
    });
  });

  test("the engine fingerprint, paired with its rule set", () => {
    const view = build();
    expect(view.verifier.engineVersion).toBe(2);
    // Each rule set has its own root; the pairing is what makes it meaningful.
    expect(typeof view.verifier.conformanceRoot).toBe("string");
    expect(typeof view.verifier.available).toBe("boolean");
  });

  test("the access mode is pinned to readonly", () => {
    expect(build().share.accessMode).toBe("readonly");
  });

  test("the vessel track when there is one", () => {
    expect(build().track).toHaveLength(1);
  });
});

describe("absences are honest", () => {
  function bare(overrides: Parameters<typeof buildStatementView>[0]) {
    return buildStatementView(overrides);
  }

  test("no calculation reads as null, never as a zero figure", () => {
    // A counterparty must not read "no calculation yet" as "nothing is owed".
    const view = bare({
      share: { counterparty_label: "X", expires_at: "2026-09-08T00:00:00Z" },
      claim: HOSTILE_CLAIM,
      calculation: null,
      events: [],
      track: null,
    });
    expect(view.calculation).toBeNull();
  });

  test("no AIS provider reads as null, never as an empty track", () => {
    // `[]` would say "we looked and she was nowhere". `null` says "we could not
    // look" — the distinction `fetchAisTrack` exists to preserve.
    const view = bare({
      share: { counterparty_label: "X", expires_at: "2026-09-08T00:00:00Z" },
      claim: HOSTILE_CLAIM,
      calculation: null,
      events: [],
      track: null,
    });
    expect(view.track).toBeNull();
    expect(view.track).not.toEqual([]);
  });

  test("missing terms are null rather than invented", () => {
    const view = bare({
      share: { counterparty_label: "X", expires_at: "2026-09-08T00:00:00Z" },
      claim: { vessel: "V", voyage_ref: "R", port: "P", cargo: "C", cp_terms: {} },
      calculation: null,
      events: [],
      track: null,
    });
    expect(view.terms.demurrageRate).toBeNull();
    expect(view.terms.laytimeAllowedHours).toBeNull();
    expect(view.claim.portLat).toBeNull();
  });

  test("a legacy claim with no engine_version reads as rule set 1", () => {
    const view = bare({
      share: { counterparty_label: "X", expires_at: "2026-09-08T00:00:00Z" },
      claim: { vessel: "V", voyage_ref: "R", port: "P", cargo: "C", cp_terms: {} },
      calculation: null,
      events: [],
      track: null,
    });
    expect(view.verifier.engineVersion).toBe(1);
  });
});
