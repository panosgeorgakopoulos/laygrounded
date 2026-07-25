-- eFTI federation grants — permissioned, scoped, revocable sharing of a claim's
-- eFTI consignment with an external authority.
--
-- An owner mints a grant for a named authority with a chosen dataset scope; the
-- authority fetches the scope-filtered, re-signed packet with an unguessable
-- token. The token is stored ONLY as a SHA-256 hash (like oauth_* / api_keys) —
-- a database leak must not yield live, usable share tokens. Access is metered on
-- the row (last_accessed_at / access_count); the tamper-evident trail records
-- the owner's create/revoke acts (as share.created / share.revoked).

create table if not exists public.efti_grants (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  authority_label text not null default '',
  -- Granted dataset sections (transport | consignment | milestones | laytime).
  dataset_scope text[] not null default '{}',
  token_hash text not null unique,
  created_by uuid,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_efti_grants_company on public.efti_grants (company_id, created_at desc);
create index if not exists idx_efti_grants_claim on public.efti_grants (claim_id);

alter table public.efti_grants enable row level security;

-- Members may read their own company's grants (to list and manage them); the
-- token_hash is a hash, not a usable credential. There is deliberately NO write
-- policy — creation and revocation run under the service role after auth, and
-- the authority's token access never uses an end-user JWT at all.
create policy "Members read their company eFTI grants" on public.efti_grants
  for select using (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid);
