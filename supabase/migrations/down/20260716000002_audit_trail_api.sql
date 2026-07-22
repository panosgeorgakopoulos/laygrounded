-- Down migration for 20260716000002_audit_trail_api.sql — reverse order.
--
-- NB this revokes every issued API key and webhook registration. Key
-- plaintexts are unrecoverable, so re-applying the up migration does not
-- restore access: every integrator must be re-issued a key.

DROP POLICY IF EXISTS "Users read webhook deliveries of their company" ON public.api_webhook_deliveries;
DROP POLICY IF EXISTS "Users manage webhooks of their company" ON public.api_webhooks;
DROP POLICY IF EXISTS "Users manage API keys of their company" ON public.api_keys;

DROP FUNCTION IF EXISTS public.consume_api_rate_limit(uuid, timestamptz, integer);

DROP TABLE IF EXISTS public.api_rate_limits;
DROP TABLE IF EXISTS public.api_webhook_deliveries;
DROP TABLE IF EXISTS public.api_webhooks;
DROP TABLE IF EXISTS public.api_keys;
