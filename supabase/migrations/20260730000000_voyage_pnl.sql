-- Voyage P&L (plan item 5.2) — the demurrage claim as one line in a complete
-- voyage result.
--
-- THE STRUCTURAL FACT THIS SCHEMA EXISTS FOR: `claims.port` is a single column,
-- so a claim is one PORT CALL, not a voyage. A load/discharge voyage is two
-- claims. The P&L therefore cannot hang off a claim — it needs its own root
-- that groups them, which is what `voyage_pnl_claims` is for. Modelling it on
-- the claim would make multi-port voyages unrepresentable.
--
-- Inputs live on the root; the result is RECOMPUTED from them and snapshotted
-- into `voyage_pnl_results` — exactly the `laytime_calculations` pattern, and
-- for the same reason: the sheet must be reproducible from its inputs, and the
-- history of what it said must survive an input changing.
--
-- RLS uses `public.is_company_member()`. NOT the
-- `auth.jwt() -> app_metadata -> company_id` pattern: that claim is always NULL
-- because `custom_access_token_hook` was never enabled, so tables using it deny
-- every end-user JWT and work only via the service-role client.

-- === 1. Root ===
create table if not exists public.voyage_pnl (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  vessel text not null,
  voyage_ref text not null,
  charter_type text not null check (charter_type in ('voyage', 'time')),
  -- The engine is owner-perspective; on a time charter the owner EARNS hire and
  -- the charterer PAYS it, so identical inputs produce opposite signs.
  perspective text not null default 'owner' check (perspective in ('owner', 'charterer')),
  -- Reporting currency. Lines in any other currency are carried for display but
  -- excluded from every total — the calculator refuses to convert without a
  -- rate it can evidence.
  currency text not null default 'USD',
  -- Freight/hire/commission terms and cost lines, validated by Zod at the
  -- boundary exactly as `claims.cp_terms` is.
  terms jsonb not null default '{}'::jsonb,
  costs jsonb not null default '{}'::jsonb,
  voyage_start timestamptz,
  voyage_end timestamptz,
  -- 'estimate' is the pre-fixture voyage estimate (how a desk decides whether
  -- to take a cargo); it becomes 'actual' once the voyage runs and 'closed'
  -- when accounts are final. The same record carries the whole lifecycle, which
  -- is what connects the pre-fixture risk analyzer to commercial management.
  status text not null default 'estimate' check (status in ('estimate', 'actual', 'closed')),
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_voyage_pnl_company on public.voyage_pnl (company_id, updated_at desc);
create index if not exists idx_voyage_pnl_voyage on public.voyage_pnl (company_id, vessel, voyage_ref);

-- === 2. Which port calls feed this voyage ===
create table if not exists public.voyage_pnl_claims (
  pnl_id uuid not null references public.voyage_pnl (id) on delete cascade,
  claim_id uuid not null references public.claims (id) on delete cascade,
  created_at timestamptz default now(),
  primary key (pnl_id, claim_id)
);

create index if not exists idx_voyage_pnl_claims_claim on public.voyage_pnl_claims (claim_id);

-- === 3. Computed snapshot ===
create table if not exists public.voyage_pnl_results (
  id uuid primary key default gen_random_uuid(),
  pnl_id uuid not null references public.voyage_pnl (id) on delete cascade,
  lines jsonb not null default '[]'::jsonb,
  gross_revenue float8 not null default 0,
  revenue_deductions float8 not null default 0,
  voyage_expenses float8 not null default 0,
  transfers float8 not null default 0,
  net_result float8 not null default 0,
  tce_per_day float8,
  voyage_days float8,
  currency text not null default 'USD',
  -- Anything that makes the sheet incomplete: a linked claim with no
  -- calculation, an off-currency line, an undatable voyage. Stored with the
  -- result so a snapshot can never be read as cleaner than it was.
  warnings jsonb not null default '[]'::jsonb,
  computed_at timestamptz default now()
);

create index if not exists idx_voyage_pnl_results_pnl
  on public.voyage_pnl_results (pnl_id, computed_at desc);

-- === 4. RLS ===
alter table public.voyage_pnl enable row level security;
alter table public.voyage_pnl_claims enable row level security;
alter table public.voyage_pnl_results enable row level security;

create policy "Users manage voyage_pnl of their company"
  on public.voyage_pnl for all
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

create policy "Users manage voyage_pnl_claims of their company"
  on public.voyage_pnl_claims for all
  using (
    exists (
      select 1 from public.voyage_pnl p
      where p.id = voyage_pnl_claims.pnl_id and public.is_company_member(p.company_id)
    )
  )
  with check (
    exists (
      select 1 from public.voyage_pnl p
      where p.id = voyage_pnl_claims.pnl_id and public.is_company_member(p.company_id)
    )
  );

create policy "Users manage voyage_pnl_results of their company"
  on public.voyage_pnl_results for all
  using (
    exists (
      select 1 from public.voyage_pnl p
      where p.id = voyage_pnl_results.pnl_id and public.is_company_member(p.company_id)
    )
  )
  with check (
    exists (
      select 1 from public.voyage_pnl p
      where p.id = voyage_pnl_results.pnl_id and public.is_company_member(p.company_id)
    )
  );
