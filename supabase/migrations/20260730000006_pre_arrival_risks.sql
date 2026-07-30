-- Pre-arrival demurrage risk: a forward-looking, replayable snapshot.
--
-- STANDALONE, NOT CLAIM-SCOPED. A pre-arrival assessment exists before any
-- laytime claim does — that is the whole point of it — so hanging it off
-- `claims` would make the useful case (a vessel three weeks out, no SoF, no
-- claim row) unrepresentable. `claim_id` is an OPTIONAL back-link for the day
-- the voyage becomes a real claim, never the anchor.
--
-- REPLAYABILITY IS THE PRODUCT. A risk number nobody can reproduce is an
-- opinion. Every input the simulation consumed is stored here — the PRNG seed,
-- the resolved cargo thresholds, the congestion samples, the derived stoppage
-- trajectories, the CP terms — so a counterparty handed this row months later
-- re-runs the pure simulator and gets the same distribution to the cent. That
-- is the same standing the offline verifier gives a settled calculation,
-- extended to a forward-looking one.
--
-- Stoppage TRAJECTORIES are stored rather than raw weather: they are what the
-- simulation actually consumes, they are already cargo-specific, and a boolean
-- per hour is small enough to keep indefinitely where 40 members of raw hourly
-- readings would not be.

create table if not exists public.pre_arrival_risks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,

  -- Optional back-link, set if and when a claim is opened for this port call.
  claim_id uuid references public.claims (id) on delete set null,

  -- What was assessed.
  vessel text not null,
  voyage_ref text,
  port text not null,
  cargo text not null,
  eta timestamptz not null,
  operation text not null default 'loading'
    check (operation in ('loading', 'discharge')),

  -- Reproducibility.
  seed text not null,
  trials integer not null check (trials > 0),
  antithetic boolean not null default true,

  -- The complete input set, canonical: cp_terms, resolved cargo profile,
  -- congestion samples, ensemble/climatology trajectories, ETA error bounds.
  inputs jsonb not null,
  -- Digest over `inputs`, so an auditor can tell in one comparison whether the
  -- inputs they were handed are the ones the figures came from.
  inputs_digest text not null,

  -- Per-dimension provenance: weather, congestion, cargoThresholds, eta.
  provenance jsonb not null,
  -- FALSE when any dimension is synthetic (mock AIS). A non-decision-grade row
  -- is still worth storing — it is how the feature gets tested — but it must
  -- never be mistaken for measurement, so the flag is a column rather than
  -- something a reader has to derive from the provenance blob.
  decision_grade boolean not null,

  -- The distribution: probability, expected exposure, percentiles with their
  -- Monte Carlo standard errors, histogram, trajectory mix.
  result jsonb not null,

  -- Headline figures, promoted out of `result` so the book can be sorted and
  -- filtered without opening every jsonb.
  demurrage_probability double precision not null
    check (demurrage_probability >= 0 and demurrage_probability <= 1),
  expected_exposure double precision not null,
  p90_exposure double precision not null,
  currency text not null,

  -- The horizon that produced it, for reading a row at a glance.
  lead_time_hours double precision not null,
  horizon_mode text not null check (horizon_mode in ('ensemble', 'blended', 'climatology')),

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_pre_arrival_risks_company_created
  on public.pre_arrival_risks (company_id, created_at desc);
create index if not exists idx_pre_arrival_risks_claim
  on public.pre_arrival_risks (claim_id) where claim_id is not null;
create index if not exists idx_pre_arrival_risks_port_eta
  on public.pre_arrival_risks (company_id, port, eta desc);

-- === RLS ===
-- `is_company_member()` rather than the auth.jwt() app_metadata pattern: the
-- custom_access_token_hook was never enabled, so a company_id claim is always
-- NULL and policies built on it deny every end-user request.
alter table public.pre_arrival_risks enable row level security;

create policy "Users manage their company's pre-arrival risks"
  on public.pre_arrival_risks for all
  to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

comment on column public.pre_arrival_risks.decision_grade is
  'FALSE when any input dimension was synthetic (e.g. mock AIS). Such a row must never be presented as a measurement or used to price a fixture.';
comment on column public.pre_arrival_risks.inputs is
  'The complete, canonical simulation input set. Replaying the pure simulator with these inputs and the stored seed must reproduce `result` exactly.';
