# Phase 7 — wrap-up and handover

State as of `main` after the Epic C merges. Phase 7 was **Epic C: Autonomous
Ops & Enterprise Integrations**, in three parts: the ERP-agnostic sync layer,
hinterland supply-chain webhooks, and settlement payload generation.

Read this with `handover_phase6.md` (still current for the engine, ETS and
terminal-attribution work) and `strategic_roadmap_and_architecture.md`.

---

## 1. Read this first — the rules that keep paying

Unchanged from Phase 6, and all three earned their keep again this phase:

- **Judge shipped-ness by grepping `src/`, not by reading a status line.**
  Phase 7's directive asked for an "ERP adapter interface" and a
  "`webhook_subscriptions` registry". **Both already existed** — `ErpAdapter` +
  `sync.ts` from Phase 4, and `api_webhooks` from the Audit Trail API. Building
  either again would have been the most expensive mistake available.
- **Judge applied-ness from the catalog**, never from `list_migrations`. Every
  migration below was verified with `pg_constraint` / `pg_proc.proacl` /
  `pg_policies` after applying.
- **Prefer an independent check to a self-written test.** Two live-database
  probes this phase caught things unit tests could not (see §5).

---

## 2. What Phase 7 shipped

### Part 1 — the ERP-agnostic sync layer

| Piece | Where |
|---|---|
| Danaos adapter (SOAP 1.1/XML, WS-Security) | `src/lib/integrations/danaos.ts` |
| Fortune adapter (JSON/REST, `modifiedSince`) | `src/lib/integrations/fortune.ts` |
| Ulysses adapter (JSON/REST, entity envelope) | `src/lib/integrations/ulysses.ts` |
| Hardened XML reader/writer | `src/lib/integrations/xml.ts` |
| Deterministic mock corpus | `src/lib/integrations/fixtures.ts` |
| Shared field normalizers | `src/lib/integrations/normalize.ts` |
| Provider registry (single source of truth) | `src/lib/integrations/registry.ts` |
| First outbox consumer | `src/lib/events/erp-dispatch.ts` |

Details in `src/lib/integrations/CLAUDE.md`. The load-bearing decisions:

- **Mock is never inferred.** An integration with no credentials is `live` and
  fails loudly; `config.mode = "mock"` is the only way in, refused in production
  without `ALLOW_MOCK_ERP_IN_PRODUCTION=1`, on pushes as well as reads.
- **Three of four mappings are UNVERIFIED.** Danaos, Fortune and Ulysses publish
  no API specs. `mappingVerifiedAgainstVendorDocs` carries this to the UI.
  **Note what that flag does and does not say**: it records whether the mapping
  follows *published vendor documentation*. **No adapter has been exercised
  against a running ERP**, Veson included. Do not let it be read as "live-tested".
- **`xml.ts` refuses rather than mitigates**: `<!DOCTYPE` and `<!ENTITY` are
  rejected outright (XXE, billion-laughs), input size and nesting depth bounded,
  undeclared entities left literal.
- **Schedules are plans.** `pull_schedules` lands in `erp_vessel_schedules` and
  is never promoted to a claim.

### Part 3 — settlement payload generation

| Piece | Where |
|---|---|
| Payload generation (pure) | `src/lib/settlement/escrow.ts` |
| DB bridge + persistence | `src/lib/settlement/escrow-server.ts` |
| Third outbox consumer | `src/lib/events/settlement-dispatch.ts` |
| Agreement transition | `POST /api/claims/[claimId]/agree` |

Details in `src/lib/settlement/CLAUDE.md`. Four rules decide what goes in the
number, and each exists because the alternative moves money nobody agreed to:
only undisputed agreed claims settle; a terminal shortfall is not a deduction
without a `DeductionBasis` (the Phase 6 decision, unchanged); carbon settles
only when its allocation is determined; **currencies are never netted** —
components in different currencies become separate legs, because inventing an
FX rate moves real money on a fabricated number.

**We deliberately do not compute the EIP-712 keccak digest.** No audited keccak
implementation exists in this project, and hand-rolling one to authorise money
movement is a bad trade against handing the signer the typed-data object it
already knows how to hash. `digestOf()` is SHA-256 over our canonical JSON — it
pins OUR document, and is **not** the EIP-712 signing hash.

**Terminal and carbon are caller-supplied, not loaded**, because neither is
persisted (see §5). The ETS figure depends on a live EUA price, and a mock price
reaching a payment instruction is what the provenance discipline exists to stop.

### Part 2 — hinterland supply-chain webhooks

| Piece | Where |
|---|---|
| HMAC signing, v1 + timestamped v2 | `src/lib/webhooks/signing.ts` |
| Trigger decisions + payloads (pure) | `src/lib/webhooks/hinterland.ts` |
| Delivery queue with retries | `src/lib/webhooks/delivery.ts` |
| Second outbox consumer | `src/lib/events/webhook-dispatch.ts` |

Details in `src/lib/webhooks/CLAUDE.md`. The load-bearing decisions:

- **One registry.** Extended `api_webhooks` rather than adding
  `webhook_subscriptions`; two registries would mean two secrets and a split
  delivery ledger for one customer.
- **The trigger is a P90, and a missing P90 is silence.** Never the mean.
- **Retries did not previously exist.** Delivery was one attempt with
  `attempts` hard-coded to 1.

---

## 3. The architectural change that matters most

**`domain_events.processed_at` is a single flag and only ever supported ONE
consumer.** Adding the hinterland consumer alongside `erp-dispatch` would have
meant whichever swept first marked the event processed and the other never saw
it — **ERP pushes would have stopped silently, with no error anywhere**.

`domain_event_consumptions (event_id, consumer, processed_at, attempts,
last_error)` fixes it, read through the `unprocessed_domain_events` RPC.

If you add a third consumer:

1. Add its name to `CONSUMERS` in `src/lib/events/outbox.ts`. **The names are
   persisted and are effectively schema** — renaming one resets its cursor and
   replays the entire log through it.
2. Use `readUnprocessedFor` / `markProcessedBy` / `markFailedBy`. The
   single-flag originals (`readUnprocessed` / `markProcessed` / `markFailed`)
   remain only for the audit read; do not gate on them.
3. Each consumer retries and dead-letters independently by design.

The backfill inserted `('erp', processed_at)` rows for every already-processed
event. Without it the new model would have considered the whole history
outstanding and re-dispatched it.

---

## 4. Schema changes (all applied and verified in the catalog)

| Migration | Change |
|---|---|
| `20260801000000_erp_providers_and_schedules.sql` | widened `integrations_provider_check` (DANAOS/FORTUNE/ULYSSES) and `sync_jobs_kind_check` (`push_pnl`, `pull_schedules`); added `erp_vessel_schedules` |
| `20260801000001_hinterland_webhooks.sql` | `domain_event_consumptions` + `unprocessed_domain_events()`; `api_webhook_deliveries.next_attempt_at` + `'dead'` status; `api_webhooks.config`; `pre_arrival_risks.p90_waiting_hours` / `p90_stoppage_hours` |
| `20260801000002_settlement_agreement.sql` | `claims.agreed_at` / `agreed_by` / `agreed_calculation_id`; `settlement_payloads`; `emit_domain_event()` gains an `agreed_claim` branch; trigger emitting `claim.settlement_ready` |

**`p90_waiting_hours` is a denormalized COLUMN, not a field on
`RiskDistribution`, and that is load-bearing.** `verifyReplay()` compares the
whole stored distribution against a fresh recomputation over the **union** of
both objects' keys, so any new key on `RiskDistribution` would make every
historical assessment fail replay — and byte-identical replay is the property
the parametric-insurance and audit stories rest on. `simulate()` now returns
`outcomes` (on `SimulationResult`, *not* on `distribution`) so the caller can
compute time percentiles without touching the sealed document.

Both columns are **nullable and not backfilled**. NULL means "not recorded" and
the hinterland consumer skips those rows rather than inventing a figure.

---

## 5. Traps already paid for this phase

- **Deterministic mock external refs must mix the seed in.** Refs are the upsert
  key `(company_id, external_source, external_ref)` and `external_source` is the
  **provider**, so two mock DANAOS integrations in one company emitted identical
  refs and overwrote each other's claims every sweep. Caught by a test that ran
  two integrations of the same provider — not by any single-integration test.
- **`apiError` matches sentinels against the WHOLE message string.** A thrown
  `"UNSUPPORTED_JOB_KIND: ULYSSES does not support 'push_pnl'"` does not match
  the key `UNSUPPORTED_JOB_KIND` and falls through to an opaque 500. Either throw
  the bare sentinel or return `NextResponse.json` directly with the detail.
- **A SOAP Fault arrives with HTTP 500**, which the shared transport treats as
  retriable — a permanent fault burns four attempts before failing. Faults
  returned with HTTP 200 are detected explicitly.
- **`ON CONFLICT DO UPDATE` cannot touch the same row twice in one command.**
  Two CTEs upserting the same key fail with 21000; the app issues sequential
  statements, so this was a verification-script artefact, not a schema fault.
- **`RAISE NOTICE` output is invisible through `execute_sql`.** A `DO` block that
  "passes" proves only that nothing raised. Return a result set instead.
- **Three more schema mismatches `tsc` could not see**, caught by checking the
  catalog before writing the loader: `clause_flags` has no `flag_type`,
  `metadata` or `claim_id` (it is keyed on `event_id`); `drafts` has no
  `metadata` column and its `kind` CHECK has no `ets_addendum`. **Neither the
  terminal shortfall nor the ETS allocation is persisted anywhere** — both are
  computed on demand, which is why `escrow-server.ts` takes them as arguments.
- **Despatch must be signed NEGATIVE** in the settlement ledger. Every component
  is signed from the owner's perspective; a positive despatch made the charterer
  the debtor on a sum the owner owes — the payment running backwards. Caught by
  a test, not by review.
- **A per-PROVIDER mock allowlist does not work.** `"danaos"` would cover a live
  partner's Danaos integration, which is the exact leak the allowlist prevents.
  Only identity-scoped entries (integration UUID, or `company:<uuid>`) do.

---

## 6. Environment

**`ALLOWED_MOCK_INTEGRATIONS`** (default empty) replaced the global
`ALLOW_MOCK_ERP_IN_PRODUCTION`. Entries are integration UUIDs, or
`company:<uuid>` for a whole demo tenant. Unset means **nothing** may serve
fixtures in production; the refusal message names the id to add.

Deliberately **not** a provider list: `"danaos"` would also cover a live design
partner's Danaos integration, which is precisely the leak being prevented.

Cron cadence: `POST /api/events/dispatch` every ~5 min (dispatches all three
consumers, then drains both delivery queues), alongside the existing
`POST /api/integrations/run-sync`.

---

## 7. Known gaps and open decisions

1. **No adapter has met a live ERP.** The mappings are plausible, tenant-
   overridable and untested against a real deployment. First contact should be a
   `integrations.config` change, not a code push — that is what the design buys.
2. **The demo needs an allowlist entry.** Create the mock integration, then put
   its id in `ALLOWED_MOCK_INTEGRATIONS` (locally and on Vercel). Until then a
   production-mode mock pull is refused, by design.
3. **`p90_waiting_hours` is not backfilled**, so hinterland delay notifications
   only fire for assessments made after 2026-08-01. This is correct, and it means
   a demo needs a freshly-run assessment.
4. **Ulysses' revision cursor is not honoured.** Its native cursor is a monotonic
   revision integer (no clock skew, no lost same-millisecond updates);
   `ErpAdapter` passes a timestamp because that is what `integrations.last_sync_at`
   stores. Supporting it properly needs a `last_cursor` column. Deliberately not
   faked by stuffing a revision into a timestamp field.
5. **Webhook v1 signatures are still sent.** Removing them is a breaking change
   for existing consumers and needs a deprecation window, not a refactor.
6. **The GENCON 94 + SHINC engine bug is still deferred** (Phase 6 §5). Engine v2
   must land as one change: engine fix → corpus regeneration → WASM rebuild → new
   conformance root → verifier artifacts.
7. **Cross-tenant matviews remain data-starved.** Unchanged from Phase 6; only
   tenants shipping real claims fix it.
8. **No bank or wallet details are stored.** `escrow-server.ts` emits parties by
   name with null IBAN/BIC/wallet, reported through `missingForBank` /
   `missingForChain`. A counterparty banking table is the next step before any
   payload is actionable end to end.
9. **Nothing consumes `settlement_payloads`.** Generation is done; execution
   (bank submission or contract call) is deliberately a separate decision, and
   carries custody/KYC questions the roadmap flagged under C2.

---

## 8. Verification state

- `tsc --noEmit` clean; `eslint src/lib src/app` clean.
- **2111 tests pass** (0 fail) across 96 files, including 129 integration tests,
  64 webhook tests, 42 settlement-payload tests and 17 mock-policy tests.
- Production build clean; `/api/events/dispatch` registered.
- **Live-database checks**, not just unit tests:
  - new provider INSERT accepted; `ON CONFLICT (integration_id, external_ref)`
    proven to update in place (two upserts → one row);
  - `unprocessed_domain_events` proven independent per consumer: acking for
    `erp` dropped it to 0 outstanding while `hinterland` still saw 1;
  - `unprocessed_domain_events` and `emit_domain_event` ACLs confirmed
    `postgres=X/postgres, service_role=X/postgres` — no anon/authenticated;
  - the agreement trigger verified end to end: setting `agreed_at` emitted
    exactly one `claim.settlement_ready`, and a re-stamp plus an unrelated edit
    emitted no second event.
- All live fixtures deleted; leftover counts verified zero.
