-- Port working calendars: the non-working days a port actually keeps.
--
-- Until now the engine approximated a holiday as a Sunday, because it had no
-- way to know any better (the comment saying so sat in gencon94.ts). Every
-- fixture at a port whose holidays fall midweek was therefore mis-costed, in
-- whichever direction the laytime basis runs. Port holidays and shift patterns
-- are one of the largest sources of laytime dispute and there is no clean
-- commercial dataset, so this is built to accumulate one from two sources the
-- customer already owns.
--
-- Two sources, and they are NOT equal:
--
--   customer_supplied — the client's own calendar for a port. Authoritative.
--   observed_from_sof — days inferred from real statements of facts, where a
--                       whole local day passed with no cargo activity.
--
-- An inferred day is a HYPOTHESIS, not a fact: a quiet day may be a holiday, or
-- a breakdown, or a berth congestion, or simply a gap in the paperwork.
-- Observed days are therefore stored as `pending` and are EXCLUDED from every
-- calculation until a human confirms them. Letting an inference silently move
-- money would be the same failure as fabricating case law, which is why
-- kb_precedents ships empty and demands a source_label.

create table if not exists public.port_calendars (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  -- Normalised for lookup; the label preserves whatever the user typed.
  port_key text not null,
  port_label text not null,
  -- IANA zone. Optional: the claim's cp_terms.port_timezone wins when set, and
  -- holidays are resolved in port-local time either way.
  timezone text,

  -- Provenance is mandatory. A calendar decides whether real money counts, so an
  -- entry that cannot say where it came from has no business in a calculation.
  source text not null check (length(trim(source)) > 0),
  source_kind text not null default 'customer_supplied'
    check (source_kind in ('customer_supplied', 'observed_from_sof')),
  notes text,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  -- One calendar per port per tenant: two calendars for the same port would
  -- make "which holidays apply" ambiguous at calculation time.
  unique (company_id, port_key)
);

create index if not exists idx_port_calendars_company
  on public.port_calendars (company_id, port_key);

create table if not exists public.port_calendar_days (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.port_calendars (id) on delete cascade,

  -- A local calendar date in the port's own reckoning, never an instant.
  calendar_date date not null,
  kind text not null default 'holiday'
    check (kind in ('holiday', 'non_working')),
  label text,

  -- `pending` days are proposals and never reach the engine; only `confirmed`
  -- days are loaded into a calculation. `rejected` is retained so the same
  -- inference is not proposed again every sweep.
  status text not null default 'confirmed'
    check (status in ('pending', 'confirmed', 'rejected')),

  -- Evidence trail for an inferred day: which claim's statement of facts showed
  -- the port idle. Null for customer-supplied entries.
  observed_claim_id uuid references public.claims (id) on delete set null,

  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz default now(),

  unique (calendar_id, calendar_date)
);

create index if not exists idx_port_calendar_days_lookup
  on public.port_calendar_days (calendar_id, status, calendar_date);

-- === RLS ===
-- auth.uid()-keyed helper, NOT the app_metadata pattern: these are read by the
-- cookie client during recompute, and the custom_access_token_hook has never
-- been enabled on this project so an app_metadata policy would deny everyone.
alter table public.port_calendars enable row level security;
alter table public.port_calendar_days enable row level security;

create policy "Users manage port_calendars of their company"
  on public.port_calendars for all
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

create policy "Users manage days of their company's port calendars"
  on public.port_calendar_days for all
  using (
    exists (
      select 1 from public.port_calendars pc
      where pc.id = port_calendar_days.calendar_id
        and public.is_company_member(pc.company_id)
    )
  )
  with check (
    exists (
      select 1 from public.port_calendars pc
      where pc.id = port_calendar_days.calendar_id
        and public.is_company_member(pc.company_id)
    )
  );
