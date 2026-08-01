-- Phase 10 — the negotiation phase, as a transition rather than a status value.
--
-- WHY NOT `claims.status = 'negotiating'`.
--
-- `status` is DERIVED. `recompute-server.ts` overwrites it on every calculation
-- ('demurrage' / 'despatch' / 'in_progress'), so a workflow value parked there
-- would survive exactly until the next recompute and then vanish with no error
-- anywhere. The claim would silently leave negotiation because somebody edited
-- an event.
--
-- The codebase already settled this question once: agreement is
-- `claims.agreed_at`, a column, precisely because `status` had no room for it
-- (Phase 7). This is the same shape for the same reason.
--
-- Nullable and not backfilled. NULL means "no negotiation opened", which is the
-- ordinary state of a claim nobody has disputed, and inventing an opening date
-- for historical claims would put them into a phase they were never in.

alter table public.claims
  add column if not exists negotiation_opened_at timestamptz;

alter table public.claims
  add column if not exists negotiation_opened_by uuid references auth.users (id);

-- Negotiation must precede agreement in time where both exist. Not a workflow
-- gate — a claim may be agreed without any dispute ever being raised, which is
-- the happy path — but an agreement dated BEFORE the negotiation that produced
-- it is a corrupt record, and the settlement payload is derived from it.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'claims_negotiation_before_agreement'
  ) then
    alter table public.claims
      add constraint claims_negotiation_before_agreement
      check (
        negotiation_opened_at is null
        or agreed_at is null
        or negotiation_opened_at <= agreed_at
      );
  end if;
end $$;

create index if not exists idx_claims_negotiating
  on public.claims (company_id, negotiation_opened_at)
  where negotiation_opened_at is not null and agreed_at is null;

comment on column public.claims.negotiation_opened_at is
  'When the counterparty negotiation phase was opened. NULL = never opened. Deliberately not a claims.status value: status is derived and overwritten by every recompute, which would silently drop the phase.';
