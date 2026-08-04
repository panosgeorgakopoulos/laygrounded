-- Phase 14: enterprise RBAC.
--
-- Before this migration a member was either `admin` or `member`, and `member`
-- meant "everything except managing the team" — including agreeing a claim,
-- generating a settlement payload, handing a bank a trade-finance token and
-- setting the money boundaries the autonomous negotiator trades inside. A
-- junior operator doing day-to-day laytime work held every one of those.
--
-- WHY TEXT + CHECK RATHER THAN A WIDER ENUM. Two reasons, both load-bearing:
--
--   1. `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction that
--      then writes the new value ("unsafe use of new value of enum type").
--      Supabase applies each migration in a transaction, so an enum widening
--      that also backfilled rows would need to be split across two files, and
--      the intermediate state would have a default nothing could insert.
--   2. Postgres cannot remove an enum value. `member` would survive forever as
--      a legal value that means nothing, and every reader would have to know
--      that. A CHECK constraint is editable, so the set of roles stays equal to
--      the set of roles the product actually has.
--
-- The enum has exactly one consumer (`company_members.role`, verified against
-- pg_attribute) and no RLS policy reads its value, so the conversion is local.

-- ── 1. Widen the column ─────────────────────────────────────────────────────
-- Default is dropped first: it is typed `app_role`, and the column cannot
-- change type while a default of the old type is attached to it.
alter table public.company_members alter column role drop default;
alter table public.company_members alter column role type text using role::text;

-- Legacy `member` becomes `operator`: the day-to-day claim role, and the one
-- reading of `member` that does not silently grant money authority to people
-- who had it only because the model was too coarse to express the difference.
-- A NULL role was reachable (the column was nullable) and resolves the same
-- way as it does in code — to the least privilege that still allows work.
update public.company_members set role = 'operator' where role is null or role = 'member';

alter table public.company_members alter column role set default 'operator';
alter table public.company_members alter column role set not null;

alter table public.company_members
  add constraint company_members_role_check
  check (role in ('viewer', 'operator', 'finance_manager', 'admin'));

drop type if exists public.app_role;

-- ── 2. Role helpers for RLS ─────────────────────────────────────────────────
--
-- SECURITY DEFINER for the same reason as `is_company_member` (see
-- 20260711000000): a policy that inline-subqueried company_members would
-- re-enter company_members' own policy and trip Postgres's recursion guard.
--
-- These keep EXECUTE for `authenticated` because they are evaluated INSIDE
-- policy expressions, which run as the querying role — revoking it would deny
-- every policy that calls them. Both are safe to expose: they answer only about
-- the caller's own membership, keyed on auth.uid(), and `anon` has no auth.uid()
-- to match. Registered in INTENTIONALLY_EXECUTABLE in definer-grants.ts.

create or replace function public.current_member_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.company_members where user_id = auth.uid() limit 1;
$$;

-- Rank, not a capability matrix. The matrix lives in src/lib/auth/roles.ts and
-- is the authority; duplicating it here would create two copies that drift, and
-- the SQL copy is the one nobody would think to update. Rank is the part of the
-- model that is structural rather than a policy decision: the roles are totally
-- ordered, so "at least a finance manager" is expressible without restating
-- which capabilities that implies.
create or replace function public.current_role_rank()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case public.current_member_role()
    when 'admin' then 3
    when 'finance_manager' then 2
    when 'operator' then 1
    when 'viewer' then 0
    else 0            -- unknown or absent: least privilege, never a default grant
  end;
$$;

-- Revoked from PUBLIC **and** anon by name. A revoke from anon alone is a no-op
-- here: Supabase's default privileges leave EXECUTE on PUBLIC (`=X` in proacl)
-- and anon inherits it, which is the same trap CLAUDE.md records for the
-- matview refreshers, seen from the other side. `authenticated` and
-- `service_role` hold direct grants, so revoking PUBLIC does not touch them.
grant execute on function public.current_member_role() to authenticated;
grant execute on function public.current_role_rank() to authenticated;
revoke execute on function public.current_member_role() from public, anon;
revoke execute on function public.current_role_rank() from public, anon;

-- ── 3. Defense in depth on the money tables ─────────────────────────────────
--
-- These three are reached through the COOKIE client, so RLS genuinely binds
-- here — unlike most of the app, where routes hold a service-role handle and
-- RLS is bypassed entirely. That is why the API-layer guard in
-- `requireCapability()` is the primary enforcement and this is the second
-- layer, not the other way round.
--
-- Reads stay open to any member: a viewer is supposed to see the bank details
-- and the grant ledger, they are simply not allowed to change them. So the
-- previous FOR ALL policies are split into read and write.

-- finance_grants: issuing or revoking a bank's access to a claim.
drop policy if exists "Users manage finance grants of their company" on public.finance_grants;

create policy "Members read finance grants of their company"
  on public.finance_grants for select
  using (public.is_company_member(company_id));

create policy "Finance managers write finance grants of their company"
  on public.finance_grants for insert
  with check (public.is_company_member(company_id) and public.current_role_rank() >= 2);

create policy "Finance managers update finance grants of their company"
  on public.finance_grants for update
  using (public.is_company_member(company_id) and public.current_role_rank() >= 2)
  with check (public.is_company_member(company_id) and public.current_role_rank() >= 2);

create policy "Finance managers delete finance grants of their company"
  on public.finance_grants for delete
  using (public.is_company_member(company_id) and public.current_role_rank() >= 2);

-- counterparty_finance: the IBAN/BIC/wallet a settlement instruction pays to.
drop policy if exists "Company members write their own counterparty finance" on public.counterparty_finance;
drop policy if exists "Company members update their own counterparty finance" on public.counterparty_finance;
drop policy if exists "Company members delete their own counterparty finance" on public.counterparty_finance;

create policy "Finance managers write their own counterparty finance"
  on public.counterparty_finance for insert
  with check (public.is_company_member(company_id) and public.current_role_rank() >= 2);

create policy "Finance managers update their own counterparty finance"
  on public.counterparty_finance for update
  using (public.is_company_member(company_id) and public.current_role_rank() >= 2)
  with check (public.is_company_member(company_id) and public.current_role_rank() >= 2);

create policy "Finance managers delete their own counterparty finance"
  on public.counterparty_finance for delete
  using (public.is_company_member(company_id) and public.current_role_rank() >= 2);

-- settlement_chain_configs: which escrow contract on which chain gets paid.
drop policy if exists "Company members insert their own chain configs" on public.settlement_chain_configs;
drop policy if exists "Company members update their own chain configs" on public.settlement_chain_configs;
drop policy if exists "Company members delete their own chain configs" on public.settlement_chain_configs;

create policy "Finance managers insert their own chain configs"
  on public.settlement_chain_configs for insert
  with check (public.is_company_member(company_id) and public.current_role_rank() >= 2);

create policy "Finance managers update their own chain configs"
  on public.settlement_chain_configs for update
  using (public.is_company_member(company_id) and public.current_role_rank() >= 2)
  with check (public.is_company_member(company_id) and public.current_role_rank() >= 2);

create policy "Finance managers delete their own chain configs"
  on public.settlement_chain_configs for delete
  using (public.is_company_member(company_id) and public.current_role_rank() >= 2);
