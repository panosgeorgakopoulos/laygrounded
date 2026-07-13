-- Human-in-the-loop review gate for AI/automation outputs that would
-- otherwise act on the outside world unattended:
--   * protest_draft — the voyage-shield worker generated a Letter of Protest;
--     a human must approve it before it is served to anyone.
--   * settlement  — the clearinghouse found a claim eligible for zero-day
--     clearing; funds move only after an explicit human approval
--     (human_approved: true on the settle endpoint), never from the sweep.
-- The review row is the audit record: who approved what, when, and the exact
-- payload they saw at decision time.

CREATE TABLE IF NOT EXISTS public.pending_human_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('protest_draft', 'settlement')),
  -- drafts.id for protest_draft; settlements.id once a settlement exists.
  subject_id uuid,
  summary text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by text NOT NULL DEFAULT 'system',
  reviewed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- One live review per claim per subject: re-sweeps must not stack duplicate
-- approval requests (insert conflicts are treated as "already queued").
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_reviews_live
  ON public.pending_human_reviews (claim_id, subject_type)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_reviews_status
  ON public.pending_human_reviews (status, created_at DESC);

ALTER TABLE public.pending_human_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage pending_human_reviews of their company claims"
ON public.pending_human_reviews FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = pending_human_reviews.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = pending_human_reviews.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);
