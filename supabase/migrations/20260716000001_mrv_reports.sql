-- EU MRV annual reports: sealed, company-scoped, append-only.
--
-- Why not compliance_ledger: that table is claim-scoped (claim_id NOT NULL)
-- and an MRV annual report spans every voyage of a company in a reporting
-- period. Its entry_kind CHECK is also claim-level carbon findings, not
-- period reports. So MRV reports get their own table rather than bending a
-- claim ledger around a company artifact.
--
-- Append-only by design: each row is a cryptographic seal of what the book
-- looked like at `sealed_at`. Replacing a seal on re-run — the pattern used
-- for evidence/compliance snapshots elsewhere — would destroy the proof that
-- the earlier state ever existed, which is the only thing a seal is for.
-- Read the latest by (company_id, reporting_period, sealed_at DESC).

CREATE TABLE IF NOT EXISTS public.mrv_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  -- Calendar year under Reg (EU) 2015/757.
  reporting_period integer NOT NULL CHECK (reporting_period BETWEEN 2015 AND 2100),
  -- The full MrvAnnualReport as generated (voyage rows, monitoring status,
  -- gaps). The seal is computed over this exact document.
  report jsonb NOT NULL,
  -- Merkle root over the report's leaves; algo matches the legal notary's
  -- SNAPSHOT_ALGO so one verification method covers both artifacts.
  merkle_root text NOT NULL,
  signature_algo text NOT NULL DEFAULT 'sha256-merkle-v1',
  leaf_count integer NOT NULL DEFAULT 0,
  -- Mirrored out of the JSON so the honest state is queryable without
  -- parsing, and so a constraint can enforce it.
  submittable boolean NOT NULL DEFAULT false,
  -- Only an accredited MRV verifier can move a report beyond 'unverified',
  -- and that happens outside this system. The CHECK exists so no code path
  -- can quietly write a self-certified report into the database.
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status = 'unverified'),
  generated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  sealed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mrv_reports_company_period
  ON public.mrv_reports (company_id, reporting_period, sealed_at DESC);

ALTER TABLE public.mrv_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage MRV reports of their company"
ON public.mrv_reports FOR ALL
USING (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid)
WITH CHECK (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid);
