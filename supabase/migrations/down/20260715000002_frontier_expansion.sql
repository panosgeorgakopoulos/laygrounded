-- Down migration for 20260715000002_frontier_expansion.sql

ALTER TABLE public.pending_human_reviews DROP CONSTRAINT IF EXISTS pending_human_reviews_subject_type_check;
ALTER TABLE public.pending_human_reviews ADD CONSTRAINT pending_human_reviews_subject_type_check
  CHECK (subject_type IN ('protest_draft', 'settlement'));

ALTER TABLE public.drafts DROP CONSTRAINT IF EXISTS drafts_kind_check;
ALTER TABLE public.drafts ADD CONSTRAINT drafts_kind_check
  CHECK (kind IN ('demand_letter', 'counter_argument', 'settlement_proposal', 'letter_of_protest'));

DROP FUNCTION IF EXISTS public.refresh_port_honesty_and_resilience_index();
DROP MATERIALIZED VIEW IF EXISTS public.port_honesty_and_resilience_index;

DROP TABLE IF EXISTS public.compliance_ledger;
DROP TABLE IF EXISTS public.vessel_analytics_profiles;

ALTER TABLE public.claims DROP COLUMN IF EXISTS is_locked;
