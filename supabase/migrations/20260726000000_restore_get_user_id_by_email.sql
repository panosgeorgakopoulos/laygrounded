-- Restore get_user_id_by_email, and lock its grants.
--
-- Two separate problems, both found by the SECURITY DEFINER grant audit
-- (src/lib/security/definer-grants.test.ts):
--
-- 1. MISSING FROM THE HOSTED DB. The function is declared in
--    00000000000000_init.sql and in the root supabase_setup.sql, but the live
--    catalog has only its sibling get_user_id_by_phone — so init.sql's version
--    was never applied here. Two call sites depend on it:
--      - /api/v1/ingestion/email  → every inbound SoF email was rejected
--        "SENDER_NOT_A_MEMBER", i.e. the whole email ingestion channel was dead.
--      - /api/settings/members    → an invite for a user who already has an
--        account fell through to the "new user" branch, which also SKIPS the
--        USER_ALREADY_IN_ANOTHER_COMPANY guard that keeps a user from getting a
--        second company_members row (requireAuth assumes exactly one).
--    Both swallowed the PostgREST error and read a null result as "no such
--    user", which is why this stayed silent. The routes are being fixed to
--    surface the error too; this migration supplies the function itself.
--
-- 2. UNLOCKED GRANTS. init.sql created it with no REVOKE at all, so on Supabase
--    it was executable by anon and authenticated by default. It reads auth.users
--    as its owner, so an unauthenticated caller could confirm whether any given
--    email has an account — a user-enumeration oracle. Only service-role paths
--    call it.
--
-- CREATE OR REPLACE so this is a no-op on any environment where init.sql did
-- apply; the REVOKE then fixes the grants there too.
--
-- One deliberate behaviour change from init.sql's version: the comparison is
-- now case-insensitive. Supabase stores emails lowercased, and /api/settings/
-- members already lowercases its input, but the email-ingestion route passes the
-- sender address straight off the inbound message — so a "Ops@Example.com" From
-- header would previously have failed to resolve an account that exists.

create or replace function get_user_id_by_email(email_addr text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from auth.users
  where lower(email) = lower(email_addr)
    and coalesce(email_addr, '') <> ''
  limit 1;
$$;

revoke execute on function get_user_id_by_email(text) from public, anon, authenticated;
grant execute on function get_user_id_by_email(text) to service_role;
