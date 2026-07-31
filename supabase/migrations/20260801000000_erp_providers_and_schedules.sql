-- Phase 7 / Epic C — the ERP-agnostic sync layer.
--
-- Three changes, all of which are invisible to `tsc` and would otherwise fail
-- only at INSERT time against the live database:
--   1. widen `integrations_provider_check` for the three new adapters;
--   2. widen `sync_jobs_kind_check` for the two new job kinds;
--   3. add `erp_vessel_schedules`, the landing table for forward schedules.

-- === 1. New ERP providers ===
--
-- Adding an adapter class is not enough: the CHECK constraint is the reason a
-- `DANAOS` row cannot be inserted until this runs. Keep this list in sync with
-- `PROVIDERS` in src/lib/integrations/registry.ts.

alter table public.integrations
  drop constraint if exists integrations_provider_check;

alter table public.integrations
  add constraint integrations_provider_check
  check (provider in ('VESON_IMOS', 'DANAOS', 'FORTUNE', 'ULYSSES', 'MOCK_ERP'));

-- === 2. New sync job kinds ===

alter table public.sync_jobs
  drop constraint if exists sync_jobs_kind_check;

alter table public.sync_jobs
  add constraint sync_jobs_kind_check
  check (kind in ('push_invoice', 'push_ledger', 'push_pnl', 'pull_voyages', 'pull_schedules'));

-- === 3. Forward vessel schedules ===
--
-- A schedule is a PLAN, and is deliberately kept out of `claims`: turning an
-- ETA into a claim would fill a customer's book with port calls that have not
-- happened. It lands here instead, where the pre-arrival risk engine and
-- ecospeed can read an ETA that an operator currently types by hand.
--
-- Every time column is nullable because an ERP routinely has an ETA with no
-- berth assigned yet. NOT NULL here would force an adapter to invent one.

create table if not exists public.erp_vessel_schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  integration_id uuid not null references public.integrations (id) on delete cascade,
  -- The ERP's own id for this port call; the idempotency key for re-pulls.
  external_ref text not null,
  vessel text not null,
  vessel_imo text,
  voyage_ref text not null default '',
  port text not null default '',
  port_function text not null default 'unknown'
    check (port_function in ('load', 'discharge', 'bunker', 'transit', 'unknown')),
  eta timestamptz,
  etb timestamptz,
  etd timestamptz,
  laycan_from timestamptz,
  laycan_to timestamptz,
  cargo text,
  cargo_quantity_mt numeric,
  -- The ERP's own modification stamp, kept distinct from ours: it is what an
  -- incremental pull filters on, and overwriting it with now() would make
  -- every sweep look like a fresh change.
  source_updated_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Re-pulling the same port call updates in place rather than accumulating a
-- row per sweep. This is the conflict target `upsertVesselSchedule` names, and
-- it is a full (not partial) unique index precisely so ON CONFLICT can infer it.
create unique index if not exists uniq_erp_vessel_schedules_external
  on public.erp_vessel_schedules (integration_id, external_ref);

create index if not exists idx_erp_vessel_schedules_company_eta
  on public.erp_vessel_schedules (company_id, eta);

alter table public.erp_vessel_schedules enable row level security;

-- `is_company_member()` — NOT the `auth.jwt() -> app_metadata -> company_id`
-- pattern. The custom_access_token_hook was never enabled on this project, so
-- that claim is always NULL and such a policy denies every end-user JWT.
create policy "Company members read their own ERP schedules"
  on public.erp_vessel_schedules
  for select
  using (public.is_company_member(company_id));

-- No INSERT/UPDATE/DELETE policy: the only writer is the sync worker, which
-- runs as service_role and bypasses RLS. A schedule is ERP-owned data, and an
-- end user editing it would silently diverge from the source system.

comment on table public.erp_vessel_schedules is
  'Forward vessel schedules pulled from an ERP. Plans, not facts: never promoted to claims. Written only by the sync worker (service_role).';
