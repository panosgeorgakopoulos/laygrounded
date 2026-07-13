-- Frontier expansion tier: environmental asset-liability engine (CII /
-- biofouling / SFTW ledger targets), the immutable Merkle-notarized
-- compliance ledger, the port honesty & resilience index, and the arrest
-- pre-filing HITL gate.
--
-- Chain-linkage note: the blueprint's parent_claim_id / chain-tier columns
-- already landed in 20260714000005_charter_chain.sql (parent_claim_id,
-- chain_role, chain_depth — chain_depth IS the tier) and event-level locks
-- live on sof_events.locked. Only the claim-level notarization freeze is new.

-- === 1. Claims: notarization lock ===
-- Set when a time-proof snapshot has been notarized into compliance_ledger
-- and the owner chooses to freeze the record: a locked claim's snapshot is
-- being relied on externally (arbitration, insurers, downstream chain tiers),
-- so mutating routes should refuse edits while it is set.
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false;

-- === 2. Vessel analytics profiles ===
-- Per-tenant vessel telemetry baseline backing the carbon engine: CII
-- standing, speed/consumption curve, and hull-cleaning history (biofouling
-- clock). consumption_curve shape (documented, validated in TypeScript):
--   { "at_berth_aux_tonnes_per_day": 4.0,
--     "sea_curve": [ { "speed_knots": 12.0, "tonnes_per_day": 20.0 }, ... ] }
CREATE TABLE IF NOT EXISTS public.vessel_analytics_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  vessel_imo text NOT NULL,
  vessel_name text NOT NULL DEFAULT '',
  cii_rating char(1) CHECK (cii_rating IN ('A', 'B', 'C', 'D', 'E')),
  -- Attained/required CII in gCO2 per dwt-nm, per IMO MEPC.353/354(78).
  attained_cii numeric(10, 4),
  required_cii numeric(10, 4),
  dwt numeric(12, 2),
  annual_distance_nm numeric(12, 1),
  baseline_speed numeric(5, 2),
  consumption_curve jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_hull_cleaning timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (company_id, vessel_imo)
);

ALTER TABLE public.vessel_analytics_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage vessel profiles of their company"
ON public.vessel_analytics_profiles FOR ALL
USING (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid)
WITH CHECK (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid);

-- === 3. Compliance ledger (append-only, cryptographically signed) ===
-- One row per audited compliance finding on a claim: MRV/ETS exposure, CII
-- degradation, biofouling penalties, SFTW restitution, or a full time-proof
-- snapshot. cryptographic_signature is the SHA-256 Merkle root over the
-- canonicalized row state + the CP clause configuration in force, computed
-- by src/lib/legal/prosecution.ts — the row is verifiable evidence, not just
-- a cache. Append-only by construction: SELECT and INSERT policies only, no
-- UPDATE/DELETE — history cannot be rewritten through PostgREST.
CREATE TABLE IF NOT EXISTS public.compliance_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  entry_kind text NOT NULL CHECK (
    entry_kind IN ('mrv_ets', 'cii_degradation', 'biofouling', 'sftw_arbitration', 'green_twin', 'time_proof')
  ),
  scope3_co2_tonnes numeric(14, 3),
  mrv_co2_tonnes numeric(14, 3),
  eua_liability_eur numeric(14, 2),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  cryptographic_signature text NOT NULL,
  signature_algo text NOT NULL DEFAULT 'sha256-merkle-v1',
  recorded_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  recorded_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_ledger_claim
  ON public.compliance_ledger (claim_id, recorded_at DESC);

ALTER TABLE public.compliance_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read compliance_ledger of their company claims"
ON public.compliance_ledger FOR SELECT
USING (
  (SELECT company_id FROM public.claims WHERE id = compliance_ledger.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

CREATE POLICY "Users append compliance_ledger for their company claims"
ON public.compliance_ledger FOR INSERT
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = compliance_ledger.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);

-- === 4. Port honesty & resilience index ===
-- Cross-tenant materialized aggregation, grain (port, calendar month):
--   * weather_contradiction_rate — share of DECISIVE weather evidence checks
--     (corroborated or contradicted; inconclusive/unavailable prove nothing)
--     where the archive contradicted the SoF, keyed to the month of the
--     checked event so seasonality is real;
--   * median/p90 congestion delay — NOR tendered → first berthing (BERTHED
--     or ALL_FAST) gap per claim, from confirmed events only.
-- Same privacy posture as honesty_index / oracle_voyage_stats: matviews
-- cannot carry RLS, so zero grants to end-user roles; the API route reads it
-- via the service-role client, applies the k-anonymity floor, and returns
-- aggregates only — never claim or company identifiers.
CREATE MATERIALIZED VIEW public.port_honesty_and_resilience_index AS
WITH weather_checks AS (
  SELECT
    lower(trim(c.port))                       AS port_key,
    trim(c.port)                              AS port_label,
    extract(month FROM e.occurred_at)::int    AS month,
    ec.verdict
  FROM public.evidence_checks ec
  JOIN public.claims c ON c.id = ec.claim_id
  JOIN public.sof_events e ON e.id = ec.event_id
  WHERE ec.check_type = 'weather'
),
weather_agg AS (
  SELECT
    port_key,
    min(port_label) AS port_label,
    month,
    count(*) AS weather_checks_total,
    count(*) FILTER (WHERE verdict IN ('corroborated', 'contradicted')) AS weather_decisive_checks,
    count(*) FILTER (WHERE verdict = 'contradicted') AS weather_contradicted_checks
  FROM weather_checks
  GROUP BY port_key, month
),
claim_congestion AS (
  SELECT
    e.claim_id,
    min(e.occurred_at) FILTER (WHERE e.event_type = 'NOR_TENDERED') AS nor_at,
    min(e.occurred_at) FILTER (WHERE e.event_type IN ('BERTHED', 'ALL_FAST')) AS berthed_at
  FROM public.sof_events e
  WHERE e.status IN ('accepted', 'edited')
  GROUP BY e.claim_id
),
congestion_agg AS (
  SELECT
    lower(trim(c.port)) AS port_key,
    min(trim(c.port)) AS port_label,
    extract(month FROM cc.nor_at)::int AS month,
    count(*) AS voyages_observed,
    percentile_cont(0.5) WITHIN GROUP (
      ORDER BY extract(epoch FROM (cc.berthed_at - cc.nor_at)) / 3600.0
    ) AS median_congestion_delay_hours,
    percentile_cont(0.9) WITHIN GROUP (
      ORDER BY extract(epoch FROM (cc.berthed_at - cc.nor_at)) / 3600.0
    ) AS p90_congestion_delay_hours
  FROM claim_congestion cc
  JOIN public.claims c ON c.id = cc.claim_id
  WHERE cc.nor_at IS NOT NULL
    AND cc.berthed_at IS NOT NULL
    AND cc.berthed_at >= cc.nor_at
  GROUP BY lower(trim(c.port)), extract(month FROM cc.nor_at)::int
)
SELECT
  COALESCE(w.port_key, g.port_key) AS port_key,
  COALESCE(w.port_label, g.port_label) AS port_label,
  COALESCE(w.month, g.month) AS month,
  COALESCE(w.weather_checks_total, 0) AS weather_checks_total,
  COALESCE(w.weather_decisive_checks, 0) AS weather_decisive_checks,
  COALESCE(w.weather_contradicted_checks, 0) AS weather_contradicted_checks,
  CASE
    WHEN COALESCE(w.weather_decisive_checks, 0) > 0
    THEN w.weather_contradicted_checks::float8 / w.weather_decisive_checks
  END AS weather_contradiction_rate,
  COALESCE(g.voyages_observed, 0) AS voyages_observed,
  g.median_congestion_delay_hours,
  g.p90_congestion_delay_hours
FROM weather_agg w
FULL OUTER JOIN congestion_agg g
  ON g.port_key = w.port_key AND g.month = w.month
WITH DATA;

-- REFRESH ... CONCURRENTLY requires a unique index covering every row;
-- (port_key, month) is the view's natural grain and its only lookup shape.
CREATE UNIQUE INDEX uniq_port_honesty_resilience
  ON public.port_honesty_and_resilience_index (port_key, month);

REVOKE ALL ON public.port_honesty_and_resilience_index FROM anon, authenticated;

-- SECURITY DEFINER with pinned search_path — same hygiene as the sibling
-- matview refresh functions; service-role EXECUTE only.
CREATE OR REPLACE FUNCTION public.refresh_port_honesty_and_resilience_index()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.port_honesty_and_resilience_index;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refresh_port_honesty_and_resilience_index() FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_port_honesty_and_resilience_index() TO service_role;

-- === 5. Arrest pre-filing dossier: new draft kind + HITL gate ===
-- The prosecution module emits deterministic, template-based dossiers that
-- MUST pass a human (admiralty counsel) before anything is filed — same
-- pattern as protest drafts and settlements.
ALTER TABLE public.drafts DROP CONSTRAINT IF EXISTS drafts_kind_check;
ALTER TABLE public.drafts ADD CONSTRAINT drafts_kind_check
  CHECK (kind IN ('demand_letter', 'counter_argument', 'settlement_proposal', 'letter_of_protest', 'arrest_dossier'));

ALTER TABLE public.pending_human_reviews DROP CONSTRAINT IF EXISTS pending_human_reviews_subject_type_check;
ALTER TABLE public.pending_human_reviews ADD CONSTRAINT pending_human_reviews_subject_type_check
  CHECK (subject_type IN ('protest_draft', 'settlement', 'arrest_dossier'));
