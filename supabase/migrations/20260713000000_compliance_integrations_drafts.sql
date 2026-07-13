-- ERP integrations (bi-directional sync), sanctions/ETS compliance, and the
-- agentic legal drafter.

-- === 1. Claims: identity + compliance columns ===
-- vessel_imo / counterparty_name feed sanctions screening; external_source/
-- external_ref anchor rows imported from ERPs (idempotent upsert key);
-- ets_applicable marks claims whose port delay falls under EU ETS.
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS vessel_imo text,
  ADD COLUMN IF NOT EXISTS counterparty_name text,
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS ets_applicable boolean;

-- One claim per external voyage per company — the guard that makes concurrent
-- webhook deliveries race-safe (PostgREST upserts target it via on_conflict).
-- Deliberately NOT partial: NULLs are distinct in unique indexes, so manual
-- claims (external_ref IS NULL) are unaffected, and a full index is required
-- for ON CONFLICT inference through PostgREST.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_claims_external_ref
  ON public.claims (company_id, external_source, external_ref);

-- === 2. Integrations ===
CREATE TABLE IF NOT EXISTS public.integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('VESON_IMOS', 'MOCK_ERP')),
  display_name text NOT NULL DEFAULT '',
  base_url text NOT NULL DEFAULT '',
  -- API tokens / webhook secrets. Service-role only in practice: RLS lets
  -- company admins manage rows, but tokens never leave the server (API
  -- responses strip this column).
  auth jsonb NOT NULL DEFAULT '{}'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  last_error text,
  last_sync_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- === 3. Webhook logs (inbound + outbound), idempotency ledger ===
CREATE TABLE IF NOT EXISTS public.webhook_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES public.integrations (id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  event_type text NOT NULL DEFAULT '',
  -- The dedupe key: for inbound webhooks the provider's delivery/event id,
  -- for outbound pushes the sync job's idempotency key.
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'failed', 'skipped_duplicate')),
  error text,
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_webhook_idempotency
  ON public.webhook_logs (integration_id, direction, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_integration_created
  ON public.webhook_logs (integration_id, created_at DESC);

-- === 4. Outbound sync queue ===
-- Jobs are claimed with an optimistic compare-and-set on status, so any number
-- of concurrent workers can run without double-executing a job.
CREATE TABLE IF NOT EXISTS public.sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES public.integrations (id) ON DELETE CASCADE,
  claim_id uuid REFERENCES public.claims (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('push_invoice', 'push_ledger', 'pull_voyages')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Re-enqueueing the same logical push twice must be a no-op while the first
-- is still live.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sync_jobs_live
  ON public.sync_jobs (integration_id, idempotency_key)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_sync_jobs_runnable
  ON public.sync_jobs (status, next_attempt_at);

-- === 5. Compliance checks (sanctions screening snapshots) ===
CREATE TABLE IF NOT EXISTS public.compliance_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('vessel', 'counterparty')),
  subject text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('clear', 'possible_match', 'match', 'unavailable')),
  risk_score float8,
  matches jsonb NOT NULL DEFAULT '[]'::jsonb,
  source text NOT NULL DEFAULT '',
  checked_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_checks_claim ON public.compliance_checks (claim_id);

-- === 6. EU ETS estimates (one per claim, like laytime_calculations) ===
CREATE TABLE IF NOT EXISTS public.ets_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL UNIQUE REFERENCES public.claims (id) ON DELETE CASCADE,
  delay_hours float8 NOT NULL,
  fuel_tonnes_per_day float8 NOT NULL,
  co2_per_tonne_fuel float8 NOT NULL,
  eua_price_eur float8 NOT NULL,
  coverage_pct float8 NOT NULL,
  co2_tonnes float8 NOT NULL,
  estimated_cost_eur float8 NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz DEFAULT now()
);

-- === 7. Legal drafts ===
CREATE TABLE IF NOT EXISTS public.drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('demand_letter', 'counter_argument', 'settlement_proposal')),
  tone text NOT NULL DEFAULT 'firm' CHECK (tone IN ('firm', 'neutral', 'conciliatory')),
  subject text NOT NULL DEFAULT '',
  content_md text NOT NULL,
  position_analysis jsonb,
  -- Grounding verification: every monetary figure and clause citation in the
  -- letter checked against the database. A draft is never shown as "verified"
  -- unless this passed.
  grounding jsonb NOT NULL DEFAULT '{}'::jsonb,
  model text NOT NULL DEFAULT '',
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drafts_claim ON public.drafts (claim_id, created_at DESC);

-- === 8. RLS ===
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ets_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage integrations of their company"
ON public.integrations FOR ALL
USING ( company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid )
WITH CHECK ( company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid );

CREATE POLICY "Users read webhook logs of their company integrations"
ON public.webhook_logs FOR SELECT
USING (
  (SELECT company_id FROM public.integrations WHERE id = webhook_logs.integration_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users read sync jobs of their company integrations"
ON public.sync_jobs FOR SELECT
USING (
  (SELECT company_id FROM public.integrations WHERE id = sync_jobs.integration_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users manage compliance_checks of their company claims"
ON public.compliance_checks FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = compliance_checks.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = compliance_checks.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users manage ets_estimates of their company claims"
ON public.ets_estimates FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = ets_estimates.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = ets_estimates.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users manage drafts of their company claims"
ON public.drafts FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = drafts.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = drafts.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);
