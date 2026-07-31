# Phase 6 — wrap-up and handover

State as of `main` after "Merge: terminal granularity and efficiency dashboard",
plus the closing checklist (seed coherence, terminal input, this document).

Phase 6 shipped two commercial epics (**A — Green Shipping**, **B — Terminal
Inefficiency Attribution**), one architectural change (**the transactional
outbox**), and one X-factor (**Epic X1, Portfolio VaR**, documented in the
strategic roadmap). It also *deliberately deferred* one engine bug — read §5
before you touch the laytime engine.

---

## 1. Read this first — how to trust status claims

The rule from Phase 4 still holds and has kept paying:

- **Judge shipped-ness by grepping `src/`, not by reading a status line.** Six
  of ten "upcoming" epics turned out to be already built.
- **Judge applied-ness from the Postgres catalog** (`information_schema`,
  `pg_constraint`, `pg_proc.proacl`), never from `list_migrations` or the
  contents of a migration file. Three schema mismatches this phase were
  invisible to `tsc` and only surfaced from the catalog.
- **Migrations are applied with `mcp__supabase__apply_migration`.** Direct
  `psql` to the pooler now fails (`tenant/user … not found`) — the
  `DATABASE_URL` line in CLAUDE.md is stale for ad-hoc queries; use
  `mcp__supabase__execute_sql`.
- **Prefer an independent check to a self-written test.** Self-written tests
  agree with self-written mistakes.

---

## 2. What Phase 6 shipped

### Epic A — Green Shipping & Emissions Economics

| Piece | Where |
|---|---|
| EU-ETS chargeable share, phase-in, geographic scope | `src/lib/compliance/emissions.ts`, `eea-ports.ts` |
| BIMCO clause → liability allocation | `src/lib/compliance/ets-addendum.ts` |
| Server-side PDF addendum | `src/lib/compliance/ets-addendum-pdf.ts`, `POST /api/claims/[claimId]/ets-addendum` |
| Dynamic EUA price with live/mock provenance | `src/lib/market/carbon-price.ts` |
| Virtual Arrival / eco-speed off the live port queue | `src/lib/optimization/virtual-arrival.ts`, `POST /api/optimization/virtual-arrival` |
| Green Commercial Dashboard | `/claims/[claimId]/emissions` |
| Eco-Speed / JIT panel (mitigation paired with risk) | inside `/simulator/pre-arrival` |

**The commercially load-bearing part is the allocation, not the tonnage.** The
ETS obligation rests on the *shipping company* (Dir. 2003/87/EC Art. 3ga);
recovery from the charterer is contractual (Art. 3gc / the BIMCO clause). So the
addendum is a **tri-state × role** matrix, not a number with a label:

- `has_bimco_ets_clause` is `true | false | NULL` — and `NULL` means *"we have
  not read the charterparty"*, which is a different statement from "no clause".
- `claims.tenant_role` (`owner | charterer | trader`) decides the direction:
  `receivable` (owner with a clause), `payable` (charterer with a clause),
  `none`, or `undetermined`. **A trader is always `undetermined`** — they may be
  on either side of the same cargo.
- With no clause, an owner's cost is surfaced as **"Unrecovered Owner ETS Cost"**
  with a visual warning, never as a charterer receivable.

The role was originally inferred from a footnote. It is now an explicit column;
**do not reintroduce inference.**

### Epic B — Terminal Inefficiency Attribution

Pure modules in `src/lib/efficiency/`, dual benchmark, surfaced at
`/claims/[claimId]/efficiency` via `POST /api/claims/[claimId]/efficiency`.

- `cargo-rate.ts` — `parseCargoQuantity` (returns null when unreadable,
  `confident: false` when ambiguous), `computeWorkingTime` (clipped
  interruptions, clamped ≥ 0), `computeAchievedRate` on a net or gross basis.
- `attribution.ts` — measures the shortfall, gates any deduction behind an
  explicit `DeductionBasis`, and expresses a permitted deduction as
  `EXCEPTED_PERIOD` **events** via `deductionEvents()`.
- `market-server.ts` — cascades terminal → port, importing the k-anonymity
  floors (`MIN_VOYAGES = 5`, `MIN_COMPANIES = 3`) from `src/lib/intel/congestion.ts`
  rather than restating them, and **never falls back silently**.

**Two decisions that must survive the next session:**

1. **The headline is a priced negotiating position, NOT an automatic deduction.**
   A stipulated rate *derives* the laytime allowance (`allowed = cargo ÷ rate`);
   it is not a warranty of terminal performance. Slow working by the charterer's
   terminal is the charterer's risk, and demurrage is what prices it — deducting
   the shortfall would double-count the rate and reverse the parties' risk
   allocation. The UI says this next to the number, on purpose.
2. **Deductions are expressed as events, never as an engine change.** This is
   what keeps the WASM verifier and the 500-case conformance corpus intact.
   Conformance root `bc9f24fdab910a1b` was re-verified after Epic B.

### Architecture — the transactional outbox

`domain_events` + `emit_domain_event()`, migration `20260731000000`.

- **Trigger-only, by necessity.** supabase-js cannot hold one transaction across
  statements, so an application-level outbox could not be atomic with the write.
  `AFTER` triggers on `laytime_calculations`, `pre_arrival_risks` and
  `settlements` can.
- `ON CONFLICT (idempotency_key) DO NOTHING` — at-most-once per state change.
- `emit_domain_event()` is `SECURITY DEFINER` with EXECUTE revoked from
  `public, anon, authenticated` **by name** (verified: `proacl` is
  `postgres=X/postgres,service_role=X/postgres`). See §4.
- **Verified live**, not just in tests: a recompute emitted
  `claim.recomputed` carrying the totals. Note the id was 25 with the table
  otherwise empty — **the sequence has gaps** (rollbacks consume ids), so never
  treat `id` as a contiguous cursor.
- **Events outlive their aggregates.** No FK cascade to `claims`; a deleted claim
  must not erase the record that something happened.
- **Nothing consumes the outbox yet.** `pgmq`/`pg_cron`/`pg_net` are available on
  the project but not installed. The producer side is done; the consumer is the
  next decision.

### Epic B3 — micro-movement SoF verification

`src/lib/evidence/micro-movement.ts` infers cargo ops / shifting / at-berth from
existing `AisFix` data. **Sparse data is `inconclusive`; absent data is
`unavailable`** — the two are never collapsed. Duplicate timestamps are deduped
(a duplicate manufactured a phantom 1.1 km jump).

---

## 3. Schema changes (all applied and verified in the catalog)

| Migration | Change |
|---|---|
| `20260730000005_calculation_totals_completion.sql` | `laytime_calculations` + `time_on_demurrage_hours`, `time_saved_hours` (NOT NULL), `demurrage_half_rate_hours` (**nullable**) |
| `20260731000000_domain_events_outbox.sql` | `domain_events`, `emit_domain_event()`, 3 triggers |
| `20260731000001_evidence_micro_movement.sql` | widened `evidence_checks_check_type_check` to allow `motion_cargo_operations`, `motion_shifting`, `motion_at_berth` |
| `20260731000002_bimco_ets_clause.sql` | `claims.has_bimco_ets_clause boolean` (nullable = tri-state) |
| `20260731000003_tenant_role.sql` | `claims.tenant_role text` (`owner`/`charterer`/`trader`) |
| `20260731000004_terminal_name.sql` | `claims.terminal_name text` + partial index on `(lower(port), lower(terminal_name))` |

**`demurrage_half_rate_hours` is nullable and that is load-bearing.** Whole-object
verification is three fields, not two. `canonicalJson` *skips* `undefined` but
*serializes* `null`, so "the engine did not emit this key" (GENCON 94) and "the
engine emitted zero" are different documents. `src/lib/laytime/calculation-row.ts`
owns the single conditional spread that preserves this — do not inline it.

`terminal_name` and `tenant_role` are **nullable and not backfilled**. Inventing
a terminal for historical claims would key the benchmark on a fiction; the market
resolver cascades to port level and says so.

---

## 4. Environment variables

`.env.example` is now complete — every variable the code reads is documented
there, required and optional. It is the reference; this table is the map.

| Group | Variables |
|---|---|
| EUA carbon price | `ETS_EUA_PRICE_EUR` (override), `CARBON_PRICE_PROVIDER`, `CARBON_PRICE_URL`, `CARBON_PRICE_KEY`, `ALLOW_MOCK_CARBON_PRICE_IN_PRODUCTION` |
| AIS congestion | `AIS_CONGESTION_PROVIDER`, `DATALASTIC_API_KEY`, `ALLOW_MOCK_AIS_IN_PRODUCTION` |
| Bunkers | `BUNKER_PROVIDER_URL`, `BUNKER_PROVIDER_KEY` |
| Deployment URLs | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `ALLOWED_ORIGINS` |
| Public tools | `PUBLIC_TOOL_IP_SALT` |
| Settlement | `SETTLEMENT_PROVIDER_URL`, `SETTLEMENT_WEBHOOK_SECRET` |

**Resolution order is the same shape for both market adapters** — env override →
live provider → mock → static default — and **the mock is refused in production**
unless its `ALLOW_MOCK_*_IN_PRODUCTION` flag is set. Provenance (`live` vs
`mock`) is carried all the way to the UI. Weather verification still needs no
key (public Open-Meteo archive). Datalastic's base URL is a constant in
`ais-congestion.ts`, not an env var.

---

## 5. Deferred: the GENCON 94 + SHINC engine bug (Engine v2)

**Under GENCON 94 with a SHINC days basis, an agreed `EXCEPTED_PERIOD` is not
excluded from laytime** — the SHINC rule ("Sundays and holidays included")
absorbs it. All eight form × basis combinations were probed; **this one
combination is affected and every other applies the deduction correctly.**
ASBATANKVOY has its own branch and is unaffected.

**This is deliberately deferred to a dedicated Engine v2 epic**, because fixing
it changes engine output and therefore invalidates the sealed WASM artifact and
the 500-case conformance corpus in the same stroke. Mitigation is in place:
`attribution.ts` emits a hard, unmissable caveat naming the exact hours that will
**not** reduce the calculation.

When Engine v2 happens, it must land as one change: engine fix → corpus
regeneration → WASM rebuild → new conformance root → verifier artifacts.

---

## 6. Traps already paid for this phase

- **`.select()` must be a single string literal.** Concatenating it collapses the
  row type to `GenericStringError`.
- **DB CHECK constraints are invisible to `tsc`.** `evidence_checks.check_type`
  would have rejected every `motion_*` row at runtime.
- **Three schema mismatches `tsc` could not see:** `vessel_profiles` is really
  `vessel_analytics_profiles`; there are no `charterer`/`owner` columns (only
  `counterparty_name`).
- **jsonb does not preserve key order.** A replay comparison against
  `JSON.stringify` reports DIVERGED with zero leaf diffs — compare canonically
  (`verifyReplay()`).
- **Mixed sign conventions in ecospeed** published a carbon *saving* as −48.9 t.
  `asSaving()` now normalises it.
- **Geographic scope is not optional.** `buildCarbonCostOfDelay` initially billed
  EUR 1,969.35 of ETS on a Port Hedland call that has no EU exposure at all.
- **Browser automation drifts** (stale element refs, viewport resizing). Standing
  instruction from the user: **always trust server state over the automation
  tools** — confirm every path against the API or the DB.

---

## 7. Known gaps and open decisions

1. **The outbox has no consumer.** Producer verified; `pgmq`/`pg_cron`/`pg_net`
   are available but not installed. Deciding the consumer is the natural next
   architectural step.
2. **Market benchmark returns `INSUFFICIENT_DATA` on most lanes today**, which is
   correct — the k-anonymity floors are a privacy guarantee, not a tuning knob.
   It unlocks as terminal calls accumulate across companies. **Never lower the
   floors to make a demo work**; that is a deanonymisation.
3. **`tenant_role` / `has_bimco_ets_clause` / `terminal_name` have no backfill**,
   so existing claims read as "not recorded" until an operator sets them. All
   three now have UI inputs.
4. **No domain-line microservices.** This was proposed and rejected: the laytime
   engine is already a pure package, and splitting by domain line would buy
   distribution problems without buying isolation.
5. **VaR is not subadditive.** The portfolio P90 can exceed the sum of individual
   P90s, and that arises from zero-inflation and skew, not merely from
   dependence. Do not "fix" this.

---

## 8. Closing checklist state

- **Seed data is coherent.** `scripts/seed/build-demo-dataset.ts` now derives
  *tonnage* from the pinned `laytime_allowed_hours` and the rate
  (`coherentCargo()`), rather than recomputing hours — `laytime_allowed_hours` is
  the engine's pinned input and all 500 conformance expectations depend on it.
  All 18 scenarios satisfy `allowed = cargo ÷ rate`.
- **`terminal_name` is editable** on claim create (`/claims/new`,
  `POST /api/claims`) and edit (`PATCH /api/claims/[claimId]`), and is returned
  by `GET`. A blank string clears it to `NULL` — "not recorded" is a real state,
  and it is what makes the benchmark cascade to port level.
