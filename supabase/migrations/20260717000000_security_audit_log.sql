-- Tamper-evident tenant audit trail.
--
-- One table and one function. Sensitive acts — sharing a claim with a
-- counterparty, clearing settlement funds, issuing an API key, amending a
-- confirmed event — append an entry that is hash-chained to the one before it,
-- per company.
--
-- Two design decisions carry the weight:
--
-- 1. NO write policy. RLS is enabled with a SELECT policy and nothing else, so
--    `authenticated` and `anon` can read their own company's trail and cannot
--    insert, update or delete a single row through PostgREST. The only writer
--    is append_security_event() under the service role. An audit log its
--    subject can edit is decoration; this one they cannot.
--
-- 2. Hash chaining, so that editing the table DIRECTLY — the DBA, a leaked
--    service-role key, a restored backup — is detectable rather than silent.
--    Each entry commits to its predecessor, so changing any stored field or
--    removing a row from the middle invalidates every hash after it.
--    src/lib/audit/security-log.ts recomputes the chain and reports where.
--
-- Truncation from the END is the honest gap: a shortened chain is still
-- internally consistent. Pin the head hash externally (the Merkle notary in
-- src/lib/legal/ anchors fingerprints to an RFC-3161 timestamp) to close it.
--
-- The hash is computed with the BUILT-IN sha256(bytea) — core Postgres since
-- 11, no pgcrypto dependency, so this migration cannot fail on an instance
-- where the extension was never installed.

-- === 1. The trail ===
CREATE TABLE IF NOT EXISTS public.security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,

  -- Position in this company's chain, from 1. UNIQUE with company_id: two
  -- concurrent appends cannot both claim a position and fork the chain.
  seq bigint NOT NULL,

  -- Supplied by the application (millisecond ISO-8601) because it is part of
  -- the hashed body. recorded_at is the database's own clock — a meaningful
  -- gap between the two is itself worth looking at.
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),

  actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'guest', 'system', 'cron')),
  actor_id uuid,            -- auth user id when there is one
  actor_label text NOT NULL DEFAULT '',  -- email, key prefix, token fragment

  action text NOT NULL,
  resource_type text NOT NULL DEFAULT '',
  resource_id text NOT NULL DEFAULT '',
  outcome text NOT NULL DEFAULT 'allowed' CHECK (outcome IN ('allowed', 'denied', 'error')),

  -- Queryable detail. Hashed indirectly, via metadata_hash, so that a jsonb
  -- normalisation difference can never be mistaken for a broken chain: the
  -- two failures are reported separately by the verifier.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_hash text NOT NULL,

  ip text,
  user_agent text,

  prev_hash text NOT NULL,
  entry_hash text NOT NULL,

  UNIQUE (company_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_security_events_company_time
  ON public.security_events (company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_company_action
  ON public.security_events (company_id, action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_resource
  ON public.security_events (company_id, resource_type, resource_id);

-- === 2. The only writer ===
-- The application computes the canonical body (all the format-sensitive
-- work — timestamps, JSON, null handling — in tested TypeScript). This
-- function adds only the two values it alone can assign atomically, seq and
-- prev_hash, and hashes. Keeping the SQL side this thin is what makes
-- "the two implementations agree" a claim worth believing.
--
-- MUST mirror entryHash() in src/lib/audit/security-log.ts:
--   sha256( seq || chr(31) || prev_hash || chr(31) || body )
CREATE OR REPLACE FUNCTION public.append_security_event(
  p_company_id uuid,
  p_occurred_at timestamptz,
  p_actor_type text,
  p_actor_id uuid,
  p_actor_label text,
  p_action text,
  p_resource_type text,
  p_resource_id text,
  p_outcome text,
  p_metadata jsonb,
  p_metadata_hash text,
  p_body text,
  p_ip text,
  p_user_agent text,
  OUT event_id uuid,
  OUT event_seq bigint,
  OUT event_hash text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_prev text;
BEGIN
  -- Serialise appends within a company. Without this, two concurrent writers
  -- could read the same head and chain off it, producing two entries with the
  -- same prev_hash — a fork. The UNIQUE (company_id, seq) constraint would
  -- reject the second, but a lock turns a hard error into a short wait.
  -- Transaction-scoped: released on commit or rollback, never leaked.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text, 0));

  SELECT se.seq, se.entry_hash
    INTO event_seq, v_prev
    FROM public.security_events se
   WHERE se.company_id = p_company_id
   ORDER BY se.seq DESC
   LIMIT 1;

  IF event_seq IS NULL THEN
    event_seq := 1;
    v_prev := repeat('0', 64);   -- genesis
  ELSE
    event_seq := event_seq + 1;
  END IF;

  event_hash := encode(
    sha256(convert_to(event_seq::text || chr(31) || v_prev || chr(31) || p_body, 'UTF8')),
    'hex'
  );

  INSERT INTO public.security_events (
    company_id, seq, occurred_at, actor_type, actor_id, actor_label,
    action, resource_type, resource_id, outcome,
    metadata, metadata_hash, ip, user_agent, prev_hash, entry_hash
  )
  VALUES (
    p_company_id, event_seq, p_occurred_at, p_actor_type, p_actor_id, coalesce(p_actor_label, ''),
    p_action, coalesce(p_resource_type, ''), coalesce(p_resource_id, ''), p_outcome,
    coalesce(p_metadata, '{}'::jsonb), p_metadata_hash, p_ip, p_user_agent, v_prev, event_hash
  )
  RETURNING security_events.id INTO event_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.append_security_event(
  uuid, timestamptz, text, uuid, text, text, text, text, text, jsonb, text, text, text, text
) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_security_event(
  uuid, timestamptz, text, uuid, text, text, text, text, text, jsonb, text, text, text, text
) TO service_role;

-- === 3. RLS: readable by its subject, writable by nobody ===
ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;

-- Read is deliberately open to every member of the company rather than admins
-- only: seeing what happened in your own tenant is not a privilege escalation,
-- and a trail that only the person most likely to be investigated can read is
-- worth less. Cross-tenant reads are impossible — the predicate is the JWT's
-- own company_id, exactly as everywhere else in this schema.
CREATE POLICY "Users read the security trail of their company"
ON public.security_events FOR SELECT
USING (company_id = (auth.jwt() -> 'app_metadata' ->> 'company_id')::uuid);

-- No INSERT, UPDATE or DELETE policy exists, and none should be added. With
-- RLS enabled, absent policies deny — that is the mechanism enforcing
-- append-only against every client that is not the service role.
