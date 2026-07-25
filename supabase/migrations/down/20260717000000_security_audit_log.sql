-- Down migration for 20260717000000_security_audit_log.sql — reverse order.
--
-- NB this DESTROYS the audit trail. The whole point of the table is that its
-- contents cannot be quietly altered; dropping it deletes them outright, and
-- re-applying the up migration starts a fresh chain from genesis. Export
-- (GET /api/security/events) before running this if the history matters.

DROP POLICY IF EXISTS "Users read the security trail of their company" ON public.security_events;

DROP FUNCTION IF EXISTS public.append_security_event(
  uuid, timestamptz, text, uuid, text, text, text, text, text, jsonb, text, text, text, text
);

DROP TABLE IF EXISTS public.security_events;
