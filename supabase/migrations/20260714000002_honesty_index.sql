-- Terminal & Agent Honesty Index: a cross-company aggregate of evidence
-- verification outcomes, scoring ports and agents by how often their SoF
-- delay claims were contradicted by objective data (weather archive / AIS).

-- === 1. Materialized view: honesty_index ===
-- Aggregates every evidence check twice, once per subject dimension:
--   * 'port'  — every claim has a port (NOT NULL), keyed on lower(trim(port));
--   * 'agent' — the claim's counterparty_name, skipped when NULL or blank.
-- Grouped by (subject, check_type) so weather and NOR-position track records
-- stay separate. "Decisive" checks are the only ones a rate can be built on:
-- corroborated or contradicted; inconclusive/unavailable prove nothing either
-- way and must not dilute the denominator.
-- subject_label keeps a stable original-cased display value (min() over the
-- group) while subject_key does the case/whitespace-insensitive matching.
CREATE MATERIALIZED VIEW public.honesty_index AS
WITH subject_checks AS (
  SELECT
    'port'::text            AS subject_type,
    lower(trim(c.port))     AS subject_key,
    trim(c.port)            AS subject_label,
    ec.check_type,
    ec.verdict,
    ec.claim_id,
    ec.checked_at
  FROM public.evidence_checks ec
  JOIN public.claims c ON c.id = ec.claim_id

  UNION ALL

  SELECT
    'agent'::text                       AS subject_type,
    lower(trim(c.counterparty_name))    AS subject_key,
    trim(c.counterparty_name)           AS subject_label,
    ec.check_type,
    ec.verdict,
    ec.claim_id,
    ec.checked_at
  FROM public.evidence_checks ec
  JOIN public.claims c ON c.id = ec.claim_id
  WHERE c.counterparty_name IS NOT NULL
    AND trim(c.counterparty_name) <> ''
)
SELECT
  subject_type,
  subject_key,
  min(subject_label) AS subject_label,
  check_type,
  count(*) AS total_checks,
  count(*) FILTER (WHERE verdict IN ('corroborated', 'contradicted')) AS decisive_checks,
  count(*) FILTER (WHERE verdict = 'contradicted') AS contradicted_checks,
  count(*) FILTER (WHERE verdict = 'corroborated') AS corroborated_checks,
  count(DISTINCT claim_id) AS claims_covered,
  max(checked_at) AS last_checked_at
FROM subject_checks
GROUP BY subject_type, subject_key, check_type
WITH DATA;

-- REFRESH MATERIALIZED VIEW CONCURRENTLY requires at least one unique index
-- covering every row; (subject_type, subject_key, check_type) is the natural
-- grain of the view. Also serves point lookups by subject.
CREATE UNIQUE INDEX uniq_honesty_index_subject
  ON public.honesty_index (subject_type, subject_key, check_type);

-- === 2. Access control ===
-- Materialized views cannot carry RLS, and this one aggregates evidence
-- across ALL companies. It must therefore never be readable through the
-- PostgREST anon/authenticated roles: the API route reads it exclusively via
-- the service-role client, which enforces the k-anonymity floor (subjects
-- with < 5 decisive checks are suppressed) and returns only aggregates —
-- never claim or company identifiers.
REVOKE ALL ON public.honesty_index FROM anon, authenticated;

-- === 3. Refresh function ===
-- SECURITY DEFINER because REFRESH requires ownership of the matview;
-- search_path is pinned so the definer privilege can't be hijacked via a
-- crafted schema. CONCURRENTLY keeps the view readable during refresh
-- (backed by the unique index above).
CREATE OR REPLACE FUNCTION public.refresh_honesty_index()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.honesty_index;
END;
$$;

-- Only the server (service role) may trigger a refresh — functions are
-- executable by PUBLIC by default, so revoke that first.
REVOKE EXECUTE ON FUNCTION public.refresh_honesty_index() FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_honesty_index() TO service_role;
