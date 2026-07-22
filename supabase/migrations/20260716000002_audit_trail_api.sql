-- Audit Trail API: enterprise ERP/TMS integration surface.
--
-- Four tables and one function behind /api/v1/audit/*: API keys (hashed),
-- outbound webhook registrations, an at-most-once delivery ledger, and a
-- shared-store rate limiter.
--
-- Why a rate-limit TABLE. The existing limiter in src/middleware.ts is an
-- in-memory Map keyed by IP: per-instance (N instances ⇒ N× the limit),
-- reset on cold start, and keyed on the wrong subject — an ERP behind NAT is
-- one IP for many tenants, and one tenant may call from many IPs. For a
-- contractual per-key quota the counter has to be shared and keyed by the
-- API key. Postgres is the shared store this deployment already has.

-- === 1. API keys ===
-- Only the SHA-256 hash is stored; the plaintext is shown once at creation
-- and is unrecoverable afterwards. SHA-256 (not bcrypt) is deliberate and
-- correct here: these are 192-bit random tokens, not user-chosen passwords,
-- so there is no dictionary to slow down — and an auth path that runs on
-- every API request must not pay a KDF.
CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  label text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  -- Non-secret leading fragment ("lgk_ab12cd34"), so a key can be identified
  -- in the UI and in logs without ever storing the secret.
  key_prefix text NOT NULL,
  -- Least privilege: a TMS that only pulls calculations gets no write scope.
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- Per-key quota, requests per minute.
  rate_limit_per_minute integer NOT NULL DEFAULT 120
    CHECK (rate_limit_per_minute > 0 AND rate_limit_per_minute <= 100000),
  last_used_at timestamptz,
  expires_at timestamptz,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_api_keys_company ON public.api_keys (company_id, created_at DESC);

-- === 2. Webhook registrations ===
CREATE TABLE IF NOT EXISTS public.api_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  url text NOT NULL,
  -- Returned once at creation; signs every delivery
  -- (x-laygrounded-signature: sha256=<hmac>), same scheme as every other
  -- outbound webhook in this codebase.
  secret text NOT NULL,
  event_types text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_webhooks_company ON public.api_webhooks (company_id, status);

-- === 3. Delivery ledger ===
-- Not webhook_logs: that table is FK'd to integrations (ERP adapters) and is
-- the idempotency ledger for that surface. The unique key below is what makes
-- time-bar alerts at-most-once per logical event — a claim crossing into
-- 'warning' fires once, not once per sweep, however often the sweep runs.
CREATE TABLE IF NOT EXISTS public.api_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES public.api_webhooks (id) ON DELETE CASCADE,
  claim_id uuid REFERENCES public.claims (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  response_status integer,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_api_webhook_deliveries_webhook
  ON public.api_webhook_deliveries (webhook_id, created_at DESC);

-- === 4. Rate limiter (shared store) ===
-- Fixed window: one row per (key, minute). Simpler than a sliding window and
-- honest about its edge — a caller can burst up to 2× the quota across a
-- window boundary. Documented in the OpenAPI description rather than hidden.
-- Old rows are disposable; prune anything older than an hour.
CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  api_key_id uuid NOT NULL REFERENCES public.api_keys (id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, window_start)
);

-- Atomic consume-and-report. INSERT … ON CONFLICT DO UPDATE is a single
-- statement, so concurrent requests across instances cannot both read the
-- same count and both decide they are under quota — which an application-side
-- read-then-write would allow.
CREATE OR REPLACE FUNCTION public.consume_api_rate_limit(
  p_api_key_id uuid,
  p_window_start timestamptz,
  p_limit integer
)
RETURNS TABLE (allowed boolean, request_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.api_rate_limits (api_key_id, window_start, request_count)
  VALUES (p_api_key_id, p_window_start, 1)
  ON CONFLICT (api_key_id, window_start)
  DO UPDATE SET request_count = api_rate_limits.request_count + 1
  RETURNING api_rate_limits.request_count INTO v_count;

  RETURN QUERY SELECT (v_count <= p_limit), v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_api_rate_limit(uuid, timestamptz, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_api_rate_limit(uuid, timestamptz, integer) TO service_role;

-- === 5. RLS ===
-- API callers hold no Supabase session: the routes authenticate the key and
-- then read through the service role, scoped to the key's company. These
-- policies exist so the OWNER (a logged-in user managing their keys in the
-- app) sees only their own.
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage API keys of their company"
ON public.api_keys FOR ALL
USING (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid)
WITH CHECK (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid);

CREATE POLICY "Users manage webhooks of their company"
ON public.api_webhooks FOR ALL
USING (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid)
WITH CHECK (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid);

CREATE POLICY "Users read webhook deliveries of their company"
ON public.api_webhook_deliveries FOR SELECT
USING (
  (SELECT company_id FROM public.api_webhooks WHERE id = api_webhook_deliveries.webhook_id)
  = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

-- No policy for api_rate_limits: counters are service-role only. RLS is on
-- with zero policies, so authenticated/anon read nothing — a tenant must not
-- be able to inspect or tamper with its own quota counters.
