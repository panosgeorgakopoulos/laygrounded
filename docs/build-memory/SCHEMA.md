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
