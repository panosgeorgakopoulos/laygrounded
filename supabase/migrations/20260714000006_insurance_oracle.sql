-- Parametric insurance trigger: LayGrounded as a neutral data oracle for
-- marine insurers. When the deterministic engine's breakdown shows a
-- continuous weather delay at or beyond a policy's threshold, a trigger row
-- is recorded and a signed webhook payload is emitted to the insurer —
-- machine-verifiable input for an automated parametric payout.

-- === 1. Insurance policies ===
-- The insurer authenticates to the read-only oracle endpoint with an API key
-- whose sha256 hash is stored here — the plaintext key (like webhook
-- secrets elsewhere in this schema) is returned exactly once at creation.
-- api_key_hash / webhook_secret never leave the server: API responses strip
-- them, and insurer access goes through the service role after key lookup.
CREATE TABLE IF NOT EXISTS public.insurance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  insurer_label text NOT NULL DEFAULT '',
  api_key_hash text NOT NULL UNIQUE,
  webhook_url text NOT NULL DEFAULT '',
  webhook_secret text NOT NULL,
  -- Continuous weather-delay hours that trigger the policy. Default 120h =
  -- the canonical "5 consecutive weather days" parametric product.
  threshold_hours float8 NOT NULL DEFAULT 120 CHECK (threshold_hours > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_policies_company
  ON public.insurance_policies (company_id);

-- === 2. Trigger ledger ===
-- One row per (policy, claim, delay window) — the UNIQUE idempotency key
-- makes the evaluation sweep re-runnable and concurrent-safe: an already
-- emitted window can never fire a second payout webhook.
CREATE TABLE IF NOT EXISTS public.insurance_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES public.insurance_policies (id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  calculation_id uuid REFERENCES public.laytime_calculations (id) ON DELETE SET NULL,
  trigger_type text NOT NULL DEFAULT 'continuous_weather_delay'
    CHECK (trigger_type IN ('continuous_weather_delay')),
  delay_hours float8 NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  threshold_hours float8 NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivery_status text NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed')),
  delivered_at timestamptz,
  last_error text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_triggers_policy
  ON public.insurance_triggers (policy_id, created_at DESC);

-- === 3. RLS ===
-- Company members see their own policies and triggers (the UI). The insurer
-- side never touches PostgREST roles: the oracle endpoint validates the API
-- key and reads via the service role.
ALTER TABLE public.insurance_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insurance_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage insurance_policies of their company"
ON public.insurance_policies FOR ALL
USING ( company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid )
WITH CHECK ( company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid );

CREATE POLICY "Users read insurance_triggers of their company policies"
ON public.insurance_triggers FOR SELECT
USING (
  (SELECT company_id FROM public.insurance_policies WHERE id = insurance_triggers.policy_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);
