# Build Memory — Schema Dependency Map

Existing tables this build reads: `claims`, `sof_events`, `laytime_calculations`
(jsonb `breakdown` of `BreakdownRow[]`), `evidence_checks` (verdicts:
corroborated | contradicted | inconclusive | unavailable), `event_proposals`,
`claim_shares`, `drafts`, `integrations`.

## New objects by migration

### 20260714000001_voyage_shield.sql (Module 1)
- `voyage_alerts` — claim_id FK, event_id FK(sof_events), evidence_check_id FK
  (SET NULL: evidence is replace-on-rerun), draft_id FK(drafts), alert_type,
  status open|draft_generated|served|dismissed, detail jsonb.
  UNIQUE (claim_id, alert_type, event_id) = idempotent re-monitoring.
- `drafts.kind` CHECK widened to include `letter_of_protest`
  (drop + re-add `drafts_kind_check`).

### 20260714000002_honesty_index.sql (Module 2 — subagent)
- MATVIEW `honesty_index` — subject_type port|agent, subject_key, contradiction
  stats from `evidence_checks` × `claims` (agent = claims.counterparty_name).
  UNIQUE index on (subject_type, subject_key, check_type) → allows
  REFRESH ... CONCURRENTLY. No grants to authenticated/anon (AD-002).
- `refresh_honesty_index()` SECURITY DEFINER fn, EXECUTE granted to
  service_role only.

### 20260714000003_settlement_clearinghouse.sql (Module 3)
- `settlements` — claim_id UNIQUE FK, calculation_id FK(laytime_calculations,
  SET NULL), amount/currency/direction collect|pay, status
  eligible|initiated|cleared|failed|ineligible, eligibility jsonb snapshot,
  provider/provider_ref, idempotency_key UNIQUE, company RLS via claims.

### 20260714000004_pricing_oracle.sql (Module 4 — subagent)
- MATVIEW `oracle_voyage_stats` — one row per laytime_calculation: port_key,
  month (from first breakdown row), cargo, weather_delay_hours (sum of
  breakdown rows with status 'weather_delay'), used/allowed hours, verified
  flag (claim has no contradicted evidence). UNIQUE index on calculation id.
  Service-role only (AD-002). `refresh_oracle_voyage_stats()` same pattern
  as Module 2.

### 20260714000005_charter_chain.sql (Module 5)
- `claims` += parent_claim_id FK(claims, ON DELETE SET NULL), chain_role
  owner|head_charterer|sub_charterer|receiver (default owner), chain_depth int.
- `sof_events` += locked bool default false, locked_reason text;
  document_id relaxed to NULLABLE (AD-005).

### 20260714000006_insurance_oracle.sql (Module 6)
- `insurance_policies` — company_id FK, insurer_label, api_key_hash UNIQUE
  (sha256; plaintext key returned exactly once at creation, like webhook
  secrets), webhook_url, webhook_secret, threshold_hours (default 120 = 5
  days), status active|paused.
- `insurance_triggers` — policy_id FK, claim_id FK, delay_hours, window_start/
  end, payload jsonb, delivery_status pending|delivered|failed,
  idempotency_key UNIQUE (= policy:claim:window hash).

## Cross-module dependencies
- `evidence_checks` feeds Modules 1 (contradicted → LoP), 2 (index numerator),
  3 (100%-corroborated gate), 5 (corroborated → fact lock).
- `laytime_calculations.breakdown` feeds 3 (amount), 4 (stats), 6 (continuous
  weather-delay detection). Breakdown row shape = `BreakdownRow` in
  `src/lib/laytime/types.ts` — any engine change to it ripples here.
- Module 1 depends on migration 1's drafts CHECK before any LoP insert.
- `evidence_checks` is replace-on-rerun ⇒ FKs into it must be ON DELETE SET
  NULL and consumers must never assume a check row survives a re-verify.

### 20260715000002_frontier_expansion.sql (Frontier tier)
- `claims` += is_locked bool default false (notarization freeze; set via
  /api/v1/claims/[claimId]/notarize with lock:true).
- `vessel_analytics_profiles` — company_id FK, vessel_imo (UNIQUE per
  company), cii_rating A–E, attained/required CII, dwt, annual_distance_nm,
  baseline_speed, consumption_curve jsonb ({at_berth_aux_tonnes_per_day,
  sea_curve:[{speed_knots,tonnes_per_day}]}), last_hull_cleaning. Company RLS.
- `compliance_ledger` — claim_id FK, entry_kind mrv_ets|cii_degradation|
  biofouling|sftw_arbitration|green_twin|time_proof, scope3/mrv CO2 numerics,
  eua_liability_eur, details jsonb, cryptographic_signature (Merkle root or
  canonical sha256), signature_algo. APPEND-ONLY: SELECT+INSERT policies only.
- `port_honesty_and_resilience_index` MATVIEW — grain (port_key, month):
  weather decisive/contradicted counts + rate (month = checked event's month),
  median/p90 NOR→berth congestion hours (confirmed events only). No end-user
  grants (AD-002); `refresh_port_honesty_and_resilience_index()` service-role.
- `drafts.kind` CHECK += 'arrest_dossier'; `pending_human_reviews.subject_type`
  CHECK += 'arrest_dossier'.

### 20260715000003_autonomous_expansion.sql (Autonomous tier)
- `autonomous_negotiation_rooms` — claim_id + company_id FKs, status
  completed|approved|rejected, max_concession_usd, hard_stop_clauses jsonb
  (owner agent's mandate; charterer limits live inside the matrix json),
  agent_rounds_completed, final_settlement_probability (0–1),
  settlement_matrix jsonb. Company RLS; append per run (history preserved).
- `vessel_telemetry_streams` — company_id, vessel_imo, optional claim_id,
  destination_port, current_speed_knots, distance_to_port_nm,
  predicted_congestion_delay_hours, source api|m2m, recorded_at. Company RLS;
  optimizer reads latest per (company, vessel_imo).
- `sof_events` += ais_geofence_verified bool NULL (three-state: NULL never
  checked / true verified / false discrepancy + critical AIS-GEOFENCE flag).
- `pending_human_reviews.subject_type` CHECK += 'autonomous_settlement';
  `compliance_ledger.entry_kind` CHECK += 'efti_export'.
- Ordering: must run AFTER 20260715000002 (extends its CHECK constraints).

## 20260716000001_mrv_reports.sql (PENDING — user must apply)
- `mrv_reports` — company_id, reporting_period int (CHECK 2015..2100), report
  jsonb (the full MrvAnnualReport), merkle_root, signature_algo
  ('sha256-merkle-v1', same as the legal notary), leaf_count, submittable
  bool, verification_status text CHECK (= 'unverified' — pins out
  self-certification at the DB level), generated_by, sealed_at. Company RLS
  (JWT app_metadata style). Index (company_id, reporting_period, sealed_at
  DESC).
- Append-only: each row seals what the book looked like at sealed_at; never
  replace-on-rerun (that would destroy the proof of the earlier state).
- Not compliance_ledger: that is claim-scoped (claim_id NOT NULL) and its
  entry_kind CHECK covers claim-level carbon findings, not period reports.
- Validated by BEGIN…ROLLBACK dry-run against the hosted DB: the
  verification_status CHECK rejects 'verified', the period CHECK rejects 1999,
  a valid insert defaults to unverified/false.
- Apply with:
  psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20260716000001_mrv_reports.sql

## 20260716000002_audit_trail_api.sql (PENDING — user must apply)
- `api_keys` — company_id, label, key_hash UNIQUE (sha256; plaintext shown
  once, never stored), key_prefix (non-secret display fragment), scopes text[],
  status active|revoked, rate_limit_per_minute (CHECK 1..100000), last_used_at,
  expires_at, created_by, revoked_at. Company RLS.
- `api_webhooks` — company_id, url, secret (returned once), event_types text[],
  status active|paused, last_error. Company RLS.
- `api_webhook_deliveries` — webhook_id, claim_id, event_type,
  idempotency_key, payload, status, attempts, response_status, delivered_at.
  UNIQUE (webhook_id, idempotency_key) ⇒ at-most-once per time-bar crossing.
  SELECT-only RLS via the parent webhook's company.
- `api_rate_limits` — (api_key_id, window_start) PK, request_count. RLS ON with
  ZERO policies: service-role only. A tenant must not read or tamper with its
  own quota counters.
- `consume_api_rate_limit(uuid, timestamptz, int)` — SECURITY DEFINER, atomic
  INSERT … ON CONFLICT DO UPDATE … RETURNING; EXECUTE revoked from
  public/anon/authenticated, granted to service_role only.
- Dry-run validated against the hosted DB: limit 3 ⇒ requests 1,2,3 allowed,
  4th refused, next window resets; rate_limit_per_minute=0 and duplicate
  key_hash both rejected.
- Apply with:
  psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20260716000002_audit_trail_api.sql

## 20260717000000_security_audit_log.sql (PENDING — user must apply)

Tamper-evident tenant audit trail. One table, one function, one policy.

**security_events** — append-only, hash-chained per company.
- `company_id` → companies (CASCADE), `seq bigint`, UNIQUE (company_id, seq).
  The unique key is what stops two concurrent appends forking the chain.
- `occurred_at` (application clock, part of the hashed body) and `recorded_at`
  (database clock, DEFAULT now(), NOT hashed) — a wide gap between the two is
  itself a signal.
- `actor_type` CHECK IN (user, api_key, guest, system, cron), `actor_id` uuid
  (nullable — a machine credential has no user id), `actor_label`.
- `action`, `resource_type`, `resource_id`, `outcome` CHECK IN (allowed,
  denied, error).
- `metadata jsonb` + `metadata_hash` — hashed indirectly so a jsonb key
  reordering cannot masquerade as a broken chain.
- `prev_hash`, `entry_hash` — sha256(seq ‖ chr(31) ‖ prev_hash ‖ chr(31) ‖
  body), genesis = 64 zeros.
- Indexes: (company_id, occurred_at DESC), (company_id, action, occurred_at
  DESC), (company_id, resource_type, resource_id).

**append_security_event(...)** — SECURITY DEFINER, the only writer. Takes a
per-company `pg_advisory_xact_lock` so appends serialise, reads the head,
computes the hash with the BUILT-IN `sha256(bytea)` (no pgcrypto dependency),
inserts. OUT params `event_id, event_seq, event_hash` — named distinctly to
avoid plpgsql column/variable ambiguity. EXECUTE revoked from
public/anon/authenticated, granted to service_role only.

**RLS** — SELECT policy on the JWT's company_id. Deliberately NO insert,
update or delete policy: absent policies deny, which is the mechanism that
makes the table append-only for every client that is not the service role.
Do not add one.

Verified against Postgres 17 before shipping: migration applies clean; SQL and
TypeScript produce identical hashes (incl. unicode, apostrophes, reordered
jsonb); a company member can read all rows and gets UPDATE 0 / DELETE 0; and
direct superuser edits are caught as metadata_mismatch / hash_mismatch /
sequence_gap.

Consumed by `GET /api/security/events` (list, keyset-paginated on seq) and
`GET /api/security/verify` (full-chain recomputation), surfaced in Settings →
Security Trail.

## 20260718000000_oauth_mcp.sql (PENDING — user must apply)

OAuth 2.1 + PKCE authorization server for the MCP endpoint. Five tables, all
service-role only (RLS on, no policy) except a user-readable consent view.
Codes and tokens stored as SHA-256 hashes only.

**oauth_clients** — self-registered (RFC 7591). client_id UNIQUE, NOT a secret;
client_secret_hash nullable (public clients). redirect_uris text[] NOT NULL,
cardinality > 0, EXACT match only (no wildcard — OAuth 2.1). token_endpoint_
auth_method CHECK in (none, client_secret_post, client_secret_basic).
**oauth_authorization_codes** — the PKCE store. code_hash UNIQUE; code_challenge
+ code_challenge_method CHECK (= 'S256', blocks downgrade to plain); redirect_uri
(must match /authorize exactly); resource (RFC 8707 audience binding);
consumed_at (single-use; replay SHOULD revoke descendants); short expires_at;
FKs to oauth_clients / auth.users / companies.
**oauth_access_tokens** — token_hash UNIQUE, denormalised company_id (one-lookup
tenant resolution + can't be widened if the user later moves company), scope,
resource (audience the MCP endpoint must match), authorization_code_id.
**oauth_refresh_tokens** — rotation WITH reuse detection: family_id + consumed_at
+ rotated_to_id; a reused token revokes the whole family.
**oauth_consents** — user_id/client_id UNIQUE; the ONLY OAuth table a logged-in
user can read (SELECT policy on auth.uid()); revocation goes through a route
that also kills tokens.

**purge_expired_oauth_artifacts()** — SECURITY DEFINER, service_role-only;
drops dead codes (>1d) and expired access/refresh (>30d, kept briefly for
audit). Wire to the cron sweep.

Verified on throwaway Postgres 17: migration applies clean; all five
constraints reject their unsafe states (plain PKCE, dup code_hash, empty
redirect_uris, orphan client FK, bogus auth method); RLS gives authenticated 0
token/code/client rows + 1 own-consent row, and denies both a forged INSERT and
the purge EXECUTE.

Discovery endpoints (no DB): /.well-known/oauth-protected-resource[/...] and
/.well-known/oauth-authorization-server[/...], both optional-catch-all, both
public + wildcard-CORS + 1h cache. Issuer from OAUTH_ISSUER_URL (NOT the Host
header). Metadata builders + 18 tests in src/lib/oauth/metadata.ts.

STILL TO BUILD (endpoints the metadata already advertises): /oauth/authorize
(consent screen, session-gated), /oauth/token (code→token with PKCE verify),
/oauth/register (RFC 7591), /oauth/revoke, and the /api/mcp transport itself.
