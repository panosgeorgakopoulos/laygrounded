-- "Zero-day" settlement clearinghouse: perfectly matched claims skip the
-- claim-room dispute phase entirely. A claim qualifies when the voyage is
-- finished, the SoF is anchored to ERP data, the calculation exists, every
-- evidence check is corroborated, and nothing is disputed — then the
-- clearinghouse initiates an automated B2B funds transfer via the (mock)
-- banking provider and records the outcome here.

-- === 1. Settlements ===
-- claim_id is UNIQUE: one zero-day settlement per claim, and the constraint
-- (not application code) is what makes concurrent sweep runs race-safe — the
-- loser of an insert race sees 23505 and treats it as ALREADY_SETTLED.
-- `eligibility` snapshots the criteria that were true at initiation, so an
-- auditor can see exactly why funds moved even after evidence is re-run.
CREATE TABLE IF NOT EXISTS public.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL UNIQUE REFERENCES public.claims (id) ON DELETE CASCADE,
  calculation_id uuid REFERENCES public.laytime_calculations (id) ON DELETE SET NULL,
  amount float8 NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  -- collect = demurrage due to the owner; pay = despatch owed by the owner.
  direction text NOT NULL CHECK (direction IN ('collect', 'pay')),
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'cleared', 'failed')),
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text NOT NULL DEFAULT 'MOCK_BANK',
  provider_ref text,
  -- true when no banking provider is configured and the clearing was
  -- simulated in-process; the UI must never present a simulated clearing as
  -- a real funds movement.
  simulated boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL UNIQUE,
  last_error text,
  initiated_at timestamptz DEFAULT now(),
  cleared_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlements_status
  ON public.settlements (status, created_at DESC);

-- === 2. RLS ===
ALTER TABLE public.settlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage settlements of their company claims"
ON public.settlements FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = settlements.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = settlements.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);
