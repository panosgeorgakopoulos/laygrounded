-- Pre-Fixture Pricing Oracle: cross-tenant voyage statistics backing the
-- broker-facing risk pricing API (/api/oracle/pricing).

-- === 1. Voyage stats materialized view ===
-- One row per laytime calculation with a non-empty breakdown, denormalising
-- exactly what the oracle needs: where (port), what (cargo), when (calendar
-- month of the first breakdown row), and how the voyage actually went
-- (weather delay hours, used vs allowed, excess). `verified` is true unless
-- independent evidence verification CONTRADICTED the claim — corroborated,
-- inconclusive and unchecked voyages all count as usable history; only
-- proven-false ones are demoted out of the preferred sample.
CREATE MATERIALIZED VIEW public.oracle_voyage_stats AS
SELECT
  lc.id AS calculation_id,
  lc.claim_id,
  lower(trim(c.port)) AS port_key,
  c.port AS port_label,
  lower(trim(c.cargo)) AS cargo_key,
  extract(month FROM (lc.breakdown -> 0 ->> 'start_time')::timestamptz)::int AS month,
  COALESCE(
    (
      SELECT sum((elem ->> 'duration_hours')::float8)
      FROM jsonb_array_elements(lc.breakdown) AS elem
      WHERE elem ->> 'status' = 'weather_delay'
    ),
    0
  ) AS weather_delay_hours,
  lc.used_hours,
  lc.allowed_hours,
  greatest(lc.used_hours - lc.allowed_hours, 0) AS excess_hours,
  NOT EXISTS (
    SELECT 1
    FROM public.evidence_checks ec
    WHERE ec.claim_id = lc.claim_id
      AND ec.verdict = 'contradicted'
  ) AS verified,
  lc.computed_at
FROM public.laytime_calculations lc
JOIN public.claims c ON c.id = lc.claim_id
WHERE jsonb_typeof(lc.breakdown) = 'array'
  AND jsonb_array_length(lc.breakdown) > 0
WITH DATA;

-- REFRESH ... CONCURRENTLY requires a unique index covering every row.
CREATE UNIQUE INDEX uniq_oracle_voyage_stats_calculation
  ON public.oracle_voyage_stats (calculation_id);

-- The oracle's only lookup shape: all voyages at a port in a given month.
CREATE INDEX idx_oracle_voyage_stats_port_month
  ON public.oracle_voyage_stats (port_key, month);

-- === 2. Access control ===
-- Materialized views cannot carry RLS policies, and this one aggregates
-- across every tenant. It must therefore never be readable by end-user
-- roles: the API route reads it via the service-role client and returns
-- aggregates only — never claim ids or company ids.
REVOKE ALL ON public.oracle_voyage_stats FROM anon, authenticated;

-- === 3. Refresh function ===
-- SECURITY DEFINER so the service-role RPC can refresh a view it does not
-- own; CONCURRENTLY keeps the oracle readable during refresh (which is what
-- the unique index above exists for). search_path is pinned — standard
-- hygiene for SECURITY DEFINER functions.
CREATE OR REPLACE FUNCTION public.refresh_oracle_voyage_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.oracle_voyage_stats;
END;
$$;

-- Functions are executable by PUBLIC by default; this one is service-role only.
REVOKE EXECUTE ON FUNCTION public.refresh_oracle_voyage_stats() FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_oracle_voyage_stats() TO service_role;
