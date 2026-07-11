-- Fixes: "infinite recursion detected in policy for relation company_members" (Postgres 42P17).
--
-- Root cause: every RLS policy in the initial migration resolves company
-- membership with an inline subquery against public.company_members, and
-- company_members' own SELECT policy does the same thing against itself.
-- Evaluating any of these policies re-triggers company_members' RLS, which
-- re-triggers itself — Postgres's cycle guard aborts the query. In practice
-- this broke every authenticated request that reaches requireAuth() (and,
-- transitively, claims/documents/sof_events/clause_flags/laytime_calculations
-- and the storage policy, since all of them subquery company_members too).
--
-- Fix: move the membership check into SECURITY DEFINER helper functions
-- (same pattern already used by get_user_id_by_email). A function owned by
-- the migration role bypasses RLS for its own internal query, so it can read
-- company_members without re-entering company_members' policy — breaking the
-- cycle at its source instead of re-creating it one level down.

create or replace function public.current_user_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from public.company_members where user_id = auth.uid();
$$;

create or replace function public.is_company_member(target_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_members
    where company_id = target_company_id and user_id = auth.uid()
  );
$$;

create or replace function public.user_owns_claim(target_claim_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.claims c
    where c.id = target_claim_id and public.is_company_member(c.company_id)
  );
$$;

create or replace function public.user_owns_event(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sof_events e
    where e.id = target_event_id and public.user_owns_claim(e.claim_id)
  );
$$;

grant execute on function public.current_user_company_ids() to authenticated;
grant execute on function public.is_company_member(uuid) to authenticated;
grant execute on function public.user_owns_claim(uuid) to authenticated;
grant execute on function public.user_owns_event(uuid) to authenticated;

-- Replace every policy that used to inline-subquery company_members with one
-- that calls the helpers above instead.

drop policy if exists "Users can view their own companies" on public.companies;
create policy "Users can view their own companies"
  on public.companies for select
  using (public.is_company_member(id));

drop policy if exists "Users can view members of their company" on public.company_members;
create policy "Users can view members of their company"
  on public.company_members for select
  using (company_id in (select public.current_user_company_ids()));

drop policy if exists "Users can perform all actions on claims of their company" on public.claims;
create policy "Users can perform all actions on claims of their company"
  on public.claims for all
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

drop policy if exists "Users can perform all actions on documents of their company claims" on public.documents;
create policy "Users can perform all actions on documents of their company claims"
  on public.documents for all
  using (public.user_owns_claim(claim_id))
  with check (public.user_owns_claim(claim_id));

drop policy if exists "Users can perform all actions on sof_events of their company claims" on public.sof_events;
create policy "Users can perform all actions on sof_events of their company claims"
  on public.sof_events for all
  using (public.user_owns_claim(claim_id))
  with check (public.user_owns_claim(claim_id));

drop policy if exists "Users can perform all actions on clause_flags of their company claims" on public.clause_flags;
create policy "Users can perform all actions on clause_flags of their company claims"
  on public.clause_flags for all
  using (public.user_owns_event(event_id))
  with check (public.user_owns_event(event_id));

drop policy if exists "Users can perform all actions on laytime_calculations of their company claims" on public.laytime_calculations;
create policy "Users can perform all actions on laytime_calculations of their company claims"
  on public.laytime_calculations for all
  using (public.user_owns_claim(claim_id))
  with check (public.user_owns_claim(claim_id));

drop policy if exists "Users can only access their company's files" on storage.objects;
create policy "Users can only access their company's files"
  on storage.objects for all
  using (
    bucket_id = 'sofs'
    and auth.role() = 'authenticated'
    and public.is_company_member(((storage.foldername(name))[1])::uuid)
  );
