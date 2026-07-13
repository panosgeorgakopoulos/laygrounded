-- DOWN for 20260714000006_insurance_oracle.sql
-- DESTRUCTIVE: drops policies AND the emitted-trigger ledger. Insurers that
-- consumed trigger webhooks lose the server-side attestation trail.
DROP TABLE IF EXISTS public.insurance_triggers;
DROP TABLE IF EXISTS public.insurance_policies;
