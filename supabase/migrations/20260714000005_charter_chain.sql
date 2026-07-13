-- Multi-tier "ripple" settlement: a verified demurrage claim cascades down
-- the charter chain (Owner → Head Charterer → Sub-Charterer → Receiver).
-- A tenant who receives a claim creates a linked sub-claim against their own
-- counterparty; the SoF facts that independent evidence corroborated are
-- cloned LOCKED, so downstream parties can dispute terms and money but never
-- re-litigate the raw verified facts.

-- === 1. Claims: chain linkage ===
-- parent_claim_id is SET NULL on parent deletion: a sub-claim is a live
-- dispute in its own right and must survive its upstream record. chain_depth
-- is denormalized (parent + 1) so loops/interminable chains are refused
-- cheaply at creation.
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS parent_claim_id uuid REFERENCES public.claims (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS chain_role text NOT NULL DEFAULT 'owner'
    CHECK (chain_role IN ('owner', 'head_charterer', 'sub_charterer', 'receiver')),
  ADD COLUMN IF NOT EXISTS chain_depth integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_claims_parent ON public.claims (parent_claim_id);

-- === 2. SoF events: fact locking ===
-- locked events are the chain's verified backbone: proposal creation (guest),
-- proposal acceptance (owner) and direct event edits all refuse to touch
-- them (sentinel EVENT_LOCKED). locked_reason quotes the evidence verdict
-- that justified the lock — the lock must always be explainable.
ALTER TABLE public.sof_events
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_reason text;
