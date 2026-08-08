-- Phase 17: a share token now carries WHAT IT GRANTS, not just who it is for.
--
-- WHY A MODE ON THE EXISTING TABLE, NOT A SECOND TOKEN SYSTEM.
--
-- `claim_shares` already does the hard part correctly: a 192-bit unguessable
-- token, expiry, revocation, and `resolveShare()` returning null — never a 403
-- — so a probe cannot distinguish "revoked" from "never existed". Building a
-- parallel table for read-only links would mean a second implementation of all
-- of that, and the second one is the one that gets the 404-vs-403 detail wrong.
--
-- What was genuinely missing is that every share was a NEGOTIATION grant. A
-- claim room lets the counterparty write `event_proposals` against the claim.
-- That is right for "let us settle this between us" and wrong for "here is my
-- calculation, verify it" — the latter is an evidence-presentation surface
-- where the reader should be able to change nothing at all.
--
-- So the token grows a mode. One column, one CHECK, and the write paths consult
-- it. `resolveShare()` returns it, and `/api/rooms/[token]/proposals` refuses
-- anything that is not `negotiate`, because a read-only link enforced only by
-- rendering a different page is not read-only — it is a page that happens not
-- to show the buttons.

alter table public.claim_shares
  add column if not exists access_mode text not null default 'negotiate'
    check (access_mode in ('negotiate', 'readonly'));

-- DEFAULT 'negotiate', deliberately.
--
-- Every share issued before this migration was a room link and its holder may
-- already have proposals in flight. Defaulting to 'readonly' would silently
-- revoke the write half of a grant somebody is mid-negotiation on, which from
-- the counterparty's side is indistinguishable from the product breaking.
--
-- The safe default for a NEW capability is the behaviour that already existed.

comment on column public.claim_shares.access_mode is
  'What the token grants. `negotiate` = the claim room, where the counterparty may file event proposals. `readonly` = the statement view, which exposes a strict allowlisted projection and accepts no writes at all. Enforced in the API (rooms/[token]/proposals refuses non-negotiate), not merely in what the page renders.';

-- The statement view resolves by token and then filters by mode, so the mode
-- rides along on the existing token lookup rather than costing a second query.
create index if not exists claim_shares_active_by_claim
  on public.claim_shares (claim_id, access_mode)
  where revoked_at is null;
