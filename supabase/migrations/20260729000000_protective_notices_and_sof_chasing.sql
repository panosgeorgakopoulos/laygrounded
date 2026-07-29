-- Phase 3.2 / 2.4 — protective notice automation and auto SoF chasing.
--
-- Both features produce outbound correspondence from a sweep, so both follow
-- the pattern the Legal Shield established: a `drafts` row plus a
-- `pending_human_reviews` row. Nothing is ever served from a sweep; a human
-- approves first. That is also where idempotency comes from — the existing
-- partial unique index `uniq_pending_reviews_live (claim_id, subject_type)
-- WHERE status = 'pending'` means a re-sweep cannot stack a second request for
-- the same claim and subject.
--
-- Two new draft kinds:
--   * protective_notice — filed before a contractual time bar expires to
--     preserve a claim whose supporting pack is not yet complete. Claims die
--     procedurally far more often than on the merits; this is the cheapest
--     money the product can save.
--   * sof_chase — a request to the port agent for the missing SoF milestones
--     that are blocking a calculation.
--
-- Both must be draftable BEFORE a calculation exists — that is the whole point
-- of each. `letter_of_protest` already carries that exemption in the drafter;
-- these two join it.

-- === 1. Draft kinds ===
ALTER TABLE public.drafts DROP CONSTRAINT IF EXISTS drafts_kind_check;
ALTER TABLE public.drafts ADD CONSTRAINT drafts_kind_check
  CHECK (kind IN (
    'demand_letter',
    'counter_argument',
    'settlement_proposal',
    'letter_of_protest',
    'arrest_dossier',
    'protective_notice',
    'sof_chase'
  ));

-- === 2. Human-review subjects ===
ALTER TABLE public.pending_human_reviews
  DROP CONSTRAINT IF EXISTS pending_human_reviews_subject_type_check;
ALTER TABLE public.pending_human_reviews ADD CONSTRAINT pending_human_reviews_subject_type_check
  CHECK (subject_type IN (
    'protest_draft',
    'settlement',
    'arrest_dossier',
    'autonomous_settlement',
    'protective_notice',
    'sof_chase'
  ));

-- === 3. Sweep lookup ===
-- The sweeps ask "does this claim already have a notice of this kind" on every
-- pass, across the whole book. Without this the question is a sequential scan
-- of every draft the company has ever generated.
CREATE INDEX IF NOT EXISTS idx_drafts_claim_kind
  ON public.drafts (claim_id, kind);
