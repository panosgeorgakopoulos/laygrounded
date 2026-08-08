-- Phase 15: the notification ledger.
--
-- WHY A TABLE AND NOT A READ-TIME PROJECTION. The claim activity feed
-- (`claim-activity.ts`) is deliberately projected rather than stored, and the
-- reasoning there was sound: a stored log would need backfilling and would be a
-- second copy of facts that already carry their own timestamps.
--
-- A notification is the opposite case, because it carries state that exists
-- NOWHERE ELSE: whether this particular person has seen it. "Read" is not
-- derivable from any domain fact — it is created by the act of looking, and
-- there is no row anywhere that implies it. So it has to be stored, and once
-- you are storing read state you may as well store what it was about.
--
-- ONE ROW PER RECIPIENT, not one row per event with a join table. A
-- notification is personal: two people receive the same fact and read it at
-- different times, and modelling that as shared-row-plus-read-markers means
-- every query is a join and every RLS policy has to reason about both tables.
-- The duplication is the point.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null references public.companies (id) on delete cascade,
  -- The recipient. Cascades: a departed user's unread pile is not evidence of
  -- anything and should not outlive them.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- Provenance, and deliberately ON DELETE SET NULL rather than CASCADE. Events
  -- are pruned by age; a notification whose source event has aged out is still
  -- a true record that we told this person something.
  event_id bigint references public.domain_events (id) on delete set null,

  kind text not null check (kind ~ '^[a-z_]+\.[a-z_]+$'),

  -- What the reader is expected to DO, which is the only distinction that earns
  -- a badge. `action` means someone must act; `urgent` means the window to act
  -- is closing. A five-level severity scale would be five ways to say "unread".
  severity text not null default 'info'
    check (severity in ('info', 'action', 'urgent')),

  title text not null,
  body text not null,

  -- Where clicking it goes. Stored rather than derived at render time so a
  -- notification about a claim that has since changed shape still lands
  -- somewhere sensible.
  href text,
  subject_type text,
  subject_id uuid,

  -- Read and dismissed are SEPARATE. Reading is passive (the dropdown opened);
  -- dismissing is a decision. Collapsing them would mean glancing at the bell
  -- silently cleared work someone had not done.
  read_at timestamptz,
  dismissed_at timestamptz,

  created_at timestamptz not null default now(),

  -- Idempotency, and it is load-bearing. The outbox is at-least-once by
  -- design, so a redelivered event MUST NOT produce a second copy — a duplicate
  -- notification is how an inbox becomes something people stop reading.
  dedupe_key text not null,
  unique (user_id, dedupe_key)
);

-- The bell count, and the only query that runs on every page load. Partial, so
-- it stays proportional to what is outstanding rather than to history.
create index if not exists idx_notifications_outstanding
  on public.notifications (user_id, created_at desc)
  where read_at is null and dismissed_at is null;

-- The inbox read.
create index if not exists idx_notifications_user_recent
  on public.notifications (user_id, created_at desc);

-- === RLS ===
alter table public.notifications enable row level security;

-- PERSONAL, not company-scoped. Every other table in this app is readable by
-- the company; this one is not, and the difference is deliberate — an admin has
-- no business reading a colleague's inbox, and `is_company_member()` here would
-- have granted exactly that.
create policy "Recipients read their own notifications"
  on public.notifications for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Recipients update their own notifications"
  on public.notifications for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- No INSERT policy: the only writer is the notifications consumer, running as
-- service_role. An inbox anyone can write to is a spam vector inside the
-- tenant.
--
-- No DELETE policy either: dismissing sets a flag. The row is the record that
-- we told someone, and letting the recipient erase it means "nobody warned me"
-- and "I dismissed the warning" become indistinguishable after the fact.

-- Column-level grants do what RLS cannot express: WITH CHECK can constrain the
-- new row but not which COLUMNS changed, so an update policy alone would let a
-- recipient rewrite the title and body of their own notification. Restricting
-- the grant to the two fields the UI actually writes closes that precisely.
revoke update on public.notifications from authenticated;
grant update (read_at, dismissed_at) on public.notifications to authenticated;

comment on table public.notifications is
  'Per-recipient notification ledger. Written only by the `notifications` outbox consumer (service_role); recipients may update read_at/dismissed_at only. Idempotent on (user_id, dedupe_key) because outbox delivery is at-least-once.';

-- ---------------------------------------------------------------------------
-- New producer: the autonomous negotiator
-- ---------------------------------------------------------------------------
--
-- Re-declares the generic emitter to add a `negotiation` branch and to carry
-- p90_exposure on risk events (the notification rules threshold on it, and
-- re-reading the row from the consumer would race with retention).
--
-- CREATE OR REPLACE preserves existing grants, so the revokes from
-- 20260731000000 still stand — they are repeated below anyway, so this file
-- remains correct in isolation if the migrations are ever squashed.
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

  if v_company_id is null then
    return NEW;
  end if;

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
      -- Added in Phase 15. The notification rule thresholds on the P90 rather
      -- than the mean: the mean of a demurrage distribution is routinely
      -- comfortable while its tail is not, and the tail is what a person needs
      -- to be woken up about.
      'p90_exposure', NEW.p90_exposure,
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
  elsif v_aggregate = 'negotiation' then
    -- The agents' recommendation, read out of the stored matrix rather than
    -- recomputed: the matrix IS the artifact a human reviews, and a figure
    -- derived a second way could disagree with the one on screen.
    v_payload := jsonb_build_object(
      'room_id', NEW.id,
      'claim_id', NEW.claim_id,
      'recommended_settlement', (NEW.settlement_matrix ->> 'recommendedSettlement')::numeric,
      'currency', NEW.settlement_matrix ->> 'currency',
      'settlement_probability', NEW.final_settlement_probability,
      'converged', (NEW.settlement_matrix ->> 'converged')::boolean,
      'rounds', NEW.agent_rounds_completed
    );
  else
    v_payload := jsonb_build_object('id', v_aggregate_id);
  end if;

  v_digest := md5(v_payload::text);

  insert into public.domain_events
    (company_id, aggregate, aggregate_id, event_type, payload, idempotency_key)
  values
    (v_company_id, v_aggregate, v_aggregate_id, v_event_type, v_payload,
     v_event_type || ':' || v_aggregate_id::text || ':' || v_digest)
  on conflict (idempotency_key) do nothing;

  return NEW;
end;
$$;

revoke execute on function public.emit_domain_event() from public;
revoke execute on function public.emit_domain_event() from anon;
revoke execute on function public.emit_domain_event() from authenticated;

-- AFTER INSERT only: a negotiation room is written once, and its later status
-- changes are a human working through the review — not a new recommendation.
drop trigger if exists trg_domain_event_negotiation on public.autonomous_negotiation_rooms;
create trigger trg_domain_event_negotiation
  after insert on public.autonomous_negotiation_rooms
  for each row execute function public.emit_domain_event(
    'negotiation', 'negotiation.completed', 'self', 'claim_id'
  );
