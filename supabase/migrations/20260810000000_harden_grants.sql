-- Production hardening: make the grant layer agree with the RLS layer.
--
-- Found by running Supabase's own security advisor against the live project
-- after Phase 17, then checking each finding in `pg_catalog` rather than
-- trusting the lint. Two of the findings were real; the rest were correct by
-- design and are documented as such at the bottom of this file.
--
-- NEITHER OF THESE IS EXPLOITABLE TODAY. Both are cases where a control that
-- reads as "two independent layers" is in fact one layer plus an inert grant
-- waiting for someone to remove the layer above it. That is precisely the shape
-- of the three world-executable matview functions this codebase already found
-- once (see `security/definer-grants.ts`) — the lesson is that Supabase's
-- default privileges are generous and silent, so the grant has to be closed
-- explicitly and verified from the catalog.

-- ── 1. Service-role-only tables ───────────────────────────────────────────
--
-- Seven tables have RLS enabled and NO policies, which is the correct
-- deny-by-default posture for tables only the service-role client touches.
-- Verified: every code path that reads or writes them constructs
-- `createServiceRoleClient()` — the OAuth store and bearer verifier, and the
-- two public-tool routes.
--
-- But Supabase's default privileges had granted `anon` and `authenticated`
-- full DML on all seven. RLS denies it, so nothing is reachable today. What
-- makes it worth closing anyway is WHAT these tables hold: OAuth access and
-- refresh tokens, authorization codes, client secrets, and the email addresses
-- of marketing-tool leads. If RLS is ever disabled on one of them — during a
-- debugging session, or by a migration that recreates the table — an
-- unauthenticated holder of the publishable anon key gets full DML over live
-- bearer credentials. The grant should not be sitting there waiting.

revoke all on public.oauth_access_tokens from anon, authenticated;
revoke all on public.oauth_refresh_tokens from anon, authenticated;
revoke all on public.oauth_authorization_codes from anon, authenticated;
revoke all on public.oauth_clients from anon, authenticated;
revoke all on public.public_tool_leads from anon, authenticated;
revoke all on public.public_tool_usage from anon, authenticated;
revoke all on public.api_rate_limits from anon, authenticated;

-- ── 2. RLS helper functions: revoke from anon, keep authenticated ─────────
--
-- `is_company_member()` and friends are SECURITY DEFINER and were executable by
-- `anon` AND by the PUBLIC pseudo-role.
--
-- `authenticated` MUST keep EXECUTE: these are called from inside policy
-- expressions, which evaluate as the querying role, so revoking it would deny
-- every policy that calls them and lock users out of their own rows. That is
-- why `INTENTIONALLY_EXECUTABLE` exists in `security/definer-grants.ts`.
--
-- `anon` never needed it. Every one of these keys on `auth.uid()`, which is
-- NULL for an anonymous caller, so they return false or an empty set — the
-- reason this is hardening rather than a fix. And it is verified rather than
-- assumed: no policy on any table grants to `anon` or `public` while
-- referencing these functions, so nothing anonymous depends on the grant. The
-- public surfaces that DO exist (claim rooms, shared statements, the knowledge
-- base, the marketing tools) either use the service-role client after
-- validating a token, or read tables whose policies do not call these helpers.
--
-- The allowlist in `definer-grants.ts` was too coarse: it exempted these
-- functions from the anon check as well as the authenticated one, when only the
-- latter is justified. That is tightened in the same change as this migration.

revoke execute on function public.current_user_company_ids() from anon, public;
revoke execute on function public.is_company_member(uuid) from anon, public;
revoke execute on function public.user_owns_claim(uuid) from anon, public;
revoke execute on function public.user_owns_event(uuid) from anon, public;
revoke execute on function public.user_owns_integration(uuid) from anon, public;

-- Re-asserted so the intent is legible in one place and a later `create or
-- replace` (which resets ACLs to the defaults) restores the right shape.
grant execute on function public.current_user_company_ids() to authenticated;
grant execute on function public.is_company_member(uuid) to authenticated;
grant execute on function public.user_owns_claim(uuid) to authenticated;
grant execute on function public.user_owns_event(uuid) to authenticated;
grant execute on function public.user_owns_integration(uuid) to authenticated;

-- ── 3. The auth hook, closed for environments that do have it ────────────
--
-- `custom_access_token_hook` is declared in 20260711000003 and does NOT exist
-- in this project (verified: no row in `pg_proc`) — the hook was never enabled,
-- which is why the `app_metadata -> company_id` RLS policies deny every
-- end-user JWT and the routes concerned work only via service-role.
--
-- It is closed anyway, because the guard in `security/definer-grants.ts` is a
-- STATIC audit of the migration corpus, and correctly so: a fresh environment
-- that applies 20260711000003 would create the function with Supabase's default
-- privileges, i.e. executable by `anon` over PostgREST. The function reads
-- `company_members` as SECURITY DEFINER and returns claims for a caller-supplied
-- event payload, so an anonymous caller reaching it is not a theoretical
-- concern — it is only not a concern HERE because the function is absent.
--
-- Guarded, since REVOKE on a non-existent function raises rather than no-oping.
-- Supabase Auth invokes the hook as `supabase_auth_admin`, never as anon or
-- authenticated, so neither grant is needed even where it is enabled.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'custom_access_token_hook'
  ) then
    execute 'revoke execute on function public.custom_access_token_hook(jsonb) from anon, authenticated, public;';
  end if;
end $$;

-- ── What was deliberately NOT changed ─────────────────────────────────────
--
-- The `rls_enabled_no_policy` notices on those same seven tables are INFO and
-- are the intended state: no policy means no end-user access, which is exactly
-- what a service-role-only table wants. Adding permissive policies to silence a
-- linter would be the actual mistake.
--
-- NOT FIXABLE FROM SQL: Supabase Auth's leaked-password protection (HaveIBeenPwned
-- checking) is disabled. For a product where an account controls settlement
-- instructions and bank details, it should be on. It is a dashboard setting —
-- Authentication → Policies — and has to be enabled by a project owner.

-- ── 4. search_path on the one function missing it ─────────────────────────
--
-- `increment_public_tool_usage` is SECURITY INVOKER (verified via
-- `pg_proc.prosecdef`), so the mutable search_path is not the escalation vector
-- the lint warns about — it runs with the caller's own privileges, and EXECUTE
-- is already limited to `postgres` and `service_role`.
--
-- Pinned anyway, with ALTER rather than a recreate so the body is untouched.
-- It costs one statement, and it means the advisor's remaining output is
-- entirely findings that are correct by design — which is the state where the
-- next person to run it will actually read the results instead of assuming the
-- warnings are the usual ones.
alter function public.increment_public_tool_usage(text, date, text) set search_path = public;
