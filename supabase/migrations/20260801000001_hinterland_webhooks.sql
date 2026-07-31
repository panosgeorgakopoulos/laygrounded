-- Phase 7 / Epic C Part 2 — hinterland supply-chain webhooks.
--
-- The load-bearing change here is #1, and it is a PREREQUISITE, not a feature:
-- the outbox could only ever have had one consumer.

-- === 1. Per-consumer outbox processing state ===
--
-- `domain_events.processed_at` is a single flag. With one consumer
-- (erp-dispatch) that was correct. The moment a second consumer exists,
-- whichever sweep runs first marks the event processed and the other NEVER
-- SEES IT — ERP pushes would silently stop the day hinterland webhooks
-- shipped, with no error anywhere.
--
-- The roadmap's own rule is that "a fact can have many consumers". This table
-- is what makes that true: processing state is per (event, consumer), so each
-- consumer has its own cursor, its own retries and its own dead letters.
--
-- `domain_events.processed_at` is KEPT and still written, as the "at least one
-- consumer handled this" audit signal, but it is no longer the gate.

create table if not exists public.domain_event_consumptions (
  event_id bigint not null references public.domain_events (id) on delete cascade,
  -- A stable name, not a URL or an instance id: consumers are logical, and a
  -- redeployed worker must resume the same cursor.
  consumer text not null check (consumer ~ '^[a-z][a-z0-9_]{1,40}$'),
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  primary key (event_id, consumer)
);

-- The hot query: "events this consumer has not finished". Partial, because the
-- overwhelming majority of rows are completed and never read again.
create index if not exists idx_domain_event_consumptions_outstanding
  on public.domain_event_consumptions (consumer, event_id)
  where processed_at is null;

alter table public.domain_event_consumptions enable row level security;

-- Read-only to company members, joined through the event they describe.
-- No write policy: only the workers (service_role) write here.
create policy "Company members read consumption state for their own events"
  on public.domain_event_consumptions
  for select
  using (
    exists (
      select 1 from public.domain_events e
      where e.id = domain_event_consumptions.event_id
        and public.is_company_member(e.company_id)
    )
  );

-- Backfill: everything already processed under the single-flag model was
-- processed BY the ERP dispatcher, which was the only consumer. Without this,
-- the new model would consider every historical event outstanding and
-- re-dispatch the lot on first sweep.
insert into public.domain_event_consumptions (event_id, consumer, processed_at)
select id, 'erp', processed_at
from public.domain_events
where processed_at is not null
on conflict (event_id, consumer) do nothing;

-- === 2. The outstanding-events reader ===
--
-- A function rather than a client-side query: "events with no completed
-- consumption row for this consumer" is an anti-join, which PostgREST cannot
-- express. SECURITY DEFINER so a worker reads without RLS, and EXECUTE is
-- revoked from public, anon AND authenticated BY NAME — a bare
-- `revoke ... from public` does not touch the default direct grants on
-- Supabase, and src/lib/security/definer-grants.test.ts fails the build if
-- this is forgotten.

create or replace function public.unprocessed_domain_events(
  p_consumer text,
  p_limit integer default 100,
  p_after bigint default 0
)
returns table (
  id bigint,
  company_id uuid,
  aggregate text,
  aggregate_id uuid,
  event_type text,
  payload jsonb,
  idempotency_key text,
  occurred_at timestamptz,
  processed_at timestamptz,
  attempts integer,
  last_error text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    e.id, e.company_id, e.aggregate, e.aggregate_id, e.event_type, e.payload,
    e.idempotency_key, e.occurred_at,
    c.processed_at,
    coalesce(c.attempts, 0) as attempts,
    c.last_error
  from public.domain_events e
  left join public.domain_event_consumptions c
    on c.event_id = e.id and c.consumer = p_consumer
  where c.processed_at is null
    and e.id > coalesce(p_after, 0)
  order by e.id
  limit least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;

revoke execute on function public.unprocessed_domain_events(text, integer, bigint) from public;
revoke execute on function public.unprocessed_domain_events(text, integer, bigint) from anon;
revoke execute on function public.unprocessed_domain_events(text, integer, bigint) from authenticated;

-- === 3. Webhook delivery retries ===
--
-- Delivery was at-most-once with `attempts` hard-coded to 1 and no retry at
-- all: a logistics partner whose endpoint blipped for ten seconds simply never
-- learned about the delay. These columns turn the delivery ledger into a queue
-- with the same backoff/dead-letter shape as `sync_jobs`.

alter table public.api_webhook_deliveries
  add column if not exists next_attempt_at timestamptz not null default now();

alter table public.api_webhook_deliveries
  drop constraint if exists api_webhook_deliveries_status_check;

alter table public.api_webhook_deliveries
  add constraint api_webhook_deliveries_status_check
  check (status in ('pending', 'delivered', 'failed', 'dead'));

create index if not exists idx_api_webhook_deliveries_runnable
  on public.api_webhook_deliveries (status, next_attempt_at)
  where status = 'pending';

-- Per-subscription tuning (the hinterland delay threshold). Defaults live in
-- code; this is the override.
alter table public.api_webhooks
  add column if not exists config jsonb not null default '{}'::jsonb;

-- === 4. P90 delay in HOURS on a risk assessment ===
--
-- `pre_arrival_risks` stores percentiles of MONEY (`p90_exposure`) and only
-- MEANS of time (`meanWaitingHours`). A hinterland trigger needs the tail of
-- the time distribution: a mean wait of 10h routinely hides a P90 of 40h, and
-- substituting the mean would understate exactly the risk this feature exists
-- to warn about.
--
-- Added as DENORMALIZED COLUMNS rather than as fields on `RiskDistribution`.
-- That is deliberate: `verifyReplay()` compares the whole stored distribution
-- against a fresh recomputation over the union of keys, so adding a key to
-- `RiskDistribution` would make every historical assessment fail replay — and
-- reproducibility is the property the parametric-insurance story rests on.
--
-- Nullable and NOT backfilled. Rows assessed before this migration genuinely
-- do not have the statistic; NULL means "not recorded" and the webhook
-- consumer skips them rather than inventing a figure from the mean.

alter table public.pre_arrival_risks
  add column if not exists p90_waiting_hours double precision;

alter table public.pre_arrival_risks
  add column if not exists p90_stoppage_hours double precision;

comment on table public.domain_event_consumptions is
  'Per-consumer outbox processing state. domain_events.processed_at is a single flag and cannot support more than one consumer; this table is what allows a fact to have many.';

comment on column public.pre_arrival_risks.p90_waiting_hours is
  'P90 of waiting hours across trials. NULL for assessments made before 2026-08-01 — not recorded, never inferred from the mean.';
