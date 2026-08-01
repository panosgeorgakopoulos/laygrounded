-- Phase 8b — move every existing claim onto engine rule set 2.
--
-- WHY THIS IS SAFE HERE AND WOULD NOT BE LATER.
--
-- The versioning architecture exists because a published calculation is
-- evidence: a claim already served, notarised or agreed has to keep reproducing
-- the figures on the document. That constraint binds on claims that have LEFT
-- the building. Pre-release, none have. There is no counterparty holding a
-- served claim computed under rule set 1, so there is nothing to preserve and
-- every reason to put every claim on the corrected engine.
--
-- THE MECHANISM STAYS. This is a one-time data migration, not a removal:
--   * `claims.engine_version` keeps its CHECK (1, 2) — rule set 1 is still
--     reachable and still frozen;
--   * `resolveEngineVersion` still treats an absent value as 1, which is what
--     keeps the 500 v1 corpus cases and the published conformance root
--     bc9f24fdab910a1b valid;
--   * a future rule set 3 gets the same treatment this one did.
-- What changes is only which rule set today's rows point at.
--
-- FIGURES ARE UNAFFECTED. Rule set 2 differs from 1 in exactly one branch:
-- GENCON 94 + SHINC with an explicitly agreed EXCEPTED_PERIOD. No claim in this
-- database carries an EXCEPTED_PERIOD event at all, so this changes no money.
-- Verified by recomputing every claim on both sides of the migration rather
-- than by assuming it.

update public.claims
set engine_version = 2,
    updated_at = now()
where engine_version <> 2;

-- The column default was already 2 (set when the column was added), so new
-- claims were never affected. Restated here only so the file reads as the whole
-- truth rather than depending on the reader having the previous migration open.
alter table public.claims alter column engine_version set default 2;

comment on column public.claims.engine_version is
  'Laytime rule set that computes this claim: 1 = as shipped through Phase 7 (frozen; reproduces conformance root bc9f24fdab910a1b), 2 = agreed EXCEPTED_PERIOD deducted under GENCON 94 + SHINC. All rows moved to 2 pre-release (20260801000004); the routing remains for future rule sets.';
