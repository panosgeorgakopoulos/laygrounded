-- Defense Mode — claims received FROM a counterparty, and their audits.
--
-- Every existing table models a claim we are making. This models one being made
-- against us: the counterparty's asserted events and CP terms, the amount they
-- invoiced, and the audit our engine produces from their own submission.
--
-- Deliberately NOT reusing `claims`. An inbound claim is not a claim we own: it
-- has no SoF we control, no time bar we must meet, no settlement we collect, and
-- it must never appear in the outbound book, the pricing oracle's sample, or the
-- honesty index. Overloading `claims` with a direction flag would leak it into
-- all of those by default — every one of those queries would need to remember to
-- exclude it, and the first one that forgot would corrupt cross-tenant
-- aggregates that other tenants read.

create table if not exists public.inbound_claims (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,

  -- Who is claiming against us, and about what voyage.
  claimant_name text not null,
  vessel text not null,
  voyage_ref text,
  port text,
  cargo text,

  -- Their invoice, and the facts they rely on. `claimant_events` is their SoF as
  -- presented: an array of {id, occurred_at, event_type}, stored verbatim so the
  -- audit can always be reproduced against exactly what they sent.
  claimed_amount numeric(14, 2) not null check (claimed_amount >= 0),
  currency text not null default 'USD',
  claimant_events jsonb not null default '[]'::jsonb,
  claimant_cp_terms jsonb not null,
  -- Our copy of the fixture terms, when we have it. Null = we did not dispute
  -- the terms and took theirs at face value.
  our_cp_terms jsonb,

  received_at timestamptz not null default now(),
  -- Deadline by which we must respond, if the CP sets one.
  respond_by timestamptz,
  status text not null default 'received'
    check (status in ('received', 'audited', 'challenged', 'settled', 'accepted')),
  -- What we ultimately paid, once resolved.
  resolved_amount numeric(14, 2),
  resolved_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_inbound_claims_company
  on public.inbound_claims (company_id, received_at desc);
create index if not exists idx_inbound_claims_status
  on public.inbound_claims (company_id, status);

-- Audit snapshots. Replace-on-rerun, like evidence_checks: an audit is a
-- statement about the claim as it stands, not an append-only ledger, and two
-- audits of the same claim would only ever confuse which figure we are asserting.
create table if not exists public.inbound_claim_audits (
  id uuid primary key default gen_random_uuid(),
  inbound_claim_id uuid not null unique
    references public.inbound_claims (id) on delete cascade,

  claimed_amount numeric(14, 2) not null,
  -- The engine's answer on the claimant's own events and own terms.
  recomputed_amount numeric(14, 2) not null,
  -- claimed − recomputed. Positive = invoiced above their own calculation.
  arithmetic_delta numeric(14, 2) not null,
  -- What we say we owe: every asserted amendment priced in ONE engine run.
  defensible_position numeric(14, 2) not null,
  total_challenged numeric(14, 2) not null,
  currency text not null,

  challenges jsonb not null default '[]'::jsonb,
  notes jsonb not null default '[]'::jsonb,
  computed_at timestamptz default now()
);

-- === RLS ===
-- Both tables use the auth.uid()-keyed helper, NOT the app_metadata JWT pattern:
-- the custom_access_token_hook has never been enabled on this project, so
-- app_metadata->company_id is always null and such a policy would deny every
-- end-user session. These tables are read by the cookie client, so they must use
-- the helper that actually works.
alter table public.inbound_claims enable row level security;
alter table public.inbound_claim_audits enable row level security;

create policy "Users manage inbound_claims of their company"
  on public.inbound_claims for all
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

create policy "Users manage audits of their company's inbound claims"
  on public.inbound_claim_audits for all
  using (
    exists (
      select 1 from public.inbound_claims ic
      where ic.id = inbound_claim_audits.inbound_claim_id
        and public.is_company_member(ic.company_id)
    )
  )
  with check (
    exists (
      select 1 from public.inbound_claims ic
      where ic.id = inbound_claim_audits.inbound_claim_id
        and public.is_company_member(ic.company_id)
    )
  );
