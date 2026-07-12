-- Elevation features: claim rooms (counterparty negotiation), independent
-- evidence verification, time-bar tracking, and settlement recording.

-- === 1. Claims: new columns ===
-- time_bar_days: contractual window (days after completion of cargo ops) to
-- present a fully documented claim. settled_*: what the claim actually closed
-- at, feeding clause P&L and future benchmarking. port_lat/lon: geocoded port
-- position used by evidence verification (weather archive lookups).
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS time_bar_days integer NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS settled_amount float8,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS port_lat float8,
  ADD COLUMN IF NOT EXISTS port_lon float8;

-- === 2. Claim shares: guest access tokens for counterparty claim rooms ===
-- A share grants read access to one claim plus the right to file event
-- proposals, via an unguessable token. Guests have no Supabase session; the
-- public /api/rooms endpoints validate the token server-side using the
-- service-role client, so no anon RLS policies are needed here.
CREATE TABLE IF NOT EXISTS public.claim_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  counterparty_label text NOT NULL DEFAULT '',
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_shares_claim ON public.claim_shares (claim_id);

-- === 3. Event proposals: counterparty amendments awaiting owner decision ===
CREATE TABLE IF NOT EXISTS public.event_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  share_id uuid REFERENCES public.claim_shares (id) ON DELETE SET NULL,
  event_id uuid REFERENCES public.sof_events (id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('amend', 'add', 'remove')),
  proposed_occurred_at timestamptz,
  proposed_event_type text,
  note text NOT NULL DEFAULT '',
  proposed_by_label text NOT NULL DEFAULT 'Counterparty',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_at timestamptz,
  created_at timestamptz DEFAULT now(),
  -- amend/add must carry a proposed time; remove must reference an event.
  CONSTRAINT proposal_shape CHECK (
    (action = 'remove' AND event_id IS NOT NULL)
    OR (action = 'amend' AND event_id IS NOT NULL AND proposed_occurred_at IS NOT NULL)
    OR (action = 'add' AND proposed_occurred_at IS NOT NULL AND proposed_event_type IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_event_proposals_claim_status ON public.event_proposals (claim_id, status);

-- === 4. Evidence checks: independent corroboration of SoF events ===
CREATE TABLE IF NOT EXISTS public.evidence_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  event_id uuid REFERENCES public.sof_events (id) ON DELETE CASCADE,
  check_type text NOT NULL CHECK (check_type IN ('weather', 'position')),
  verdict text NOT NULL CHECK (verdict IN ('corroborated', 'contradicted', 'inconclusive', 'unavailable')),
  summary text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_checks_claim ON public.evidence_checks (claim_id);

-- === 5. RLS ===
ALTER TABLE public.claim_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can perform all actions on claim_shares of their company claims"
ON public.claim_shares FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = claim_shares.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = claim_shares.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users can perform all actions on event_proposals of their company claims"
ON public.event_proposals FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = event_proposals.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = event_proposals.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users can perform all actions on evidence_checks of their company claims"
ON public.evidence_checks FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = evidence_checks.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = evidence_checks.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);
