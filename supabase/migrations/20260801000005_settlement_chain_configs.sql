-- Phase 8b — per-tenant escrow contract configuration.
--
-- `SETTLEMENT_VERIFYING_CONTRACT` was a single environment variable, which
-- cannot express the thing that is actually true: an escrow contract is a
-- DEPLOYMENT ON ONE CHAIN. The same address on a different chain is a different
-- contract, usually nothing at all. `resolveChainAgreement` already derives
-- which chain a settlement is on from the two parties' configured wallets, so
-- the contract has to be looked up for THAT chain or not at all.
--
-- Per company as well as per chain: tenants settling through different escrow
-- deployments is the normal case, not an edge case, and a platform-wide address
-- would quietly route one tenant's money through another's contract.
--
-- The env var survives as a platform-wide DEFAULT for chains a tenant has not
-- configured — useful for a single-deployment install, and still absent by
-- default, in which case no chain leg is generated and `missingForChain` says
-- exactly which field is missing.

create table if not exists public.settlement_chain_configs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  -- EIP-155 chain id. The escrow contract below is the deployment on THIS chain.
  chain_id integer not null check (chain_id > 0),

  -- The EIP-712 domain's verifyingContract. Shape-checked only: verifying that
  -- an address is a deployed contract needs an RPC call, and verifying its
  -- EIP-55 checksum needs keccak-256, which this project deliberately does not
  -- implement (the same decision that keeps us from computing the EIP-712
  -- digest ourselves).
  verifying_contract text not null check (verifying_contract ~ '^0x[0-9a-fA-F]{40}$'),

  -- ERC-20 to settle in. NULL means the chain's native asset.
  token_address text check (token_address is null or token_address ~ '^0x[0-9a-fA-F]{40}$'),

  -- Human label for the picker ("Ethereum Mainnet", "Polygon"). Never used to
  -- resolve anything — chain_id is the identity.
  label text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint uniq_settlement_chain_configs unique (company_id, chain_id)
);

alter table public.settlement_chain_configs enable row level security;

drop policy if exists "Company members read their own chain configs" on public.settlement_chain_configs;
create policy "Company members read their own chain configs"
  on public.settlement_chain_configs for select
  using (public.is_company_member(company_id));

drop policy if exists "Company members insert their own chain configs" on public.settlement_chain_configs;
create policy "Company members insert their own chain configs"
  on public.settlement_chain_configs for insert
  with check (public.is_company_member(company_id));

drop policy if exists "Company members update their own chain configs" on public.settlement_chain_configs;
create policy "Company members update their own chain configs"
  on public.settlement_chain_configs for update
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

drop policy if exists "Company members delete their own chain configs" on public.settlement_chain_configs;
create policy "Company members delete their own chain configs"
  on public.settlement_chain_configs for delete
  using (public.is_company_member(company_id));

comment on table public.settlement_chain_configs is
  'Per-tenant, per-chain escrow deployment. Looked up by the chain both settlement parties are configured on; without a match no EIP-712 leg is generated and missingForChain reports the gap.';
