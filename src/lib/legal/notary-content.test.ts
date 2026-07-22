import { describe, expect, test } from "bun:test";
import { contentHashOf } from "./notary-server";
import { generateCryptographicSnapshot, type SnapshotLedger } from "./prosecution";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";

const ledger = (over: Partial<SnapshotLedger> = {}): SnapshotLedger => ({
  cpTerms: DEFAULT_CP_TERMS,
  totals: {
    allowed_hours: 72,
    used_hours: 122,
    time_on_demurrage_hours: 50,
    time_saved_hours: 0,
    demurrage_amount: 58333.33,
    despatch_amount: 0,
    currency: "USD",
  },
  breakdown: [],
  events: [{ id: "e1", event_type: "NOR_TENDERED", occurred_at: "2026-03-01T09:00:00Z" }],
  asOf: "2026-07-15T10:00:00Z",
  ...over,
});

describe("contentHashOf", () => {
  // The bug this exists for: the Merkle root embeds as_of in its header leaf,
  // so it changes on every pass even when the claim is untouched. Deduping the
  // hourly sweep on the root therefore never fires — it would write 24
  // identical-in-substance proofs per claim per day and, with anchoring on,
  // spend a TSA request on each. Only caught by sweeping twice.
  test("is stable across as-of times, unlike the Merkle root", () => {
    const a = ledger({ asOf: "2026-07-15T10:00:00Z" });
    const b = ledger({ asOf: "2026-07-15T11:00:00Z" });

    expect(contentHashOf(a)).toBe(contentHashOf(b));
    expect(generateCryptographicSnapshot("c1", a).merkleRoot).not.toBe(
      generateCryptographicSnapshot("c1", b).merkleRoot
    );
  });

  test("changes when any part of the record changes", () => {
    const base = contentHashOf(ledger());

    expect(contentHashOf(ledger({ totals: { ...ledger().totals, demurrage_amount: 1 } }))).not.toBe(base);
    expect(
      contentHashOf(ledger({ events: [{ id: "e1", event_type: "NOR_TENDERED", occurred_at: "2026-03-01T10:00:00Z" }] }))
    ).not.toBe(base);
    expect(contentHashOf(ledger({ cpTerms: { ...DEFAULT_CP_TERMS, demurrage_rate: 99 } }))).not.toBe(base);
    expect(
      contentHashOf(ledger({ breakdown: [{ clause_ref: "GENCON94-6" }] as SnapshotLedger["breakdown"] }))
    ).not.toBe(base);
    expect(
      contentHashOf(ledger({ clauseFlags: [{ clause_ref: "GENCON94-6", severity: "info", note: "x" }] }))
    ).not.toBe(base);
  });

  test("is insensitive to key order but not to values", () => {
    const a = contentHashOf(ledger());
    const reordered = ledger();
    reordered.totals = {
      currency: "USD",
      despatch_amount: 0,
      demurrage_amount: 58333.33,
      time_saved_hours: 0,
      time_on_demurrage_hours: 50,
      used_hours: 122,
      allowed_hours: 72,
    };
    expect(contentHashOf(reordered)).toBe(a);
  });

  test("treats an absent clauseFlags list as an empty one", () => {
    expect(contentHashOf(ledger({ clauseFlags: undefined }))).toBe(
      contentHashOf(ledger({ clauseFlags: [] }))
    );
  });
});
