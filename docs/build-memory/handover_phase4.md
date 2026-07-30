# Phase 4 — wrap-up and handover

Written 2026-07-30. Paste this into a fresh session together with
`CLAUDE.md`; it is meant to be read before touching anything.

`main` is at `07c48f4`, pushed to origin. **Baseline: 1448 app tests + 64
package tests, tsc / lint / build clean.** Every migration below is applied to
the hosted database and verified against the Postgres catalog, not against
`list_migrations`.

---

## 1. Read this first — how to trust status claims

Twice in this project a status document has been wrong in a way that cost real
time. `HANDOFF-phase-3.md` claimed "Phases 0–2 done" when 2.2, 2.3 and 2.4 had
never been written; a memory file claimed a migration was pending when it had
been live for weeks.

**Judge shipped-ness by grepping `src/`. Judge applied-ness from the catalog
(`pg_constraint`, `pg_indexes`, `information_schema.tables`).** Including for
this document.

---

## 2. What Phase 4 shipped

| Area | Modules | Surface |
|---|---|---|
| Voyage P&L | `src/lib/pnl/` | `/voyages`, `/api/voyage-pnl[/:id]`, `GET /api/v1/voyage-pnl/:id` |
| Public API | `src/lib/api/caller.ts` | `/api/v1/*` (renamed from `/api/v1/audit/*`) |
| Trade finance | `src/lib/finance/` | `/api/claims/:id/finance-grants[/:grantId]`, `GET /api/v1/claims/:id/verify`, `/api/v1/verifier/:artifact` |
| WWD resolver | `src/lib/weather/` | `/api/claims/:id/wwd-resolve`, `/api/settings/cargo-profiles` |
| Pre-fixture CP risk | `src/lib/prefixture/` | `/api/prefixture/analyze` |
| Public lead magnet | `src/lib/tools/` | `/tools/weather-checker`, `/api/tools/weather-checker[/lead\|/report]` |

New tables (all live, all RLS-enabled): `voyage_pnl`, `voyage_pnl_claims`,
`voyage_pnl_results`, `finance_grants`, `finance_grant_accesses`,
`cargo_weather_profiles`, `public_tool_usage`, `public_tool_leads`.

Migrations `20260730000000` … `20260730000004`.

---

## 3. Load-bearing invariants — break these and something goes quietly wrong

**A claim is one PORT CALL, not a voyage.** `claims.port` is a single column, so
a load/discharge voyage is two claims. The P&L therefore has its own root plus
a `voyage_pnl_claims` join. Modelling anything voyage-shaped on a claim makes
multi-port voyages unrepresentable.

**Dual auth: an `Authorization` header selects the API-key path outright.** A
bad key NEVER falls back to the session. "Try the key, else the session" is a
privilege-escalation bug — a browser sends its cookie on every fetch, so an
integrator testing a revoked key from a logged-in tab would silently succeed
with the *user's* privileges. `src/lib/api/caller.ts`.

**There is no `keys:*` scope and there must never be.** A key that can mint keys
turns one leak into self-renewing access and revocation stops being a remedy.
Key management, tenant onboarding and the global sweeps are session-only.

**Trade-finance grants: the claim comes FROM THE GRANT.** The `claimId` in
`/v1/claims/:id/verify` is an assertion checked for equality, never a selector.
That is the whole IDOR defence. Grants (`lgf_`) and API keys (`lga_`) fail each
other's shape checks by design.

**The WWD resolver emits `WEATHER_DELAY` pairs, NOT `EXCEPTED_PERIOD`.** An
excepted period is excluded under *every* days basis including SHINC, but
weather is only excepted under a weather-working basis. Emitting excepted
periods would silently override the charterparty. This is why the engine needed
no change and the 500-case corpus stayed valid.

**Machine-derived events land `suggested`, never `accepted`.** Applies to API
pushes and resolver output alike. Confirmed events are legal evidence.

**A missing weather hour is UNKNOWN, never "no weather".** Gaps are reported and
they *split* a stoppage rather than bridging it.

**`NULL` threshold = insensitive**, distinct from `0` and from omitted. Steel
does not care about rain; encoding that as `999` would be a lie that works.

**Public tools may touch the pure resolver, the public archive, and GLOBAL
cargo profiles only** — never a claim, company, calculation or tenant override.
The boundary lives in `src/lib/tools/public-tools.ts` so it is visible in the
import graph.

---

## 4. Traps already paid for

- **`ON CONFLICT` cannot infer a PARTIAL unique index.** Cost two debugging
  rounds on `cargo_weather_profiles`. Fixed with a plain index alongside.
- **RLS with `auth.jwt() -> app_metadata -> company_id` is ALWAYS NULL here**
  (`custom_access_token_hook` was never enabled). It silently denied every
  end-user write to `api_keys` / `api_webhooks`, so *nobody could create an API
  key* while the API itself worked. New tables use `is_company_member()`.
- **`laytime_calculations` persists 5 of the engine's 7 totals** —
  `time_on_demurrage_hours` and `time_saved_hours` are absent. Shipping a
  partial object as a whole `LaytimeResult` makes `verifyClaim`'s comparison
  fail on a *good* claim. Persisting the two missing columns is the obvious next
  increment and would let the bank package do whole-object verification.
- **`geocodePort` fails on "City, CC"** — the Open-Meteo geocoder does not parse
  a trailing country. Fixed with a bare-city fallback; this had silently
  disabled weather verification for most real ports.
- **`round2` must normalise `-0`** or a balance sheet renders "-0".
- **Optimistic UI must roll back to the last SERVER-CONFIRMED value**, not to
  the initial prop. Hit twice (voyage P&L sheet, cargo settings).
- **`apiError()` now maps `ApiAuthError`** to 401/403/429; it previously
  flattened scope failures into opaque 500s that integrators would retry.
- Clear `.next` after moving route files — stale generated types produce
  phantom tsc errors.

---

## 5. Known gaps and open decisions

**Engineering, ready to pick up:**
1. **Persist the two missing calculation totals** (see traps). Unblocks
   whole-object WASM verification for trade finance. Guarded by the 500-case
   corpus, so it deserves its own change.
2. **Locale decimal input.** Threshold fields render `0,05` under a comma
   locale. Round-trips correctly in testing but is untested on a genuinely
   comma-locale browser — money-adjacent, so worth closing.
3. **The `.wasm` verifier path is unverified locally** (`wasmtime` not
   installed). The `.mjs` twin is verified end to end and CI asserts they agree.
4. **BOD/BOR has no UI**; charterer-perspective P&L is implemented and tested
   but unexercised.
5. **Oracle matview is nearly empty** (3 ports, 1 voyage each), so every
   pre-fixture pricing path returns `INSUFFICIENT_DATA` against real data. Data
   maturity, not a code gap.

**Product decisions deliberately NOT taken in code:**
- **Cross-tenant counterparty risk graph.** Scoped to own-book only. A score
  keyed by a named company publishes a commercial judgement about a third party
  with no account and no way to contest it; k-anonymity does not fix that,
  because the subject *is* the identified entity. See the header of
  `src/lib/intel/counterparty.ts`.
- **Cross-tenant settlement expectations** are built and gated behind
  `PUBLIC_MARKET_EXPECTATIONS=1` — keyed by claim shape, not by party, with the
  congestion index's own k-anonymity floors imported rather than restated.
- **Grant issuance stays session-only**, pending a Stage 3+ decision on whether
  an ERP may hand a bank access unattended.

**Environment:** `GEMINI_API_KEY` was at quota on 2026-07-30 (429 on both
models), so every LLM path — SoF extraction, the drafter, protective notices,
SoF chases — is unexercisable until refreshed. Every non-LLM half was verified
against the live book instead.

---

## 6. Working conventions that produced this

- Pure logic in `src/lib/**` with table-driven tests; DB access in `*-server.ts`
  or the route. The engine stays pure — no I/O, no clock, no randomness.
- **Never fabricate.** If data cannot support a figure, build the honest shape
  and name the gap: `unavailable` verdicts, `INSUFFICIENT_DATA`, reported gaps,
  mandatory `source_label`.
- **Verify against an independent implementation.** Self-written tests agree
  with self-written mistakes.
- **Drive the real UI.** Most of the bugs in §4 were invisible to unit tests and
  obvious in a browser or against the live database.
- Clean up live-DB fixtures and say what was left behind.
