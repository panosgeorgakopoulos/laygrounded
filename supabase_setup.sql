-- Extensions
create extension if not exists "uuid-ossp";

-- Enums
create type app_role as enum ('admin', 'member');

-- Tables

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RPC for securely resolving emails to user IDs without listing all users
create or replace function get_user_id_by_email(email_addr text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from auth.users where email = email_addr limit 1;
$$;

create table public.company_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  role app_role default 'member',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, company_id)
);

create table public.claims (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  vessel text not null,
  voyage_ref text not null,
  port text not null,
  cargo text not null,
  cp_form text not null,
  status text not null default 'draft',
  cp_terms jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  storage_path text not null,
  mime text not null,
  original_filename text,
  extraction_status text not null default 'extracting',
  page_count integer default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.sof_events (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  occurred_at timestamptz not null,
  event_type text not null,
  raw_text text not null,
  page integer not null default 1,
  bbox jsonb,
  confidence float8 not null default 1.0,
  source text not null default 'ai',
  status text not null default 'suggested',
  ai_reasoning text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.clause_flags (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.sof_events (id) on delete cascade,
  clause_ref text not null,
  severity text not null,
  note text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.laytime_calculations (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  computed_at timestamptz default now(),
  breakdown jsonb not null default '[]'::jsonb,
  allowed_hours float8 not null default 0,
  used_hours float8 not null default 0,
  demurrage_amount float8,
  despatch_amount float8,
  currency text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.claims enable row level security;
alter table public.documents enable row level security;
alter table public.sof_events enable row level security;
alter table public.clause_flags enable row level security;
alter table public.laytime_calculations enable row level security;

-- Policies for companies
create policy "Users can view their own companies"
  on public.companies for select
  using (exists (
    select 1 from public.company_members cm
    where cm.company_id = id and cm.user_id = auth.uid()
  ));

-- Policies for company_members
create policy "Users can view members of their company"
  on public.company_members for select
  using (company_id in (
    select company_id from public.company_members cm
    where cm.user_id = auth.uid()
  ));

-- Policies for claims
create policy "Users can perform all actions on claims of their company"
  on public.claims for all
  using (company_id in (
    select company_id from public.company_members cm
    where cm.user_id = auth.uid()
  ));

-- Policies for documents
create policy "Users can perform all actions on documents of their company claims"
  on public.documents for all
  using (claim_id in (
    select c.id from public.claims c
    join public.company_members cm on c.company_id = cm.company_id
    where cm.user_id = auth.uid()
  ));

-- Policies for sof_events
create policy "Users can perform all actions on sof_events of their company claims"
  on public.sof_events for all
  using (claim_id in (
    select c.id from public.claims c
    join public.company_members cm on c.company_id = cm.company_id
    where cm.user_id = auth.uid()
  ));

-- Policies for clause_flags
create policy "Users can perform all actions on clause_flags of their company claims"
  on public.clause_flags for all
  using (event_id in (
    select e.id from public.sof_events e
    join public.claims c on e.claim_id = c.id
    join public.company_members cm on c.company_id = cm.company_id
    where cm.user_id = auth.uid()
  ));

-- Policies for laytime_calculations
create policy "Users can perform all actions on laytime_calculations of their company claims"
  on public.laytime_calculations for all
  using (claim_id in (
    select c.id from public.claims c
    join public.company_members cm on c.company_id = cm.company_id
    where cm.user_id = auth.uid()
  ));

-- Storage Bucket Setup
insert into storage.buckets (id, name, public) values ('sofs', 'sofs', false) on conflict do nothing;

create policy "Users can only access their company's files"
  on storage.objects for all
  using (
    bucket_id = 'sofs' and
    auth.role() = 'authenticated' and
    (storage.foldername(name))[1] in (
      select cm.company_id::text
      from public.company_members cm
      where cm.user_id = auth.uid()
    )
  );
-- Insert demo user (demo@laygrounded.com / password123)
insert into auth.users (
  id,
  instance_id,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  role,
  raw_user_meta_data
) values (
  '11111111-1111-1111-1111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'demo2@laygrounded.com',
  crypt('demo1234', gen_salt('bf')),
  now(),
  now(),
  now(),
  'authenticated',
  '{"name": "Demo Captain"}'
) on conflict (id) do nothing;

insert into auth.identities (
  id,
  provider_id,
  user_id,
  identity_data,
  provider,
  created_at,
  updated_at
) values (
  gen_random_uuid(),
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  '{"sub":"11111111-1111-1111-1111-111111111111", "email":"demo@laygrounded.com"}',
  'email',
  now(),
  now()
) on conflict do nothing;

-- Create demo company
insert into public.companies (id, name)
values ('22222222-2222-2222-2222-222222222222', 'Demo Shipping Co.')
on conflict do nothing;

-- Link demo user to demo company
insert into public.company_members (user_id, company_id, role)
values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'admin')
on conflict do nothing;

-- Database optimization and integrity (Phase 3 fixes)
ALTER TABLE public.laytime_calculations ADD CONSTRAINT laytime_calculations_claim_id_key UNIQUE (claim_id);
CREATE INDEX idx_company_members_company_id ON public.company_members(company_id);
CREATE INDEX idx_claims_company_id ON public.claims(company_id);
CREATE INDEX idx_claims_created_by ON public.claims(created_by);
CREATE INDEX idx_documents_claim_id ON public.documents(claim_id);
CREATE INDEX idx_sof_events_claim_id ON public.sof_events(claim_id);
CREATE INDEX idx_sof_events_document_id ON public.sof_events(document_id);
CREATE INDEX idx_laytime_calculations_claim_id ON public.laytime_calculations(claim_id);

ALTER TABLE public.claims ADD CONSTRAINT check_claims_status CHECK (status IN ('draft', 'processing', 'completed', 'failed', 'demurrage', 'despatch', 'in_progress'));
ALTER TABLE public.sof_events ADD CONSTRAINT check_sof_events_event_type CHECK (event_type IN ('NOR_TENDERED', 'ALL_FAST', 'HATCH_OPEN', 'HATCH_CLOSE', 'COMMENCED_LOADING', 'COMPLETED_LOADING', 'COMMENCED_DISCHARGE', 'COMPLETED_DISCHARGE', 'WEATHER_DELAY', 'SHIFTING', 'BERTHED', 'EXCEPTED_PERIOD_START', 'EXCEPTED_PERIOD_END'));
ALTER TABLE public.sof_events ADD CONSTRAINT check_sof_events_status CHECK (status IN ('suggested', 'pending', 'accepted', 'rejected', 'edited'));

-- Demo Data Injection
insert into public.claims (id, company_id, vessel, voyage_ref, port, cargo, cp_form, status, cp_terms, created_by)
values
('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'MV Pacific Star', 'VOY-24-001', 'Rotterdam', 'Steel Coils', 'GENCON 94', 'demurrage', '{"currency": "USD", "days_basis": "SHINC", "load_rate": 0, "nor_variant": "WIBON", "port_timezone": "UTC", "despatch_rate": 7500, "demurrage_rate": 15000, "discharge_rate": 0, "turn_time_hours": 6, "laytime_allowed_hours": 72}', '11111111-1111-1111-1111-111111111111'),
('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'MV Atlantic Pearl', 'VOY-24-002', 'Singapore', 'Iron Ore', 'GENCON 94', 'processing', null, '11111111-1111-1111-1111-111111111111')
on conflict do nothing;

insert into public.documents (id, claim_id, storage_path, mime, original_filename, extraction_status, page_count)
values
('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222/sof_pacific_star.pdf', 'application/pdf', 'sof_pacific_star.pdf', 'completed', 2),
('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222/sof_atlantic_pearl.pdf', 'application/pdf', 'sof_atlantic_pearl.pdf', 'extracting', 1)
on conflict do nothing;

insert into public.sof_events (id, claim_id, document_id, occurred_at, event_type, raw_text, status, ai_reasoning, page)
values
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-01T10:00:00Z', 'NOR_TENDERED', 'Notice of Readiness tendered at 1000 hrs', 'accepted', 'Explicit NOR tendered', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-01T14:00:00Z', 'ALL_FAST', 'Vessel all fast at berth 1400 hrs', 'accepted', 'All fast time', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-01T16:00:00Z', 'COMMENCED_DISCHARGE', 'Commenced discharge at 1600', 'accepted', 'Discharge start', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-02T10:00:00Z', 'WEATHER_DELAY', 'Rain delay from 1000', 'accepted', 'Rain delay start', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-02T14:00:00Z', 'WEATHER_DELAY', 'Rain stopped at 1400', 'accepted', 'Rain delay end', 1),
(gen_random_uuid(), '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', '2024-03-06T12:00:00Z', 'COMPLETED_DISCHARGE', 'Completed discharge 1200 hrs', 'accepted', 'Discharge finish', 1);

insert into public.laytime_calculations (claim_id, breakdown, allowed_hours, used_hours, demurrage_amount, despatch_amount, currency)
values
('33333333-3333-3333-3333-333333333333', '[{"hour":"2024-03-01T16:00:00Z","status":"laytime","counts":true,"clause_ref":"GENCON94-6c","reasoning":"Laytime counting."}]'::jsonb, 72, 116, 27500.00, 0, 'USD')
on conflict do nothing;
