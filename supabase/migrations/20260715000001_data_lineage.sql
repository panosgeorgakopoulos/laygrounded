-- Data lineage for externally sourced evidence (weather archive, geocoding,
-- AIS): which source was queried, with what inputs, what transformation was
-- applied, and a content hash of the raw output — the provenance record that
-- lets an auditor trace any evidence verdict back to its inputs.
--
-- Append-only by construction: users get SELECT and (their own company's)
-- INSERT, and no UPDATE/DELETE policy exists — history cannot be rewritten
-- through PostgREST. evidence_check_id is SET NULL because evidence checks
-- are replace-on-rerun snapshots; the lineage row outlives the check it fed.

CREATE TABLE IF NOT EXISTS public.data_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  evidence_check_id uuid REFERENCES public.evidence_checks (id) ON DELETE SET NULL,
  source text NOT NULL,            -- 'open-meteo-era5' | 'open-meteo-geocoding' | 'ais-provider'
  source_ref text NOT NULL DEFAULT '', -- dataset / endpoint identity
  step text NOT NULL,              -- transformation applied to the raw data
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_hash text NOT NULL DEFAULT '', -- sha256 over the raw output payload
  recorded_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_lineage_claim
  ON public.data_lineage (claim_id, recorded_at DESC);

ALTER TABLE public.data_lineage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read data_lineage of their company claims"
ON public.data_lineage FOR SELECT
USING (
  (SELECT company_id FROM public.claims WHERE id = data_lineage.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users append data_lineage for their company claims"
ON public.data_lineage FOR INSERT
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = data_lineage.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);
