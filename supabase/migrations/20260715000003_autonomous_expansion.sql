-- Autonomous expansion tier: agent-to-agent micro-negotiation rooms, live
-- vessel telemetry streams (eco-speed optimizer), AIS geofence verdicts on
-- the event timeline, and the eFTI export ledger kind.
--
-- Ordering note: this migration extends CHECK constraints created by
-- 20260715000002_frontier_expansion.sql (compliance_ledger.entry_kind,
-- pending_human_reviews.subject_type) and must run after it.

-- === 1. Autonomous negotiation rooms ===
-- One row per arbitration run: the limits each side's strategy agent was
-- given, how many rounds the agents played, and the deterministic
-- SettlementMatrix they produced. Append-only in practice (each run is a new
-- row) so the recommendation history survives renegotiation; the actual
-- money decision is gated behind pending_human_reviews
-- (subject_type 'autonomous_settlement') — agents recommend, humans settle.
CREATE TABLE IF NOT EXISTS public.autonomous_negotiation_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'approved', 'rejected')),
  -- Cumulative value each agent may trade away during rounds (USD-equivalent
  -- in the claim currency). Evidence-decided items do not count against it:
  -- facts are not concessions.
  max_concession_usd numeric(14, 2) NOT NULL,
  -- Sensitivity categories the owner agent never concedes, e.g.
  -- ["nor", "completion"]. Validated in TypeScript against the category enum.
  hard_stop_clauses jsonb NOT NULL DEFAULT '[]'::jsonb,
  agent_rounds_completed integer NOT NULL DEFAULT 0,
  final_settlement_probability numeric(5, 4)
    CHECK (final_settlement_probability >= 0 AND final_settlement_probability <= 1),
  -- The full deterministic SettlementMatrix (openings, finals, concession
  -- log with evidence citations, recommendation) — the payload a human
  -- approves with one click.
  settlement_matrix jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_negotiation_rooms_claim
  ON public.autonomous_negotiation_rooms (claim_id, created_at DESC);

ALTER TABLE public.autonomous_negotiation_rooms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage negotiation rooms of their company"
ON public.autonomous_negotiation_rooms FOR ALL
USING (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid)
WITH CHECK (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid);

-- === 2. Vessel telemetry streams ===
-- Point-in-time voyage telemetry feeding the eco-speed optimizer: where the
-- vessel is relative to the port, how fast it is steaming, and the expected
-- queue when it gets there. Append-only time series; the optimizer reads the
-- latest row per (company, vessel).
CREATE TABLE IF NOT EXISTS public.vessel_telemetry_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  vessel_imo text NOT NULL,
  claim_id uuid REFERENCES public.claims (id) ON DELETE SET NULL,
  destination_port text,
  current_speed_knots numeric(5, 2) NOT NULL CHECK (current_speed_knots >= 0),
  distance_to_port_nm numeric(8, 1) NOT NULL CHECK (distance_to_port_nm >= 0),
  predicted_congestion_delay_hours numeric(7, 2) NOT NULL DEFAULT 0
    CHECK (predicted_congestion_delay_hours >= 0),
  -- Where the reading came from: 'api' (manual/route), 'm2m' (device feed).
  source text NOT NULL DEFAULT 'api',
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_streams_vessel
  ON public.vessel_telemetry_streams (company_id, vessel_imo, recorded_at DESC);

ALTER TABLE public.vessel_telemetry_streams ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage telemetry streams of their company"
ON public.vessel_telemetry_streams FOR ALL
USING (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid)
WITH CHECK (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid);

-- === 3. AIS geofence verdict on timeline events ===
-- Three-state: NULL = never checked, true = AIS history places the vessel
-- where the SoF says it was, false = geofence discrepancy (the event also
-- gets a critical clause_flags row with clause_ref 'AIS-GEOFENCE').
ALTER TABLE public.sof_events
  ADD COLUMN IF NOT EXISTS ais_geofence_verified boolean;

-- === 4. HITL gate: autonomous settlements need a human ===
ALTER TABLE public.pending_human_reviews DROP CONSTRAINT IF EXISTS pending_human_reviews_subject_type_check;
ALTER TABLE public.pending_human_reviews ADD CONSTRAINT pending_human_reviews_subject_type_check
  CHECK (subject_type IN ('protest_draft', 'settlement', 'arrest_dossier', 'autonomous_settlement'));

-- === 5. Compliance ledger: eFTI export entries ===
-- Every signed eFTI packet that leaves the tenant is ledgered append-only,
-- so there is a verifiable record of exactly what was shared with a port
-- authority or logistics provider and under which signature.
ALTER TABLE public.compliance_ledger DROP CONSTRAINT IF EXISTS compliance_ledger_entry_kind_check;
ALTER TABLE public.compliance_ledger ADD CONSTRAINT compliance_ledger_entry_kind_check
  CHECK (
    entry_kind IN ('mrv_ets', 'cii_degradation', 'biofouling', 'sftw_arbitration', 'green_twin', 'time_proof', 'efti_export')
  );
