-- Phase 8 — engine rule-set versioning, and counterparty banking/wallet details.

-- ============================================================================
-- 1. claims.engine_version — which laytime RULE SET computed this claim
-- ============================================================================
--
-- The engine now carries two rule sets. v2 corrects one defect (an agreed
-- EXCEPTED_PERIOD absorbed by GENCON 94's SHINC branch); v1 is frozen, not
-- deprecated, because a published calculation is evidence: a claim already
-- served, notarised or agreed must keep reproducing the figures on the
-- document, and the offline verifier must keep returning the published
-- conformance root bc9f24fdab910a1b for the 500 cases blessed under it.
--
-- The two-step default is the point. ADD COLUMN with DEFAULT 1 backfills every
-- existing row to 1 in one pass; the default is then moved to 2 so that new
-- claims — which nobody has served, agreed or notarised — get the corrected
-- engine. A single DEFAULT 2 would have silently re-versioned history.

alter table public.claims
  add column if not exists engine_version smallint not null default 1;

alter table public.claims
  alter column engine_version set default 2;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'claims_engine_version_check'
  ) then
    alter table public.claims
      add constraint claims_engine_version_check check (engine_version in (1, 2));
  end if;
end $$;

comment on column public.claims.engine_version is
  'Laytime rule set that computes this claim: 1 = as shipped through Phase 7 (frozen; reproduces conformance root bc9f24fdab910a1b), 2 = agreed EXCEPTED_PERIOD deducted under GENCON 94 + SHINC. Existing rows backfilled to 1; new rows default to 2.';

-- ============================================================================
-- 2. counterparty_finance — where settlement money actually goes
-- ============================================================================
--
-- Until now escrow-server.ts emitted every party with a null IBAN, BIC and
-- wallet, reported through missingForBank / missingForChain. The payload was
-- correct and unactionable.
--
-- There is no counterparties table in this schema: claims carry a free-text
-- counterparty_name. So a row is identified by (company, kind, key) where the
-- key is the normalised counterparty name, and 'self' is the tenant's own
-- receiving details — the tenant is a party to its own settlements.

create table if not exists public.counterparty_finance (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  -- 'self' = this tenant's own bank/wallet. 'counterparty' = a trading partner.
  party_kind text not null check (party_kind in ('self', 'counterparty')),

  -- lower(trim(claims.counterparty_name)). NULL for 'self': a tenant has exactly
  -- one set of own details, so there is nothing to key on.
  party_key text,

  -- The name as it must appear on the payment instruction. NOT the match key:
  -- a bank rejects "acme shipping ltd" where the account is held by
  -- "ACME Shipping Limited".
  legal_name text not null check (length(trim(legal_name)) > 0),
  country text check (country is null or country ~ '^[A-Z]{2}$'),

  -- Banking rail. Format-checked here as a backstop only; the app validates the
  -- IBAN mod-97 checksum, which this constraint deliberately does not attempt.
  iban text check (iban is null or iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  bic text check (bic is null or bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  bank_name text,

  -- Chain rail. The address SHAPE is checkable; its EIP-55 checksum is not,
  -- because that needs keccak-256 and this project has no audited
  -- implementation — the same reason we do not compute the EIP-712 digest.
  wallet_address text check (wallet_address is null or wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  chain_id integer check (chain_id is null or chain_id > 0),

  -- A wallet without a chain is not a payment destination: the same 20 bytes
  -- exist on every EVM chain and mean a different account on each.
  constraint counterparty_finance_wallet_needs_chain
    check ((wallet_address is null) = (chain_id is null)),

  -- 'self' has no key; 'counterparty' must have one.
  constraint counterparty_finance_key_matches_kind
    check ((party_kind = 'self') = (party_key is null)),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Exactly one 'self' record per company.
create unique index if not exists uniq_counterparty_finance_self
  on public.counterparty_finance (company_id)
  where party_kind = 'self';

-- One record per named counterparty per company. Partial indexes rather than a
-- single UNIQUE over a nullable column: in Postgres NULLs are distinct, so
-- (company, 'self', NULL) would not collide with itself.
create unique index if not exists uniq_counterparty_finance_party
  on public.counterparty_finance (company_id, party_key)
  where party_kind = 'counterparty';

alter table public.counterparty_finance enable row level security;

-- Bank details are tenant-private and editable by the tenant. Unlike
-- settlement_payloads (generated, never user-editable) this IS user data:
-- somebody has to type the IBAN in.
drop policy if exists "Company members read their own counterparty finance" on public.counterparty_finance;
create policy "Company members read their own counterparty finance"
  on public.counterparty_finance for select
  using (public.is_company_member(company_id));

drop policy if exists "Company members write their own counterparty finance" on public.counterparty_finance;
create policy "Company members write their own counterparty finance"
  on public.counterparty_finance for insert
  with check (public.is_company_member(company_id));

drop policy if exists "Company members update their own counterparty finance" on public.counterparty_finance;
create policy "Company members update their own counterparty finance"
  on public.counterparty_finance for update
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

drop policy if exists "Company members delete their own counterparty finance" on public.counterparty_finance;
create policy "Company members delete their own counterparty finance"
  on public.counterparty_finance for delete
  using (public.is_company_member(company_id));

comment on table public.counterparty_finance is
  'Bank (IBAN/BIC) and chain (wallet/chain_id) details for settlement parties. party_kind=self is the tenant''s own account; party_kind=counterparty is matched to claims.counterparty_name via party_key = lower(trim(name)).';
