-- Fix RLS on the public-API tables so a logged-in user can actually manage
-- their own keys and webhooks.
--
-- THE BUG: `api_keys`, `api_webhooks` and `api_webhook_deliveries` were created
-- with policies keyed on `auth.jwt() -> 'app_metadata' ->> 'company_id'`. That
-- claim is ALWAYS NULL in this project — `custom_access_token_hook` was never
-- enabled — so the predicate is `company_id = NULL`, which is never true. Every
-- end-user read and write against these three tables was denied.
--
-- The visible symptom was that creating an API key in Settings → Developer
-- returned 500 `KEY_CREATE_FAILED: new row violates row-level security policy`.
-- Nothing detected it earlier because the tables are only reachable from that
-- one screen, and the other consumers of these tables (the authenticator, the
-- webhook sweep) use the service-role client, which bypasses RLS entirely —
-- so the API itself worked while the only way to obtain a key did not.
--
-- The fix is the pattern the rest of the schema uses and that the project's
-- own handoff notes mandate for new tables: `public.is_company_member()`,
-- which resolves membership through `company_members` keyed on `auth.uid()`.
--
-- This widens access from "nobody" to "members of the owning company". It
-- cannot widen it further: service-role callers were already bypassing RLS,
-- and no policy here grants anything to `anon`.

-- === api_keys ===
DROP POLICY IF EXISTS "Users manage API keys of their company" ON public.api_keys;
CREATE POLICY "Users manage API keys of their company"
  ON public.api_keys FOR ALL
  USING (public.is_company_member(company_id))
  WITH CHECK (public.is_company_member(company_id));

-- === api_webhooks ===
DROP POLICY IF EXISTS "Users manage webhooks of their company" ON public.api_webhooks;
CREATE POLICY "Users manage webhooks of their company"
  ON public.api_webhooks FOR ALL
  USING (public.is_company_member(company_id))
  WITH CHECK (public.is_company_member(company_id));

-- === api_webhook_deliveries ===
-- Read-only for users: deliveries are written by the sweep under service role.
-- Scoped through the parent webhook, which is where company ownership lives.
DROP POLICY IF EXISTS "Users read webhook deliveries of their company" ON public.api_webhook_deliveries;
CREATE POLICY "Users read webhook deliveries of their company"
  ON public.api_webhook_deliveries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.api_webhooks w
      WHERE w.id = api_webhook_deliveries.webhook_id
        AND public.is_company_member(w.company_id)
    )
  );
