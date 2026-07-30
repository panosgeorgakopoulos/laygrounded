-- Admit micro-movement verdicts to the evidence log.
--
-- `evidence_checks.check_type` was constrained to ('weather','position'). The
-- micro-movement checks are a third kind of evidence and would have failed on
-- insert with a constraint violation — taking the whole evidence-verification
-- run down with them, for any claim whose timeline contains a cargo-operations
-- or shifting window.
--
-- Worth recording HOW that was found: neither TypeScript nor the pure module's
-- own tests can see a database CHECK constraint. It surfaced only from reading
-- pg_constraint. The project rule — judge applied state from the catalog, never
-- from the migration text or the type system — is what caught it.
--
-- The verdict constraint already covers all four states the new checks emit
-- (corroborated / contradicted / inconclusive / unavailable), so it is
-- unchanged: micro-movement deliberately reuses the existing verdict vocabulary
-- rather than inventing a parallel one.

ALTER TABLE public.evidence_checks
  DROP CONSTRAINT IF EXISTS evidence_checks_check_type_check;

ALTER TABLE public.evidence_checks
  ADD CONSTRAINT evidence_checks_check_type_check
  CHECK (check_type = ANY (ARRAY[
    'weather',
    'position',
    -- Derived from the AIS position track: was the vessel doing what the
    -- Statement of Facts claims she was doing?
    'motion_cargo_operations',
    'motion_shifting',
    'motion_at_berth'
  ]));

COMMENT ON COLUMN public.evidence_checks.check_type IS
  'Kind of evidence. motion_* are derived from the AIS position track (speed and displacement between fixes); a sparse track yields inconclusive and an absent one unavailable — never a finding.';
