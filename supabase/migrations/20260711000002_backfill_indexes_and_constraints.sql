-- Backfill for 20240301000000_indexes_and_constraints.sql, which was never
-- applied to the live project. Without the unique constraint below, the
-- recompute upsert (onConflict: "claim_id") fails with 42P10 and laytime
-- calculations never persist. The performance indexes were likewise missing.
--
-- Written idempotently and applied out of band, so it deliberately does NOT
-- re-add check_sof_events_event_type: migration 20260711000001 already
-- installed the correct, newer version of that constraint (with the
-- WEATHER_DELAY_END / SHIFTING_END types). Re-adding the original would either
-- collide on the name or regress that fix.

-- Unique constraint required by the recompute upsert's ON CONFLICT (claim_id).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'laytime_calculations_claim_id_key'
  ) THEN
    ALTER TABLE public.laytime_calculations
      ADD CONSTRAINT laytime_calculations_claim_id_key UNIQUE (claim_id);
  END IF;
END $$;

-- Foreign-key / lookup indexes.
CREATE INDEX IF NOT EXISTS idx_company_members_company_id ON public.company_members(company_id);
CREATE INDEX IF NOT EXISTS idx_claims_company_id ON public.claims(company_id);
CREATE INDEX IF NOT EXISTS idx_claims_created_by ON public.claims(created_by);
CREATE INDEX IF NOT EXISTS idx_documents_claim_id ON public.documents(claim_id);
CREATE INDEX IF NOT EXISTS idx_sof_events_claim_id ON public.sof_events(claim_id);
CREATE INDEX IF NOT EXISTS idx_sof_events_document_id ON public.sof_events(document_id);
CREATE INDEX IF NOT EXISTS idx_laytime_calculations_claim_id ON public.laytime_calculations(claim_id);

-- Claim status CHECK (the sof_events event_type CHECK is intentionally omitted;
-- see header).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_claims_status'
  ) THEN
    ALTER TABLE public.claims
      ADD CONSTRAINT check_claims_status
      CHECK (status IN ('draft', 'processing', 'completed', 'failed', 'demurrage', 'despatch', 'in_progress'));
  END IF;
END $$;
