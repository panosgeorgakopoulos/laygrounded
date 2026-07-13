-- DOWN for 20260714000001_voyage_shield.sql
-- Run downs newest-first (20260715000001 → ... → 20260714000001).
-- DESTRUCTIVE: deletes generated Letters of Protest — restoring the original
-- drafts_kind_check is impossible while protest rows exist.
DROP TABLE IF EXISTS public.voyage_alerts;
DELETE FROM public.drafts WHERE kind = 'letter_of_protest';
ALTER TABLE public.drafts DROP CONSTRAINT IF EXISTS drafts_kind_check;
ALTER TABLE public.drafts ADD CONSTRAINT drafts_kind_check
  CHECK (kind IN ('demand_letter', 'counter_argument', 'settlement_proposal'));
