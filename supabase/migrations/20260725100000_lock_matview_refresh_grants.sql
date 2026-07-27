-- Lock down the cross-tenant matview refresh functions.
--
-- 20260714000002 / 20260714000004 / 20260715000002 each declared the intent
-- "service_role only" as:
--
--   REVOKE EXECUTE ON FUNCTION ... FROM public;
--   GRANT  EXECUTE ON FUNCTION ... TO service_role;
--
-- That is not sufficient on Supabase. The project's default privileges grant
-- EXECUTE on new public-schema functions to the `anon` and `authenticated`
-- roles *directly*, not through the PUBLIC pseudo-role, so a REVOKE FROM public
-- leaves those explicit grants in place. Live ACLs confirmed both roles still
-- held EXECUTE, i.e. any holder of the publishable anon key could POST
-- /rest/v1/rpc/refresh_honesty_index (and the two siblings) unauthenticated and
-- force a full cross-tenant REFRESH MATERIALIZED VIEW, repeatedly.
--
-- The matviews themselves were never readable by those roles (REVOKE ALL on the
-- relations did apply), so this was a compute-amplification vector, not a data
-- leak. Named roles are revoked explicitly here, matching the pattern the newer
-- migrations already use (see 20260724000000_get_user_id_by_phone.sql).

REVOKE EXECUTE ON FUNCTION public.refresh_honesty_index()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_honesty_index() TO service_role;

REVOKE EXECUTE ON FUNCTION public.refresh_oracle_voyage_stats()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_oracle_voyage_stats() TO service_role;

REVOKE EXECUTE ON FUNCTION public.refresh_port_honesty_and_resilience_index()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_port_honesty_and_resilience_index()
  TO service_role;

-- Event-trigger function: not invocable over PostgREST (its return type is
-- event_trigger), so this is hygiene rather than a reachable hole.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM public, anon, authenticated;
