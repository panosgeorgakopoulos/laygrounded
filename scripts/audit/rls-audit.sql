-- ============================================================================
-- RLS AUDIT: cross-company leakage probes for the claim-room and charter-
-- chain surfaces (claim_shares, event_proposals, sof_events, claims +
-- parent_claim_id), plus grant hygiene for the cross-tenant matviews.
--
-- Self-contained and non-destructive: everything happens inside one
-- transaction that ends in ROLLBACK. Run with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/audit/rls-audit.sql
--
-- PASS = script completes and prints "RLS AUDIT PASSED".
-- FAIL = a DO block raises an exception (psql exits non-zero).
--
-- Impersonation matches production exactly: policies read
-- auth.jwt() -> 'app_metadata' ->> 'company_id', and auth.jwt() reads the
-- request.jwt.claims GUC that PostgREST sets per request — so setting that
-- GUC under SET LOCAL ROLE authenticated exercises the real enforcement path.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Section A (informational): policy inventory for the audited tables.
-- ---------------------------------------------------------------------------
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       count(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN ('claims', 'claim_shares', 'event_proposals', 'sof_events',
                    'voyage_alerts', 'settlements', 'insurance_policies',
                    'insurance_triggers', 'pending_human_reviews', 'data_lineage')
GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
ORDER BY c.relname;

SELECT schemaname, tablename, policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('claims', 'claim_shares', 'event_proposals', 'sof_events')
ORDER BY tablename, policyname;

-- ---------------------------------------------------------------------------
-- Section B (assertions): every audited table that exists must have RLS
-- enabled and at least one policy whose predicate is company-scoped (its
-- expression references company_id, directly or via the claims subquery).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  rls boolean;
  scoped_policies int;
BEGIN
  FOREACH t IN ARRAY ARRAY['claims', 'claim_shares', 'event_proposals', 'sof_events',
                           'voyage_alerts', 'settlements', 'insurance_policies',
                           'insurance_triggers', 'pending_human_reviews', 'data_lineage']
  LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'SKIP (table not present yet): %', t;
      CONTINUE;
    END IF;

    SELECT relrowsecurity INTO rls FROM pg_class WHERE oid = to_regclass('public.' || t);
    IF NOT rls THEN
      RAISE EXCEPTION 'RLS AUDIT FAILED: table % has row level security DISABLED', t;
    END IF;

    -- A policy counts as company-scoped if its predicate references
    -- company_id directly OR goes through one of the schema's ownership
    -- helpers (user_owns_claim / is_company_member — SECURITY DEFINER
    -- functions that resolve to claims.company_id membership).
    SELECT count(*) INTO scoped_policies
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t
      AND (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
          ~ '(company_id|user_owns_claim|is_company_member)';
    IF scoped_policies = 0 THEN
      RAISE EXCEPTION 'RLS AUDIT FAILED: table % has no company_id-scoped policy', t;
    END IF;

    RAISE NOTICE 'OK: % — RLS enabled, % company-scoped policies', t, scoped_policies;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Section C (leakage probes): two synthetic tenants, rolled back at the end.
--   Company A owns a parent claim with an event, a share, and a proposal.
--   Company B owns a sub-claim whose parent_claim_id points at A's claim —
--   the exact join an attacker would use to read up the charter chain.
-- Setup runs as the connection role (table owner bypasses non-FORCED RLS).
-- ---------------------------------------------------------------------------
SELECT set_config('audit.company_a', gen_random_uuid()::text, true);
SELECT set_config('audit.company_b', gen_random_uuid()::text, true);
SELECT set_config('audit.user_a',    gen_random_uuid()::text, true);
SELECT set_config('audit.user_b',    gen_random_uuid()::text, true);
SELECT set_config('audit.claim_a',   gen_random_uuid()::text, true);
SELECT set_config('audit.claim_b',   gen_random_uuid()::text, true);
SELECT set_config('audit.doc_a',     gen_random_uuid()::text, true);
SELECT set_config('audit.event_a',   gen_random_uuid()::text, true);

INSERT INTO public.companies (id, name) VALUES
  (current_setting('audit.company_a')::uuid, 'RLS-AUDIT tenant A'),
  (current_setting('audit.company_b')::uuid, 'RLS-AUDIT tenant B');

-- The live policies resolve through is_company_member(company_id), i.e. a
-- company_members row for auth.uid() — so each synthetic tenant needs a real
-- membership (and auth.users row for the FK). Rolled back with everything else.
INSERT INTO auth.users (id, email) VALUES
  (current_setting('audit.user_a')::uuid, 'rls-audit-a@invalid.test'),
  (current_setting('audit.user_b')::uuid, 'rls-audit-b@invalid.test');

INSERT INTO public.company_members (company_id, user_id, role) VALUES
  (current_setting('audit.company_a')::uuid, current_setting('audit.user_a')::uuid, 'admin'),
  (current_setting('audit.company_b')::uuid, current_setting('audit.user_b')::uuid, 'admin');

INSERT INTO public.claims (id, company_id, vessel, voyage_ref, port, cargo, cp_form, status)
VALUES (current_setting('audit.claim_a')::uuid, current_setting('audit.company_a')::uuid,
        'MV AUDIT ALPHA', 'AUD-A-1', 'Santos', 'Soybeans', 'GENCON94', 'draft');

INSERT INTO public.documents (id, claim_id, storage_path, mime, extraction_status)
VALUES (current_setting('audit.doc_a')::uuid, current_setting('audit.claim_a')::uuid,
        'audit/probe', 'manual', 'extracted');

INSERT INTO public.sof_events (id, claim_id, document_id, occurred_at, event_type, raw_text, status)
VALUES (current_setting('audit.event_a')::uuid, current_setting('audit.claim_a')::uuid,
        current_setting('audit.doc_a')::uuid, now(), 'NOR_TENDERED', 'audit probe event', 'accepted');

INSERT INTO public.claim_shares (claim_id, token, counterparty_label, expires_at)
VALUES (current_setting('audit.claim_a')::uuid, 'rls-audit-' || gen_random_uuid(),
        'Audit Counterparty', now() + interval '1 day');

INSERT INTO public.event_proposals (claim_id, event_id, action, note)
VALUES (current_setting('audit.claim_a')::uuid, current_setting('audit.event_a')::uuid,
        'remove', 'audit probe proposal');

-- Company B's sub-claim linked to A's claim, when the chain migration is in.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'claims'
               AND column_name = 'parent_claim_id') THEN
    INSERT INTO public.claims (id, company_id, vessel, voyage_ref, port, cargo, cp_form, status,
                               parent_claim_id, chain_role, chain_depth)
    VALUES (current_setting('audit.claim_b')::uuid, current_setting('audit.company_b')::uuid,
            'MV AUDIT ALPHA', 'AUD-A-1', 'Santos', 'Soybeans', 'GENCON94', 'draft',
            current_setting('audit.claim_a')::uuid, 'sub_charterer', 1);
  ELSE
    INSERT INTO public.claims (id, company_id, vessel, voyage_ref, port, cargo, cp_form, status)
    VALUES (current_setting('audit.claim_b')::uuid, current_setting('audit.company_b')::uuid,
            'MV AUDIT ALPHA', 'AUD-A-1', 'Santos', 'Soybeans', 'GENCON94', 'draft');
    RAISE NOTICE 'chain columns not present — parent_claim_id join probe degrades to plain isolation probe';
  END IF;
END $$;

-- --- Impersonate the company-B member, exactly as PostgREST would ---
-- sub drives auth.uid() → is_company_member(); app_metadata.company_id is
-- included too so the probe also covers the JWT-claim policy style.
SELECT set_config('request.jwt.claims',
  json_build_object('sub', current_setting('audit.user_b'), 'role', 'authenticated',
                    'app_metadata', json_build_object('company_id', current_setting('audit.company_b')))::text,
  true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n int;
  has_chain boolean;
BEGIN
  -- Positive control first: B must see its OWN claim, otherwise the probes
  -- below would "pass" merely because RLS blocks everything.
  SELECT count(*) INTO n FROM public.claims WHERE id = current_setting('audit.claim_b')::uuid;
  IF n <> 1 THEN
    RAISE EXCEPTION 'RLS AUDIT FAILED (positive control): company B cannot see its own claim (saw % rows)', n;
  END IF;

  -- Probe 1: direct read of A's claim.
  SELECT count(*) INTO n FROM public.claims WHERE id = current_setting('audit.claim_a')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'RLS AUDIT FAILED: cross-company SELECT leaked % row(s) of company A''s claim', n;
  END IF;

  -- Probe 2: the chain-join bypass — read the parent through parent_claim_id.
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'claims'
                   AND column_name = 'parent_claim_id') INTO has_chain;
  IF has_chain THEN
    EXECUTE 'SELECT count(*) FROM public.claims child
             JOIN public.claims parent ON parent.id = child.parent_claim_id
             WHERE child.id = $1'
      INTO n USING current_setting('audit.claim_b')::uuid;
    IF n <> 0 THEN
      RAISE EXCEPTION 'RLS AUDIT FAILED: parent_claim_id join exposed the upstream tenant''s claim';
    END IF;
    RAISE NOTICE 'OK: parent_claim_id join returns 0 rows across tenants (RLS applies per joined row)';
  END IF;

  -- Probe 3: A's claim room artifacts (shares, proposals, events).
  SELECT count(*) INTO n FROM public.claim_shares WHERE claim_id = current_setting('audit.claim_a')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS AUDIT FAILED: claim_shares leaked across tenants'; END IF;
  SELECT count(*) INTO n FROM public.event_proposals WHERE claim_id = current_setting('audit.claim_a')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS AUDIT FAILED: event_proposals leaked across tenants'; END IF;
  SELECT count(*) INTO n FROM public.sof_events WHERE claim_id = current_setting('audit.claim_a')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'RLS AUDIT FAILED: sof_events leaked across tenants'; END IF;

  -- Probe 4: UPDATE must be blocked, not just SELECT (0 rows affected).
  UPDATE public.claims SET status = 'tampered' WHERE id = current_setting('audit.claim_a')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'RLS AUDIT FAILED: cross-company UPDATE modified % row(s)', n;
  END IF;

  RAISE NOTICE 'OK: company B sees/touches nothing of company A (direct, join, rooms, update)';
END $$;

RESET ROLE;

-- --- Reverse direction: an upstream tenant must not see the sub-claim ---
SELECT set_config('request.jwt.claims',
  json_build_object('sub', current_setting('audit.user_a'), 'role', 'authenticated',
                    'app_metadata', json_build_object('company_id', current_setting('audit.company_a')))::text,
  true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.claims WHERE id = current_setting('audit.claim_b')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'RLS AUDIT FAILED: upstream tenant can read the downstream sub-claim';
  END IF;
  RAISE NOTICE 'OK: chain isolation holds in both directions';
END $$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- Section D: cross-tenant materialized views must carry NO grants for
-- end-user roles (matviews cannot have RLS; the API layer is their boundary).
-- ---------------------------------------------------------------------------
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['honesty_index', 'oracle_voyage_stats']
  LOOP
    IF to_regclass('public.' || v) IS NULL THEN
      RAISE NOTICE 'SKIP (matview not present yet): %', v;
      CONTINUE;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || v, 'SELECT')
       OR has_table_privilege('anon', 'public.' || v, 'SELECT') THEN
      RAISE EXCEPTION 'RLS AUDIT FAILED: matview % is readable by end-user roles', v;
    END IF;
    RAISE NOTICE 'OK: % has no anon/authenticated grants', v;
  END LOOP;
END $$;

SELECT 'RLS AUDIT PASSED' AS verdict;

ROLLBACK;
