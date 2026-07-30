import { describe, expect, test } from "bun:test";
import { recomputeLaytime } from "@laygrounded/laytime-core/gencon94";
import { canonicalJson, verifyClaim } from "@laygrounded/laytime-verify";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";
import {
  CALCULATION_RESULT_COLUMNS,
  calculationRowToResult,
  type PersistedCalculationRow,
} from "@/lib/laytime/calculation-row";

// The whole point of this module is that a stored calculation can be turned
// back into the exact object the engine produced. "Exact" means byte-identical
// under the verifier's canonical JSON, because that is what `verifyClaim`
// compares — a reconstruction that is merely *close* reports a good claim as
// unverifiable.

const EVENTS: SofEventInput[] = [
  { id: "1", occurred_at: "2026-03-01T06:00:00+00:00", event_type: "NOR_TENDERED" },
  { id: "2", occurred_at: "2026-03-01T12:00:00+00:00", event_type: "ALL_FAST" },
  { id: "3", occurred_at: "2026-03-01T14:00:00+00:00", event_type: "COMMENCED_LOADING" },
  { id: "4", occurred_at: "2026-03-02T09:30:00+00:00", event_type: "WEATHER_DELAY" },
  { id: "5", occurred_at: "2026-03-02T13:30:00+00:00", event_type: "WEATHER_DELAY_END" },
  { id: "6", occurred_at: "2026-03-04T18:00:00+00:00", event_type: "COMPLETED_LOADING" },
];

const BASE_TERMS: CpTerms = {
  laytime_allowed_hours: 48,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "WWDSHEX-EIU",
  demurrage_rate: 12500,
  despatch_rate: 6250,
  currency: "USD",
  port_timezone: "Europe/Amsterdam",
} as CpTerms;

/**
 * Persists a result the way `recomputeLaytimeServerFn` does, then reads it back
 * the way the verify route does — including the JSON round-trip that `jsonb`
 * imposes on the breakdown.
 */
function persistAndReload(result: ReturnType<typeof recomputeLaytime>): PersistedCalculationRow {
  const written = {
    breakdown: result.breakdown,
    allowed_hours: result.totals.allowed_hours,
    used_hours: result.totals.used_hours,
    time_on_demurrage_hours: result.totals.time_on_demurrage_hours,
    time_saved_hours: result.totals.time_saved_hours,
    demurrage_half_rate_hours: result.totals.demurrage_half_rate_hours ?? null,
    demurrage_amount: result.totals.demurrage_amount,
    despatch_amount: result.totals.despatch_amount,
    currency: result.totals.currency,
  };
  return JSON.parse(JSON.stringify(written)) as PersistedCalculationRow;
}

describe("calculationRowToResult", () => {
  test("GENCON 94 round-trips to a byte-identical result", () => {
    const result = recomputeLaytime(EVENTS, BASE_TERMS);
    const rebuilt = calculationRowToResult(persistAndReload(result));

    expect(canonicalJson(rebuilt)).toBe(canonicalJson(result));
  });

  test("ASBATANKVOY round-trips to a byte-identical result", () => {
    const terms = { ...BASE_TERMS, cp_form: "ASBATANKVOY" } as CpTerms;
    const result = recomputeLaytime(EVENTS, terms);

    // Guard the premise: this fixture must actually exercise the key.
    expect(result.totals).toHaveProperty("demurrage_half_rate_hours");

    const rebuilt = calculationRowToResult(persistAndReload(result));
    expect(canonicalJson(rebuilt)).toBe(canonicalJson(result));
  });

  test("a NULL half-rate column omits the key rather than emitting null", () => {
    const result = recomputeLaytime(EVENTS, BASE_TERMS);
    const rebuilt = calculationRowToResult(persistAndReload(result));

    // Not `toBeNull()` — the key must be ABSENT. canonicalJson serializes null
    // but skips undefined, so an explicit null here would fail verification on
    // every GENCON 94 claim.
    expect("demurrage_half_rate_hours" in rebuilt.totals).toBe(false);
    expect(canonicalJson(rebuilt.totals)).not.toContain("demurrage_half_rate_hours");
  });

  test("a half-rate of 0 is preserved as present, not collapsed to absent", () => {
    // An ASBATANKVOY claim with no storm on demurrage emits the key with value
    // 0. Treating that as "no key" would be a different charterparty form.
    const row: PersistedCalculationRow = {
      breakdown: [],
      allowed_hours: 48,
      used_hours: 60,
      time_on_demurrage_hours: 12,
      time_saved_hours: 0,
      demurrage_half_rate_hours: 0,
      demurrage_amount: 6250,
      despatch_amount: 0,
      currency: "USD",
    };

    const rebuilt = calculationRowToResult(row);
    expect("demurrage_half_rate_hours" in rebuilt.totals).toBe(true);
    expect(rebuilt.totals.demurrage_half_rate_hours).toBe(0);
  });

  test("the column list covers every field the reconstruction reads", () => {
    // Stops a total being added to the engine and persisted, but never
    // selected — which would publish a partial object as though it were whole.
    const required: Array<keyof PersistedCalculationRow> = [
      "breakdown",
      "allowed_hours",
      "used_hours",
      "time_on_demurrage_hours",
      "time_saved_hours",
      "demurrage_half_rate_hours",
      "demurrage_amount",
      "despatch_amount",
      "currency",
    ];
    const selected = CALCULATION_RESULT_COLUMNS.split(",").map((c) => c.trim());
    for (const column of required) expect(selected).toContain(column);
  });
});

describe("verifyClaim against a reconstructed result", () => {
  // The end-to-end property this change exists for: a good claim verifies.
  test.each([
    ["GENCON94", BASE_TERMS],
    ["ASBATANKVOY", { ...BASE_TERMS, cp_form: "ASBATANKVOY" } as CpTerms],
  ])("%s: matchesPublished is true", (_form, terms) => {
    const result = recomputeLaytime(EVENTS, terms as CpTerms);
    const published = calculationRowToResult(persistAndReload(result));

    const verdict = verifyClaim({ cpTerms: terms as CpTerms, events: EVENTS, published });

    expect(verdict.error).toBeNull();
    expect(verdict.matchesPublished).toBe(true);
    expect(verdict.discrepancies).toBeUndefined();
  });

  test("a tampered total is caught and named", () => {
    const result = recomputeLaytime(EVENTS, BASE_TERMS);
    const published = calculationRowToResult(persistAndReload(result));
    published.totals.demurrage_amount += 1000;

    const verdict = verifyClaim({ cpTerms: BASE_TERMS, events: EVENTS, published });

    expect(verdict.matchesPublished).toBe(false);
    expect(verdict.discrepancies).toContainEqual(
      expect.objectContaining({ field: "totals.demurrage_amount" })
    );
  });

  test("mis-stating an ASBATANKVOY claim as GENCON 94 is caught", () => {
    // The regression that a naive two-column fix would have shipped: the key's
    // presence is part of the claim, so losing it must not verify.
    const asbaTerms = { ...BASE_TERMS, cp_form: "ASBATANKVOY" } as CpTerms;
    const result = recomputeLaytime(EVENTS, asbaTerms);

    const row = persistAndReload(result);
    row.demurrage_half_rate_hours = null; // as a GENCON-only fix would store it
    const published = calculationRowToResult(row);

    const verdict = verifyClaim({ cpTerms: asbaTerms, events: EVENTS, published });
    expect(verdict.matchesPublished).toBe(false);
  });
});
