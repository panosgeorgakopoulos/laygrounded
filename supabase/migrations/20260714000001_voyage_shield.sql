-- In-voyage "Legal Shield": automated Letter of Protest generation.
-- The voyage-shield worker re-runs evidence verification on live (unsettled)
-- claims; when a claimed weather stoppage is contradicted by the independent
-- archive, it records a voyage_alert and triggers the agentic drafter to
-- produce a Letter of Protest for the Master/Agent to serve immediately.

-- === 1. Drafts: new kind ===
-- A Letter of Protest is drafted by the same grounded pipeline as demand
-- letters (analysis → letter → grounding verification), so it lives in
-- `drafts` rather than a parallel table.
ALTER TABLE public.drafts DROP CONSTRAINT IF EXISTS drafts_kind_check;
ALTER TABLE public.drafts ADD CONSTRAINT drafts_kind_check
  CHECK (kind IN ('demand_letter', 'counter_argument', 'settlement_proposal', 'letter_of_protest'));

-- === 2. Voyage alerts ===
-- One row per (claim, alert type, triggering SoF event). The unique index is
-- what makes the monitoring sweep idempotent: re-verifying the same voyage
-- upserts with ignoreDuplicates and only *new* contradictions spawn drafts.
-- evidence_check_id is SET NULL because evidence verification is a
-- replace-on-rerun snapshot — the verdict summary is copied into `detail` so
-- the alert stays meaningful after the source row is replaced.
CREATE TABLE IF NOT EXISTS public.voyage_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES public.sof_events (id) ON DELETE CASCADE,
  evidence_check_id uuid REFERENCES public.evidence_checks (id) ON DELETE SET NULL,
  draft_id uuid REFERENCES public.drafts (id) ON DELETE SET NULL,
  alert_type text NOT NULL CHECK (alert_type IN ('weather_contradicted')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'draft_generated', 'served', 'dismissed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_voyage_alerts_event
  ON public.voyage_alerts (claim_id, alert_type, event_id);
CREATE INDEX IF NOT EXISTS idx_voyage_alerts_status
  ON public.voyage_alerts (status, created_at DESC);

-- === 3. RLS ===
ALTER TABLE public.voyage_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage voyage_alerts of their company claims"
ON public.voyage_alerts FOR ALL
USING (
  (SELECT company_id FROM public.claims WHERE id = voyage_alerts.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
)
WITH CHECK (
  (SELECT company_id FROM public.claims WHERE id = voyage_alerts.claim_id) = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid
);
