-- Trade-finance grants: zero-trust, claim-scoped access for banks and auditors.
--
-- A bank financing one claim gets a token that opens exactly that claim and
-- nothing else. Not an API key: an API key is tenant-wide, and a third party
-- with no account and no notice should never hold one.
--
-- Storage discipline mirrors every other credential in this schema — only the
-- SHA-256 hash is kept, so the plaintext exists once, in the response that
-- created it. Same as api_keys, oauth tokens and efti_grants.

create table if not exists public.finance_grants (
  id uuid primary key default gen_random_uuid(),
  -- The ONE claim this token opens. The bank never supplies a claim id; it is
  -- read from the grant, which is what makes traversal structurally impossible
  -- rather than merely checked for.
  claim_id uuid not null references public.claims (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Who the token was issued to, for the tenant's own audit.
  institution_label text not null,
  purpose text not null default 'factoring'
    check (purpose in ('factoring', 'audit', 'due_diligence')),
  token_hash text not null unique,
  -- Non-secret leading fragment for display in the issuing UI.
  token_prefix text not null default '',
  expires_at timestamptz not null,
  -- Null means unlimited reads until expiry. A factoring decision is usually
  -- made once, so a tenant can burn the token after N reads.
  max_access_count integer check (max_access_count is null or max_access_count > 0),
  access_count integer not null default 0,
  last_accessed_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  revoke_reason text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_finance_grants_claim on public.finance_grants (claim_id, created_at desc);
create index if not exists idx_finance_grants_company on public.finance_grants (company_id, created_at desc);

-- === Access ledger ===
-- Every redemption, admitted or refused. A bank asking to see a claim is an
-- event the tenant is entitled to see, and a refused attempt (a revoked token
-- still being presented, a mismatched claim id) is the more interesting half:
-- it is the signal that a credential has leaked or is being probed.
create table if not exists public.finance_grant_accesses (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.finance_grants (id) on delete cascade,
  admitted boolean not null,
  -- 'revoked' | 'expired' | 'exhausted' | 'claim_mismatch' when refused.
  refusal_reason text,
  -- The claim id the caller asserted in the URL, recorded verbatim when it did
  -- not match — that is evidence of a traversal attempt, not noise.
  asserted_claim_id uuid,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_finance_grant_accesses_grant
  on public.finance_grant_accesses (grant_id, created_at desc);

-- === RLS ===
-- Tenant members manage their own grants. The bank's own read path holds no
-- Supabase session at all — it presents a bearer token, which the route
-- validates before touching anything with the service-role client, exactly as
-- rooms.ts and efti_grants do. No policy here grants anything to anon.
alter table public.finance_grants enable row level security;
alter table public.finance_grant_accesses enable row level security;

create policy "Users manage finance grants of their company"
  on public.finance_grants for all
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

-- Read-only for users: rows are written by the redemption path under service
-- role, and an audit trail a tenant could edit would not be one.
create policy "Users read finance grant accesses of their company"
  on public.finance_grant_accesses for select
  using (
    exists (
      select 1 from public.finance_grants g
      where g.id = finance_grant_accesses.grant_id
        and public.is_company_member(g.company_id)
    )
  );
