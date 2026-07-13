# Build Memory — Verification Log & Lessons

Verification gate per module: (1) `bunx tsc --noEmit` clean, (2) `bun test
src/lib/` green, (3) import audit — every `@/lib/...` import in new files
resolves to a real export, (4) migration parses (visual + psql when DB is
reachable), (5) engine-constraint check: no new code imports gencon94
internals or performs I/O inside a pure module.

## Baseline (before any module)
- 2026-07-13: `bunx tsc --noEmit` exit 0. `bun test src/lib/` 533 pass / 0
  fail across 8 files. Any post-module failure is attributable to this build.

## Module 1 gate (voyage shield) — PASSED
- tsc exit 0; 533/533 tests pass. Imports audited: `verifyClaimEvidence`,
  `generateDraft`, client factories, `apiError` all real exports.
- `generateDraft` NO_CALCULATION guard relaxed for `letter_of_protest` only —
  a protest is drafted mid-voyage, before any calculation exists.
- Alert upsert uses `ignoreDuplicates: true` on the unique index; returned
  rows = alerts created *this* sweep, which is exactly the "new
  contradictions" set that should trigger a protest.

## Modules 2 & 4 gates (subagent work) — PASSED after absorption
- Both parallel subagents were killed mid-run by the account's session usage
  limit. Agent A (Module 2) had finished all four files and died during its
  own verification; Agent B (Module 4) delivered the migration + pricing.ts
  but not the test/routes. Orchestrator reviewed every agent file line-by-line
  (no hallucinated imports found; SQL grain, REVOKEs and SECURITY DEFINER
  hygiene correct) and wrote Module 4's missing test + routes inline.
- Gate: tsc exit 0; 571/571 tests (13 clearinghouse + 12 honesty + 13 oracle
  suites added). LESSON: when spawning parallel agents, treat their output as
  unreviewed patches — the collection review is not optional; here it also
  caught nothing missing in Module 2, which de-risked the absorption.

## Module 3 gate (clearinghouse) — PASSED
- tsc exit 0; tests green. Eligibility is deliberately maximal: 'unavailable'
  and 'inconclusive' verdicts disqualify (never a silent pass), empty evidence
  disqualifies, either settled_at or a live settlements row blocks re-entry.
- Race safety = settlements.claim_id UNIQUE + 23505 → ALREADY_SETTLED, and
  idempotency_key pins the clearing to the calculation snapshot.

## Module 5 gate (charter chain) — PASSED
- tsc exit 0; tests green. Lock enforcement verified at all three mutation
  surfaces (guest proposal POST, owner proposal PATCH accept, event PATCH).
- L-001 resolved better than planned: stub-document cloning (AD-010) kept the
  document_id NOT NULL invariant instead of relaxing it.

## Module 6 gate (insurance oracle) — PASSED
- tsc exit 0; 581/581 tests (10 detect cases: contiguity merging, format
  tolerance, gap splitting, exact-threshold firing).
- Continuity tolerance is 60s between row boundaries — engine rows are
  contiguous, but timestamp *formatting* may differ between rows.

## Final gate — PASSED (with two environment notes)
- tsc exit 0; 581 pass / 0 fail (48 new tests over baseline 533); imports
  audited (no new npm deps); engine purity confirmed (detect/pricing/
  honesty-index have zero I/O; clearinghouse mirrors the recompute-server
  bridge pattern).
- All six migrations executed cleanly against the hosted Postgres inside a
  BEGIN…ROLLBACK dry-run (exit 0). ACTUAL APPLY WAS NOT PERFORMED — the
  permission layer blocked committing DDL to the hosted DB. Apply with:
  `for f in supabase/migrations/20260714*.sql; do psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f "$f"; done`
- `bun run lint` reports 3 pre-existing errors in untouched UI components
  (OfflineIndicator, calculation-pane, CargoShipsBackground) — baseline debt,
  not introduced by this build.

## Hardening pass (2026-07-13, grant-readiness) — PASSED
- HMAC: 19-case bun:test suite on ErpAdapter.verifyWebhookSignature
  (malformed headers, algorithm confusion, tamper, replay semantics — replay
  defense is the webhook_logs idempotency index, now pinned by test).
- RLS: scripts/audit/rls-audit.sql — self-contained rolled-back probe suite.
  FINDING: live DB policies use is_company_member()/user_owns_claim(), NOT
  the JWT-app_metadata style in 20260711000003_optimize_rls.sql; new-table
  policies (JWT style) rely on the custom-access-token hook injecting
  app_metadata.company_id — verify that hook is registered in Supabase Auth
  before production. Audit passes under both styles.
- HITL: pending_human_reviews gates BOTH automations — clearinghouse sweep
  now proposes (never clears); settleClaim requires human_approved===true in
  the service layer (HUMAN_APPROVAL_REQUIRED → 428). BEHAVIOR CHANGE from
  the original Module 3 design, deliberate.
- Lineage: data_lineage is append-only (no user UPDATE/DELETE policies);
  verify.ts records geocode/ERA5/AIS provenance with sha256 payload hashes.
- Ops: structured JSON logs (trace_id/user_action_required/retry_strategy)
  in sync + webhook failure paths; /api/health/erp-status 503s on dead
  letters, errored integrations, or overdue pending backlog (the cron-died
  case).
- Verified: ups→RLS audit→downs→reset assertion in ONE rolled-back psql
  transaction against the hosted DB ("RLS AUDIT PASSED", "DOWN MIGRATIONS
  FULLY RESET STATE"). Lint now fully clean (3 pre-existing errors fixed via
  useSyncExternalStore / adjust-state-during-render patterns).

## Lessons
- L-001: `sof_events.document_id` was NOT NULL from init.sql — discovered
  before Module 5; cloning events across claims via the parent's document rows
  would create a cross-claim CASCADE path. Fixed by design (AD-005), not by
  workaround.
- L-002: `evidence_checks` is a replace-on-rerun snapshot (verify.ts deletes
  then inserts). Anything referencing check rows (voyage_alerts) must use
  ON DELETE SET NULL and carry a copy of the verdict summary in its own
  `detail` jsonb.
- L-003: Zod in this repo is v4 (`zod: ^4.0.2`) — `z.enum([...])`,
  `safeParse`, `.flatten()` on errors; route params are Promises in Next 16.
