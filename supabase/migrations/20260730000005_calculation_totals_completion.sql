-- Persist the engine's remaining calculation totals.
--
-- WHY: `laytime_calculations` stored five of the engine's totals, so a stored
-- calculation could not be reconstructed into a faithful `LaytimeResult`. The
-- trade-finance verifier (`verifyClaim`) compares WHOLE result objects, so the
-- verification package had to ship a named subset and the verifier reported
-- `matchesPublished: null` — it recomputed, but it never actually verified.
--
-- THREE columns, not two. Besides the two derived totals, the engine emits
-- `demurrage_half_rate_hours` for ASBATANKVOY claims only (GENCON 94 omits the
-- key entirely). That column is therefore NULLABLE, and NULL carries meaning:
--
--     NULL      = the engine did not emit this key (i.e. not ASBATANKVOY)
--     0 or more = the engine emitted this key with that value
--
-- The distinction is load-bearing. The verifier's canonical JSON skips
-- `undefined` but SERIALIZES `null`, so a GENCON 94 claim reconstructed with an
-- explicit null would fail to verify against an engine result that omits the
-- key — reintroducing the same bug in the opposite direction. Reconstruction
-- lives in one place (`calculationRowToResult`) precisely so this rule is
-- stated once and tested.

ALTER TABLE public.laytime_calculations
  ADD COLUMN IF NOT EXISTS time_on_demurrage_hours float8 NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS time_saved_hours        float8 NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS demurrage_half_rate_hours float8;

COMMENT ON COLUMN public.laytime_calculations.demurrage_half_rate_hours IS
  'ASBATANKVOY Part II cl. 8 half-rate demurrage hours. NULL means the engine '
  'did not emit this key (GENCON 94), which is distinct from 0. Do not coalesce.';

-- Backfill the two derived totals with the engine's own formula. This is exact
-- rather than a guess: both are pure functions of `used_hours`/`allowed_hours`,
-- which are already persisted, and the engine computes them the same way
-- (`Math.max(0, used - allowed)` / `Math.max(0, allowed - used)`).
--
-- `demurrage_half_rate_hours` is deliberately NOT backfilled. It cannot be
-- derived from the stored columns, and inventing a value would be exactly the
-- kind of plausible-looking fabrication this codebase refuses. NULL is also the
-- correct answer for every row that exists today: no claim in this database
-- sets `cp_terms->>'cp_form'`, so all of them are GENCON 94, which omits the key.
UPDATE public.laytime_calculations
SET time_on_demurrage_hours = GREATEST(0, used_hours - allowed_hours),
    time_saved_hours        = GREATEST(0, allowed_hours - used_hours)
WHERE time_on_demurrage_hours = 0
  AND time_saved_hours = 0;
