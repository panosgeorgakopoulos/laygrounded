-- Down migration for 20260715000003_autonomous_expansion.sql — reverse order.

-- 5. Compliance ledger entry kind (back to the 20260715000002 list).
ALTER TABLE public.compliance_ledger DROP CONSTRAINT IF EXISTS compliance_ledger_entry_kind_check;
ALTER TABLE public.compliance_ledger ADD CONSTRAINT compliance_ledger_entry_kind_check
  CHECK (
    entry_kind IN ('mrv_ets', 'cii_degradation', 'biofouling', 'sftw_arbitration', 'green_twin', 'time_proof')
  );

-- 4. HITL subject types (back to the 20260715000002 list).
ALTER TABLE public.pending_human_reviews DROP CONSTRAINT IF EXISTS pending_human_reviews_subject_type_check;
ALTER TABLE public.pending_human_reviews ADD CONSTRAINT pending_human_reviews_subject_type_check
  CHECK (subject_type IN ('protest_draft', 'settlement', 'arrest_dossier'));

-- 3. AIS geofence verdict.
ALTER TABLE public.sof_events DROP COLUMN IF EXISTS ais_geofence_verified;

-- 2. Vessel telemetry streams.
DROP TABLE IF EXISTS public.vessel_telemetry_streams;

-- 1. Autonomous negotiation rooms.
DROP TABLE IF EXISTS public.autonomous_negotiation_rooms;
