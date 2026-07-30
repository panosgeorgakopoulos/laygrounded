// Reconstructing a stored calculation into the engine's own `LaytimeResult`.
//
// This exists so that exactly one piece of code knows how a persisted row maps
// back to an engine result. The trade-finance verifier compares WHOLE result
// objects, so a reconstruction that is subtly wrong does not degrade
// gracefully: it reports "does not verify" on a perfectly good claim, which is
// the worst possible answer to hand a credit committee.
//
// Pure — no I/O. The caller loads the row.

import type { LaytimeResult } from "@/lib/laytime/types";

/**
 * The persisted columns this reconstruction needs.
 *
 * Every field is required, including `demurrage_half_rate_hours`. That is
 * deliberate: a caller that forgets to select the column would otherwise get a
 * silently key-less result that fails to verify on ASBATANKVOY claims. Making
 * it required moves that mistake to compile time.
 */
export interface PersistedCalculationRow {
  breakdown: unknown;
  allowed_hours: number;
  used_hours: number;
  time_on_demurrage_hours: number;
  time_saved_hours: number;
  /** NULL means the engine did not emit this key — NOT that it emitted zero. */
  demurrage_half_rate_hours: number | null;
  demurrage_amount: number | null;
  despatch_amount: number | null;
  currency: string | null;
}

/** The columns `calculationRowToResult` requires, for use in `.select(...)`. */
export const CALCULATION_RESULT_COLUMNS =
  "breakdown, allowed_hours, used_hours, time_on_demurrage_hours, time_saved_hours, demurrage_half_rate_hours, demurrage_amount, despatch_amount, currency";

/**
 * Rebuilds the engine result that produced this row.
 *
 * THE LOAD-BEARING LINE is the conditional spread of
 * `demurrage_half_rate_hours`. The engine emits that key for ASBATANKVOY only
 * (`...(isAsba ? { demurrage_half_rate_hours } : {})`), and the verifier's
 * canonical JSON skips `undefined` but *serializes* `null`. So:
 *
 *   - spreading the key when NULL breaks every GENCON 94 claim;
 *   - dropping the column breaks every ASBATANKVOY claim.
 *
 * Presence keys on the charterparty form, not on the value: an ASBATANKVOY
 * claim with no storm on demurrage emits the key with value `0`, which is why
 * `0` and NULL must never be conflated.
 */
export function calculationRowToResult(row: PersistedCalculationRow): LaytimeResult {
  const halfRate = row.demurrage_half_rate_hours;

  return {
    breakdown: Array.isArray(row.breakdown) ? (row.breakdown as LaytimeResult["breakdown"]) : [],
    totals: {
      allowed_hours: row.allowed_hours,
      used_hours: row.used_hours,
      time_on_demurrage_hours: row.time_on_demurrage_hours,
      time_saved_hours: row.time_saved_hours,
      ...(halfRate === null || halfRate === undefined ? {} : { demurrage_half_rate_hours: halfRate }),
      // These columns are nullable for historical reasons; the engine always
      // produces a number, so a NULL here means a row this app did not write.
      demurrage_amount: row.demurrage_amount ?? 0,
      despatch_amount: row.despatch_amount ?? 0,
      currency: row.currency ?? "USD",
    },
  };
}
