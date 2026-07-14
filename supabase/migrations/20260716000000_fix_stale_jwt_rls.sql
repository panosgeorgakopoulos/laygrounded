-- Fixes RLS policies left behind on the `auth.jwt() -> 'app_metadata' ->>
-- 'company_id'` pattern. That pattern only works if the Postgres
-- `custom_access_token_hook` (20260711000003_optimize_rls.sql) is registered
-- as the project's "Customize Access Token (JWT) Claims" Auth Hook in the
-- Supabase dashboard -- a step no migration can perform. It was never
-- enabled, so `auth.jwt()` never carries `app_metadata.company_id` and every
-- policy below always evaluated its WITH CHECK/USING to NULL (i.e. denied).
--
-- `claims`, `sof_events`, `documents`, `laytime_calculations`,
-- `clause_flags` and `company_members` were already hot-patched (outside of
-- any tracked migration) onto `auth.uid()`-keyed SECURITY DEFINER helpers
-- (`is_company_member`, `user_owns_claim`, `user_owns_event`,
-- `current_user_company_ids`) that don't depend on the hook. Every other
-- table added since (the claim intelligence layer and the frontier/blue-
-- ocean modules) still has the dead pattern, which is why evidence
-- verification, claim-room share links, drafting, compliance/ETS scans,
-- settlements, insurance, ERP sync, voyage alerts, etc. fail RLS on every
-- write. This migration brings all of them onto the working pattern.

CREATE OR REPLACE FUNCTION public.user_owns_integration(target_integration_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  select exists (
    select 1 from public.integrations i
    where i.id = target_integration_id and public.is_company_member(i.company_id)
  );
$$;

-- === claim_shares ===
DROP POLICY IF EXISTS "Users can create shares for claims of their company" ON public.claim_shares;
DROP POLICY IF EXISTS "Users can perform all actions on claim_shares of their company" ON public.claim_shares;
CREATE POLICY "Users can perform all actions on claim_shares of their company"
ON public.claim_shares FOR ALL
USING (public.user_owns_claim(claim_id))
WITH CHECK (public.user_owns_claim(claim_id));

-- === evidence_checks ===
DROP POLICY IF EXISTS "Users can insert evidence checks for claims of their company" ON public.evidence_checks;
DROP POLICY IF EXISTS "Users can perform all actions on evidence_checks of their company" ON public.evidence_checks;
DROP POLICY IF EXISTS "Users can perform all actions on evidence_checks of their compa" ON public.evidence_checks;
CREATE POLICY "Users can perform all actions on evidence_checks of their company"
ON public.evidence_checks FOR ALL
USING (public.user_owns_claim(claim_id))
WITH CHECK (public.user_owns_claim(claim_id));

-- === event_proposals ===
DROP POLICY IF EXISTS "Users can perform all actions on event_proposals of their company claims" ON public.event_proposals;
DROP POLICY IF EXISTS "Users can perform all actions on event_proposals of their compa" ON public.event_proposals;
CREATE POLICY "Users can perform all actions on event_proposals of their company claims"
ON public.event_proposals FOR ALL
USING (public.user_owns_claim(claim_id))
WITH CHECK (public.user_owns_claim(claim_id));

-- === drafts ===
DROP POLICY IF EXISTS "Users manage drafts of their company claims" ON public.drafts;
CREATE POLICY "Users manage drafts of their company claims"
ON public.drafts FOR ALL
USING (public.user_owns_claim(claim_id))
WITH CHECK (public.user_owns_claim(claim_id));

-- === compliance_checks ===
DROP POLICY IF EXISTS "Users can insert compliance checks for claims of their company" ON public.compliance_checks;
DROP POLICY IF EXISTS "Users manage compliance_checks of their company claims" ON public.compliance_checks;
CREATE POLICY "Users manage compliance_checks of their company claims"
ON public.compliance_checks FOR ALL
USING (public.user_owns_claim(claim_id))
WITH CHECK (public.user_owns_claim(claim_id));

-- === compliance_ledger (append-only: SELECT + INSERT) ===
DROP POLICY IF EXISTS "Users append compliance_ledger for their company claims" ON public.compliance_ledger;
DROP POLICY IF EXISTS "Users read compliance_ledger of their company claims" ON public.compliance_ledger;
CREATE POLICY "Users read compliance_ledger of their company claims"
ON public.compliance_ledger FOR SELECT
USING (public.user_owns_claim(claim_id));
CREATE POLICY "Users append compliance_ledger for their company claims"
ON public.compliance_ledger FOR INSERT
WITH CHECK (public.user_owns_claim(claim_id));

-- === data_lineage (append-only: SELECT + INSERT) ===
DROP POLICY IF EXISTS "Users append data_lineage for their company claims" ON public.data_lineage;
DROP POLICY IF EXISTS "Users read data_lineage of their company claims" ON public.data_lineage;
CREATE POLICY "Users read data_lineage of their company claims"
ON public.data_lineage FOR SELECT
USING (public.user_owns_claim(claim_id));
CREATE POLICY "Users append data_lineage for their company claims"
ON public.data_lineage FOR INSERT
WITH CHECK (public.user_owns_claim(claim_id));

-- === ets_estimates ===
DROP POLICY IF EXISTS "Users manage ets_estimates of their company claims" ON public.ets_estimates;
CREATE POLICY "Users manage ets_estimates of their company claims"
ON public.ets_estimates FOR ALL
USING (public.user_owns_claim(claim_id))
WITH CHECK (public.user_owns_claim(claim_id));

-- === insurance_policies ===
DROP POLICY IF EXISTS "Users manage insurance_policies of their company" ON public.insurance_policies;
CREATE POLICY "Users manage insurance_policies of their company"
ON public.insurance_policies FOR ALL
USING (public.is_company_member(company_id))
WITH CHECK (public.is_company_member(company_id));

-- === insurance_triggers (read-only via app; writes are service-role) ===
DROP POLICY IF EXISTS "Users read insurance_triggers of their company policies" ON public.insurance_triggers;
CREATE POLICY "Users read insurance_triggers of their company policies"
ON public.insurance_triggers FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.insurance_policies p
    WHERE p.id = insurance_triggers.policy_id AND public.is_company_member(p.company_id)
  )
);

-- === integrations ===
DROP POLICY IF EXISTS "Users manage integrations of their company" ON public.integrations;
CREATE POLICY "Users manage integrations of their company"
ON public.integrations FOR ALL
USING (public.is_company_member(company_id))
WITH CHECK (public.is_company_member(company_id));

-- === pending_human_reviews ===
DROP POLICY IF EXISTS "Users manage pending_human_reviews of their company claims" ON public.pending_human_reviews;
CREATE POLICY "Users manage pending_human_reviews of their company claims"
ON public.pending_human_reviews FOR ALL
USING (public.user_owns_claim(claim_id))
WITH CHECK (public.user_owns_claim(claim_id));

-- === settlements ===
DROP POLICY IF EXISTS "Users manage settlements of their company claims" ON public.settlements;
CREATE POLICY "Users manage settlements of their company claims"
ON public.settlements FOR ALL
USING (public.user_owns_claim(claim_id))
WITH CHECK (public.user_owns_claim(claim_id));

-- === sync_jobs (read-only via app; writes are service-role) ===
DROP POLICY IF EXISTS "Users read sync jobs of their company integrations" ON public.sync_jobs;
CREATE POLICY "Users read sync jobs of their company integrations"
ON public.sync_jobs FOR SELECT
USING (public.user_owns_integration(integration_id));

-- === vessel_analytics_profiles ===
DROP POLICY IF EXISTS "Users manage vessel profiles of their company" ON public.vessel_analytics_profiles;
CREATE POLICY "Users manage vessel profiles of their company"
ON public.vessel_analytics_profiles FOR ALL
USING (public.is_company_member(company_id))
WITH CHECK (public.is_company_member(company_id));

-- === vessel_telemetry_streams ===
DROP POLICY IF EXISTS "Users manage telemetry streams of their company" ON public.vessel_telemetry_streams;
CREATE POLICY "Users manage telemetry streams of their company"
ON public.vessel_telemetry_streams FOR ALL
USING (public.is_company_member(company_id))
WITH CHECK (public.is_company_member(company_id));

-- === voyage_alerts ===
DROP POLICY IF EXISTS "Users manage voyage_alerts of their company claims" ON public.voyage_alerts;
CREATE POLICY "Users manage voyage_alerts of their company claims"
ON public.voyage_alerts FOR ALL
USING (public.user_owns_claim(claim_id))
WITH CHECK (public.user_owns_claim(claim_id));

-- === webhook_logs (read-only via app; writes are service-role) ===
DROP POLICY IF EXISTS "Users read webhook logs of their company integrations" ON public.webhook_logs;
CREATE POLICY "Users read webhook logs of their company integrations"
ON public.webhook_logs FOR SELECT
USING (public.user_owns_integration(integration_id));

-- === autonomous_negotiation_rooms ===
DROP POLICY IF EXISTS "Users manage negotiation rooms of their company" ON public.autonomous_negotiation_rooms;
CREATE POLICY "Users manage negotiation rooms of their company"
ON public.autonomous_negotiation_rooms FOR ALL
USING (public.is_company_member(company_id))
WITH CHECK (public.is_company_member(company_id));
