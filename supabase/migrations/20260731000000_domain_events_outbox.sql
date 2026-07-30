-- The transactional outbox: an append-only log of things that happened.
--
-- WHY TRIGGERS AND NOT APPLICATION CODE. The whole value of an outbox is that
-- the event is written in the SAME TRANSACTION as the state change that caused
-- it. Publishing from application code after a commit is the pattern that
-- produces "the claim settled but the webhook never fired" — in this product a
-- financial discrepancy, not a missed notification.
--
-- supabase-js cannot span a transaction across two statements, so an
-- application-level write here would be exactly the non-transactional pattern
-- we are trying to avoid. A trigger is atomic by construction: if the
-- calculation rolls back, so does its event, with no code at the call site to
-- forget.
--
-- NOTHING CONSUMES THIS YET, and that is deliberate. An extracted worker
-- without an event log is a distributed system with no audit trail, so the log
-- lands first. It is independently useful in the meantime: it is the first
-- durable record this product has of *what happened when*, as distinct from
-- what the current row says.

create table if not exists public.domain_events (
  -- bigserial, not uuid: consumers read this in order, and a monotonic key is
  -- what makes "everything after cursor X" a cheap, correct query.
  id bigserial primary key,

  -- Tenancy travels WITH the message. A worker runs as service-role and has no
  -- RLS to fall back on, so the scope has to be in the event itself — the same
  -- reason requireClaim() is load-bearing in the MCP server.
  company_id uuid not null references public.companies (id) on delete cascade,

  aggregate text not null,
  -- Deliberately NOT a foreign key. An event log records that something
  -- happened, and deleting the claim does not un-happen it — so events outlive
  -- their aggregate and readers must tolerate a dangling aggregate_id.
  -- Retention is by age, never by cascade. (company_id IS a cascading FK: a
  -- departed tenant's data goes, which is a different question from history.)
  aggregate_id uuid not null,

  -- Facts, not commands: 'claim.recomputed', never 'recompute_claim'. A fact
  -- can have many consumers; a command has exactly one owner and is a
  -- distributed RPC wearing a queue for a hat.
  event_type text not null check (event_type ~ '^[a-z_]+\.[a-z_]+$'),

  -- A POINTER PLUS A DIGEST, never a snapshot. A fat payload becomes a second,
  -- stale copy of the truth that drifts from the row it describes.
  payload jsonb not null default '{}'::jsonb,

  -- Idempotency is the consumer's contract, not the producer's hope. Derived
  -- from the content digest, so two genuinely identical state changes collapse
  -- to one event and a redelivery is recognisable.
  idempotency_key text not null unique,

  occurred_at timestamptz not null default now(),

  -- Consumer bookkeeping. Null processed_at = outstanding.
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text
);

-- The queue read: outstanding events in order. Partial, so it stays small as
-- the processed tail grows without bound.
create index if not exists idx_domain_events_unprocessed
  on public.domain_events (id) where processed_at is null;

create index if not exists idx_domain_events_company
  on public.domain_events (company_id, occurred_at desc);

-- "What happened to this claim?" — the audit read.
create index if not exists idx_domain_events_aggregate
  on public.domain_events (aggregate, aggregate_id, occurred_at desc);

-- === RLS ===
-- Readable by the owning company; NOT writable by anyone through PostgREST.
-- There is deliberately no INSERT/UPDATE/DELETE policy: the only writer is the
-- SECURITY DEFINER trigger below, which is owned by the table owner and so
-- bypasses RLS. An append-only log that clients can append to is not a log.
alter table public.domain_events enable row level security;

create policy "Company members read their own domain events"
  on public.domain_events for select
  to authenticated
  using (public.is_company_member(company_id));

-- ---------------------------------------------------------------------------
-- The emitter
-- ---------------------------------------------------------------------------
--
-- One generic function, configured per trigger through TG_ARGV:
--   [0] aggregate name        e.g. 'claim'
--   [1] event type            e.g. 'claim.recomputed'
--   [2] how to find the company: 'self'  -> NEW.company_id
--                                'claim' -> claims.company_id via NEW.claim_id
--   [3] the aggregate id column on NEW    e.g. 'claim_id'
--
-- SECURITY DEFINER so the insert is not blocked by the log's own RLS. Per this
-- project's hard-won rule, EXECUTE is revoked from `anon` and `authenticated`
-- BY NAME below — a REVOKE FROM public is a no-op against Supabase's default
-- grants, and `src/lib/security/definer-grants.test.ts` fails the build if this
-- is omitted.
create or replace function public.emit_domain_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_aggregate    text := TG_ARGV[0];
  v_event_type   text := TG_ARGV[1];
  v_company_mode text := TG_ARGV[2];
  v_id_column    text := TG_ARGV[3];
  v_company_id   uuid;
  v_aggregate_id uuid;
  v_payload      jsonb;
  v_digest       text;
  v_row          jsonb := to_jsonb(NEW);
begin
  v_aggregate_id := (v_row ->> v_id_column)::uuid;
  if v_aggregate_id is null then
    return NEW;
  end if;

  if v_company_mode = 'self' then
    v_company_id := (v_row ->> 'company_id')::uuid;
  else
    select c.company_id into v_company_id
      from public.claims c
     where c.id = (v_row ->> 'claim_id')::uuid;
  end if;

  -- No company means no tenancy scope, and an event a worker cannot safely
  -- scope is worse than no event. Skip rather than emit something unusable.
  if v_company_id is null then
    return NEW;
  end if;

  -- The payload is assembled per aggregate so each carries the few scalars a
  -- consumer would route on without re-reading the row — and nothing more.
  if v_aggregate = 'claim' then
    v_payload := jsonb_build_object(
      'claim_id', v_aggregate_id,
      'demurrage_amount', NEW.demurrage_amount,
      'despatch_amount', NEW.despatch_amount,
      'currency', NEW.currency,
      'used_hours', NEW.used_hours,
      'allowed_hours', NEW.allowed_hours
    );
  elsif v_aggregate = 'pre_arrival_risk' then
    v_payload := jsonb_build_object(
      'risk_id', v_aggregate_id,
      'claim_id', NEW.claim_id,
      'decision_grade', NEW.decision_grade,
      'demurrage_probability', NEW.demurrage_probability,
      'expected_exposure', NEW.expected_exposure,
      'currency', NEW.currency,
      'inputs_digest', NEW.inputs_digest
    );
  elsif v_aggregate = 'settlement' then
    v_payload := jsonb_build_object(
      'settlement_id', NEW.id,
      'claim_id', NEW.claim_id,
      'status', NEW.status,
      'amount', NEW.amount,
      'currency', NEW.currency
    );
    v_aggregate_id := NEW.claim_id;
  else
    v_payload := jsonb_build_object('id', v_aggregate_id);
  end if;

  v_digest := md5(v_payload::text);

  insert into public.domain_events
    (company_id, aggregate, aggregate_id, event_type, payload, idempotency_key)
  values
    (v_company_id, v_aggregate, v_aggregate_id, v_event_type, v_payload,
     v_event_type || ':' || v_aggregate_id::text || ':' || v_digest)
  -- DO NOTHING, not DO UPDATE, and never a bare insert: recomputing a claim to
  -- an identical result is genuinely the same event, and a unique violation
  -- here would abort the recompute that triggered it. Collapsing is correct —
  -- no consumer needs to act twice on an unchanged outcome.
  on conflict (idempotency_key) do nothing;

  return NEW;
end;
$$;

revoke execute on function public.emit_domain_event() from public;
revoke execute on function public.emit_domain_event() from anon;
revoke execute on function public.emit_domain_event() from authenticated;

-- ---------------------------------------------------------------------------
-- The producers
-- ---------------------------------------------------------------------------
-- AFTER, so the row is committed-visible to anything the event wakes up.
-- Row-level, so a batch write emits one event per aggregate rather than one
-- per statement.

drop trigger if exists trg_domain_event_claim_recomputed on public.laytime_calculations;
create trigger trg_domain_event_claim_recomputed
  after insert or update on public.laytime_calculations
  for each row execute function public.emit_domain_event(
    'claim', 'claim.recomputed', 'claim', 'claim_id'
  );

drop trigger if exists trg_domain_event_risk_assessed on public.pre_arrival_risks;
create trigger trg_domain_event_risk_assessed
  after insert on public.pre_arrival_risks
  for each row execute function public.emit_domain_event(
    'pre_arrival_risk', 'risk.assessed', 'self', 'id'
  );

drop trigger if exists trg_domain_event_settlement on public.settlements;
create trigger trg_domain_event_settlement
  after insert or update of status on public.settlements
  for each row execute function public.emit_domain_event(
    'settlement', 'settlement.changed', 'claim', 'claim_id'
  );

comment on table public.domain_events is
  'Append-only transactional outbox. Written only by the emit_domain_event() trigger, in the same transaction as the state change. Consumers must be idempotent on idempotency_key.';
