-- Port waiting-time & congestion index.
--
-- Aggregates NOR→berth waiting time per port per month across every
-- participating tenant. Unlike `honesty_index` and `oracle_voyage_stats`, which
-- feed authenticated in-app features, this one is designed to back a PUBLIC
-- page — so it carries a second k-anonymity dimension and an explicit tenant
-- opt-out, neither of which the internal matviews need.
--
-- Why a distinct-company floor and not just a voyage count: five voyages that
-- all belong to one charterer is that charterer's private operating data
-- republished with a port's name on it. A count alone cannot tell the
-- difference. Both floors are applied in `src/lib/intel/congestion.ts` so they
-- are unit-testable and tunable without a migration; the view itself carries the
-- raw counts and is never exposed directly.

-- === 1. Tenant opt-out ===
-- Default true keeps the index useful on day one and matches how the existing
-- cross-tenant matviews already treat every tenant's data. Because this one can
-- become public, the flag is a real column that the view respects, so a tenant
-- can be withdrawn without code changes.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS share_market_data boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.companies.share_market_data IS
  'When false, this company''s voyages are excluded from cross-tenant market aggregates such as the public port congestion index.';

-- === 2. Per-voyage waiting times ===
-- One row per claim that has both a confirmed NOR and a confirmed berthing.
-- Only accepted/edited events count: a suggested event is an unreviewed model
-- output, and publishing statistics built on those would put unverified numbers
-- into the market's mouth.
CREATE MATERIALIZED VIEW public.port_congestion_stats AS
WITH milestones AS (
  SELECT
    e.claim_id,
    min(e.occurred_at) FILTER (WHERE e.event_type = 'NOR_TENDERED')       AS nor_at,
    min(e.occurred_at) FILTER (WHERE e.event_type = 'ALL_FAST')           AS berthed_at,
    max(e.occurred_at) FILTER (
      WHERE e.event_type IN ('COMPLETED_LOADING', 'COMPLETED_DISCHARGE')
    )                                                                      AS completed_at
  FROM public.sof_events e
  WHERE e.status IN ('accepted', 'edited')
  GROUP BY e.claim_id
)
SELECT
  c.id                              AS claim_id,
  c.company_id,
  lower(trim(c.port))               AS port_key,
  c.port                            AS port_label,
  lower(trim(coalesce(c.cargo, ''))) AS cargo_key,
  extract(year  FROM m.nor_at)::int AS year,
  extract(month FROM m.nor_at)::int AS month,
  extract(epoch FROM (m.berthed_at - m.nor_at)) / 3600.0 AS waiting_hours,
  CASE
    WHEN m.completed_at IS NOT NULL
      THEN extract(epoch FROM (m.completed_at - m.berthed_at)) / 3600.0
  END                               AS working_hours,
  m.nor_at
FROM milestones m
JOIN public.claims c    ON c.id = m.claim_id
JOIN public.companies co ON co.id = c.company_id
WHERE m.nor_at IS NOT NULL
  AND m.berthed_at IS NOT NULL
  -- Clock skew and data-entry errors would otherwise publish negative or
  -- absurd waits. A month at anchor is already extreme; beyond that is a typo.
  AND m.berthed_at > m.nor_at
  AND extract(epoch FROM (m.berthed_at - m.nor_at)) / 3600.0 <= 720
  AND coalesce(trim(c.port), '') <> ''
  AND co.share_market_data
WITH DATA;

CREATE UNIQUE INDEX uniq_port_congestion_stats_claim
  ON public.port_congestion_stats (claim_id);

CREATE INDEX idx_port_congestion_stats_port_period
  ON public.port_congestion_stats (port_key, year, month);

-- === 3. Access control ===
-- Materialized views cannot carry RLS and this one spans every tenant. It holds
-- company_id (needed to count distinct participants for the k-floor), so it is
-- strictly service-role only; the route aggregates and never returns an id.
REVOKE ALL ON public.port_congestion_stats FROM anon, authenticated;

-- === 4. Refresh ===
CREATE OR REPLACE FUNCTION public.refresh_port_congestion_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.port_congestion_stats;
END;
$$;

-- Revoked from the named roles, not just `public`: on Supabase, default
-- privileges grant EXECUTE to anon and authenticated directly, so a revoke from
-- the PUBLIC pseudo-role alone is a no-op against them (see
-- 20260725100000_lock_matview_refresh_grants.sql, and the guard in
-- src/lib/security/definer-grants.test.ts).
REVOKE EXECUTE ON FUNCTION public.refresh_port_congestion_stats()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_port_congestion_stats() TO service_role;
