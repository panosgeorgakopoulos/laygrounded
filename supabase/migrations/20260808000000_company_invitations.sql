-- Phase 16: invitations as records, not as pre-created memberships.
--
-- WHAT WAS WRONG BEFORE. `POST /api/settings/members` inserted a
-- `company_members` row the moment an admin typed an email address. That is a
-- membership, not an invitation, and treating the two as the same thing meant:
--
--   * the invited person held a role in a tenant they had never agreed to join,
--     and counted against `wouldOrphanCompany`'s admin census while doing so;
--   * "pending" was inferred from `auth.users.last_sign_in_at` — a property of
--     the ACCOUNT, not of the invitation, so a person who had ever signed in
--     anywhere read as an active colleague of a company they had never seen;
--   * there was no expiry, because there was nothing to expire;
--   * and an invitation could not be withdrawn except by deleting a membership,
--     which is a different act with a different audit meaning.
--
-- An invitation is an offer with its own lifecycle: made, accepted, withdrawn,
-- or timed out. It gets its own table.
--
-- THE TOKEN IS STORED AS A HASH, and this is the same reasoning as
-- `finance_grants` and the OAuth tokens: the plaintext is shown to the admin
-- once, at creation, and is never recoverable from the database. A leaked
-- backup should not be a set of live keys into every tenant that has an
-- outstanding invitation.

create table if not exists public.company_invitations (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null references public.companies (id) on delete cascade,

  -- The invitation is BOUND TO THIS ADDRESS. Redemption checks it against the
  -- signed-in user's email, so a forwarded or leaked link is useless to anyone
  -- else — it is an invitation to a person, not a bearer ticket into a tenant
  -- whose claims carry bank details and settlement instructions.
  --
  -- Stored lowercased by the writer; the unique index below folds case anyway
  -- so that "Ops@fleet.com" and "ops@fleet.com" cannot both be outstanding.
  email text not null,

  -- The role the invitee gets on acceptance. Same CHECK as company_members —
  -- restated rather than shared because a domain would have to be created and
  -- dropped in lockstep with the enum removal in 20260805000000.
  role text not null default 'operator'
    check (role in ('viewer', 'operator', 'finance_manager', 'admin')),

  -- SHA-256 of the plaintext token. Unique so a lookup by hash is an index
  -- probe and a collision is a constraint violation rather than an ambiguity.
  token_hash text not null unique,

  -- Who offered. ON DELETE SET NULL: an invitation accepted last year is still
  -- a true record of how somebody got in, even after the admin who sent it has
  -- left. Losing the whole row would erase the provenance of a live membership.
  invited_by uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),

  -- Not nullable, and no "never expires" escape hatch. An invitation that sits
  -- valid forever is a credential nobody is tracking; the writer sets this from
  -- INVITATION_TTL_DAYS in src/lib/auth/invitations.ts.
  expires_at timestamptz not null,

  -- The three terminal states. All nullable, all mutually exclusive in
  -- practice, and deliberately NOT collapsed into a single `status` column:
  -- each carries a timestamp that answers a different question in an audit
  -- ("when did they join" vs "when was this withdrawn"), and a status enum
  -- would need three more columns beside it to say the same thing.
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null
);

-- At most ONE outstanding invitation per (company, email). Partial, so the
-- history of superseded invitations is kept: re-inviting somebody whose
-- invitation expired must work, and must not silently overwrite the record of
-- the first offer.
--
-- Case-folded, because an admin who types "Ops@Fleet.com" after "ops@fleet.com"
-- means the same person, and two live tokens for one address is two things to
-- revoke when only one is remembered.
create unique index if not exists company_invitations_one_outstanding
  on public.company_invitations (company_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- The onboarding page's question: "does the person signing in right now have
-- anything waiting for them?" Asked by email across all companies, so it cannot
-- use the index above.
create index if not exists company_invitations_pending_by_email
  on public.company_invitations (lower(email))
  where accepted_at is null and revoked_at is null;

create index if not exists company_invitations_company_idx
  on public.company_invitations (company_id, created_at desc);

alter table public.company_invitations enable row level security;

-- READ: any member of the company, matching the team page's existing rule that
-- who-is-in-the-team is not privileged information. Knowing an invitation to
-- ops@fleet.com is outstanding is the same class of fact as knowing ops@fleet
-- is a colleague.
--
-- NOTE the token_hash column is readable under this policy. That is fine and
-- deliberate: it is a hash, it is not the credential, and hiding it would need
-- column-level grants for no security gain. What must never be readable is the
-- plaintext, and the plaintext is not stored anywhere.
drop policy if exists "Company members read their invitations" on public.company_invitations;
create policy "Company members read their invitations"
  on public.company_invitations for select
  using (public.is_company_member(company_id));

-- NO WRITE POLICIES AT ALL, and that is the whole design rather than an
-- omission. Every write happens on a trusted server path holding the
-- service-role client, guarded by `requireCapability("team.manage")`:
--
--   * creating an invitation needs an admin AND a Supabase auth-admin call to
--     send the email — already service-role territory;
--   * accepting one is performed BY THE INVITEE, who by definition is not yet a
--     member and so passes no `is_company_member` policy that could authorise
--     the insert. A policy permissive enough to let them accept would have to
--     be permissive enough to let anyone insert a membership row, which is the
--     tenant boundary itself.
--
-- That second point is the load-bearing one. It is the same reason
-- `company_members` has only a SELECT policy (see 20260805000000): "may I join
-- this company" cannot be answered by a policy on the table that decides who is
-- in the company.
--
-- AND THE GRANTS ARE TIGHTENED TO MATCH, because "no write policies" is only
-- half a statement. Supabase's default privileges hand `anon` and
-- `authenticated` full DML on every new table in `public` — verified in
-- `pg_catalog`, not assumed — so a table whose design is "reads for members,
-- writes only via service-role" ships with INSERT/UPDATE/DELETE granted to
-- every end-user role. RLS does deny those today, which is exactly what makes
-- it easy to miss: the grant is inert until somebody adds a permissive policy
-- for an unrelated reason, and then it is not.
--
-- This is the table-level twin of the SECURITY DEFINER lesson in the root
-- CLAUDE.md — revoke from the roles BY NAME, and verify from the catalog.
-- Phase 15 did the same thing to `notifications`, dropping UPDATE in favour of
-- a column-wise grant.
revoke all on public.company_invitations from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.company_invitations from authenticated;
grant select on public.company_invitations to authenticated;

comment on table public.company_invitations is
  'Outstanding and historical offers to join a company. The token is stored only as a SHA-256 hash; the plaintext is shown to the inviting admin once. Bound to an email address, so a leaked link cannot be redeemed by anyone else. All writes go through the service-role client behind a team.manage capability check.';
