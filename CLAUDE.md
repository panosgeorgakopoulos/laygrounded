# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Bun is the runtime for scripts and tests (Node also works for `next dev`).

```bash
bun install                              # install dependencies
bun run dev                              # dev server on :3000 (output tees to dev.log)
bun run build                            # next build + assemble standalone output
bun run start                            # run the standalone production server via bun
bun run lint                             # eslint .
bun test src/lib/                        # run all unit tests (bun:test)
```

Test suites (all table-driven, pure-function tests): `src/lib/laytime/gencon94.test.ts` (engine fixtures), `src/lib/laytime/diff.test.ts` (negotiation differ), `src/lib/time-bar.test.ts`, and `src/lib/laytime/regression.test.ts` (500-case synthetic corpus, see below). Run a single fixture with `bun test -t "<fixture name>"`.

### Synthetic claim corpus (engine regression safety net)

`bun run corpus` (= `bun scripts/synthetic-claims/generate.ts [--count 500] [--seed 20260712] [--no-pdf]`) regenerates `synthetic-corpus/`: 500 deterministic voyage cases across ~24 edge-case archetypes (weather exclusions, SHEX/SSHEX/UU weekends, WIBON/WIPON shifting, port strikes, bunker stoppages, all four ASBATANKVOY behaviors, deferred commencement, open-ended interruptions, error paths, time-bar bands), each as a ground-truth JSON (`cases/`) plus a realistic SoF PDF (`sofs/`, future extraction-benchmark fixtures). A case is only emitted if the engine result passes engine-independent **invariants** (`scripts/synthetic-claims/invariants.ts`), the archetype's **feature assertion** proves the edge case manifested, and a second run reproduces the output. Same seed → byte-identical case JSONs.

`regression.test.ts` replays every case against the current engine (~0.15 s for all 500). Red tests after an engine change mean behavior diverged from the blessed goldens: if intentional, regenerate the corpus and review the diff; if not, it's a caught regression. The invariant re-check separates "numbers changed" from "numbers are impossible".

Migrations can be applied directly with `psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f supabase/migrations/<file>.sql` (`DATABASE_URL` in `.env` points at the hosted Supabase Postgres).

Full production stack (Next.js standalone in Alpine + Caddy reverse proxy on `http://localhost:81`):

```bash
docker compose build --no-cache && docker compose up -d
```

Environment: copy `.env.example` to `.env`. Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `INIT_DEMO_SECRET`. Optional: `CLAUDE_MODEL_ID` / `CLAUDE_FALLBACK_MODEL_ID` (extraction models), `ALLOWED_ORIGINS` (CORS allowlist), `AIS_PROVIDER_URL` / `AIS_PROVIDER_KEY` (AIS position verification; weather verification needs no key — it uses the public Open-Meteo archive).

## What this app is

LayGrounded is a multi-tenant SaaS for dry bulk shipping laytime/demurrage claims. The core pipeline: a PDF Statement of Facts is uploaded → Claude vision extracts timestamped events → a deterministic GENCON 94 rules engine computes an hour-by-hour laytime breakdown and demurrage/despatch totals.

Stack: Next.js 16 App Router (React Server Components), TypeScript strict, Supabase (Postgres + Auth + Storage), Anthropic SDK, CSS modules + Tailwind. Path alias `@/*` → `src/*`.

## Architecture

### The claim pipeline (the heart of the app)

1. **Upload & extraction** — `POST /api/claims/[claimId]/documents` validates the file by magic bytes (`file-type`), stores it in the Supabase `sofs` bucket under `{companyId}/{claimId}/`, then calls `uploadSofAndExtract` in `src/lib/ai/extraction.ts`. Extraction sends page images to Claude (model from `CLAUDE_MODEL_ID`, fallback model on failure), validates the response with Zod (timestamps must carry a timezone; events must match `EventTypeEnum`), retries with jittered exponential backoff via `withRetry`, and inserts rows into `sof_events`.

2. **Rules engine** — `src/lib/laytime/gencon94.ts` is deliberately **pure TypeScript: no I/O, no AI, no Supabase**. It takes `SofEventInput[]` + `CpTerms` and returns a `LaytimeResult` (breakdown rows + totals). It supports two CP forms via `cp_terms.cp_form`: **GENCON 94** (default; clause refs `GENCON94-*`) and **ASBATANKVOY** (tanker running-hours regime; refs `ASBA-II-*` — berthing cuts turn time short, weather never stops laytime, storm on demurrage bills half rate via `totals.demurrage_half_rate_hours`). It uses `decimal.js` for money and `date-fns-tz` for port-timezone-aware SHEX/SSHEX day exclusions. Keep this purity: anything touching the DB belongs in `recompute-server.ts`.

3. **Recompute bridge** — `src/lib/laytime/recompute-server.ts` loads a claim's confirmed events and `cp_terms` (validated with Zod) via the shared `loadClaimComputationInputs()`, runs the engine, and persists the result to `laytime_calculations`. Callers running outside a user request (demo seeder, claim rooms) must pass a service-role client explicitly, because the default cookie client has no user and RLS blocks everything.

4. **Clause flagging** — `src/lib/clause-flagging.ts` audits the event chronology for ambiguous triggers (NOR at anchorage, shifting before ALL_FAST, etc.) and writes `clause_flags` with severity + clause reference.

Shared domain types (event enums, `CpTerms`, `LaytimeResult`, `DEFAULT_CP_TERMS`) live in `src/lib/laytime/types.ts`; DB row shapes in `src/lib/database-types.ts`.

### Claim intelligence layer (built on the engine's purity)

- **Scenario diffing** — `src/lib/laytime/diff.ts` (pure): applies `event_proposals` to a baseline event set, runs the engine on both versions, returns per-side results plus a money delta (`net = demurrage − despatch`, owner's perspective). Powers claim-room redlines and the owner's proposal review.
- **Claim rooms** — `src/lib/rooms.ts`: counterparties get token-based guest access (no Supabase session). `resolveShare()` validates the unguessable token (revocation + expiry) and `loadRoomView()` assembles the shared negotiation state. All room reads/writes go through the **service-role client after token validation** — the public routes (`/api/rooms/[token]`, `/api/rooms/[token]/proposals`, page `/rooms/[token]`) never accept a claim id from the guest. Owner side: `/api/claims/[claimId]/share` (create/list/revoke links) and `/api/claims/[claimId]/proposals[/proposalId]` (review; accepting applies the amendment to `sof_events` and recomputes).
- **Evidence verification** — `src/lib/evidence/`: `verify.ts` cross-references claimed `WEATHER_DELAY` windows against the Open-Meteo ERA5 archive (`weather.ts`; geocodes the port once and caches `port_lat/lon` on the claim) and NOR position against AIS (`ais.ts`, provider-pluggable; reports `unavailable` when unconfigured — never guesses). Verdicts (`corroborated`/`contradicted`/`inconclusive`/`unavailable`) persist to `evidence_checks` as a replace-on-rerun snapshot. Route: `/api/claims/[claimId]/verify-evidence`.
- **Time bars** — `src/lib/time-bar.ts` (pure): deadline = latest confirmed completion event + `claims.time_bar_days` (default 90), with a claim-pack completeness checklist. Computed in the claim GET route and as a dashboard column.
- **Clause P&L** — `src/lib/analytics/clause-pnl.ts`: counterfactual engine runs per claim (days basis vs SHINC, turn time vs none, weather/shifting removed) aggregated across the company book; rendered at `/analytics`. Settlement recording (`claims.settled_amount/settled_at`, PATCHed via the claim route) feeds its recovery-rate KPI.
- **Workspace UI** — `src/components/laygrounded/claim-intel-panel.tsx` is the collapsible strip in the workspace that surfaces all of the above (time bar, evidence, share links, proposal accept/reject, settlement).

### Auth and multi-tenancy

- Three Supabase client factories: `src/lib/supabase/client.ts` (browser), `createClient()` in `src/lib/supabase/server.ts` (cookie-based, subject to RLS), and `createServiceRoleClient()` (bypasses RLS — only for trusted server paths like seeding/admin).
- Tenancy is company-based: `companies` ↔ `company_members` (a user belongs to one company). `requireAuth()` in `src/lib/server-auth.ts` returns `{ userId, email, companyId, companyName }` and throws `UNAUTHORIZED` / `NO_COMPANY`.
- Every claim-scoped API route both relies on RLS **and** explicitly checks `claim.company_id === auth.companyId` — preserve this defense-in-depth pattern in new routes.
- `bootstrapUserCompany` in `src/lib/auth-helpers.ts` creates a company + admin membership on first sign-in.

### API route conventions

- Routes live under `src/app/api/`. Business errors are thrown as sentinel string messages (`"CLAIM_NOT_FOUND"`, `"INVALID_CP_TERMS"`, …) and converted by `apiError()` in `src/lib/api-errors.ts`, which maps known sentinels to their HTTP status and turns anything unknown into a logged, opaque 500. Add new sentinels to `DEFAULT_KNOWN` or pass them via `extraKnown`.
- Next.js 16: route handler `params` is a Promise — always `await params`.
- `src/middleware.ts` applies per-instance in-memory rate limiting to `/api`, a deny-by-default CORS allowlist (`ALLOWED_ORIGINS`), and redirects users with a Supabase auth cookie from `/`, `/sign-in`, `/sign-up` to `/claims`.

### Database

Tables: `companies`, `company_members`, `claims` (holds `cp_terms` JSON plus `time_bar_days`, `settled_amount/settled_at`, cached `port_lat/lon`), `documents`, `sof_events`, `clause_flags`, `laytime_calculations`, `claim_shares` (room tokens), `event_proposals` (counterparty amendments), `evidence_checks`. Schema and RLS policies are in `supabase/migrations/` (initial schema in `00000000000000_init.sql`; RLS is JWT-`app_metadata` based per `20260711000003_optimize_rls.sql`; the intelligence-layer tables are in `20260712000000_elevation_features.sql`). `supabase_setup.sql` at the root is a consolidated setup script that predates the newest migration.

### Demo & seeding

- `POST /api/init-demo` (guarded by the `x-init-secret` header matching `INIT_DEMO_SECRET`) creates the demo user `demo2@laygrounded.com` and seeds demo claims via the service-role client.
- `POST /api/seed` seeds demo scenarios into the authenticated user's company, idempotently (skips if the company already has claims). Scenario data lives in `src/lib/seed-data.ts` / `src/lib/seed-claims.ts`.

### Frontend layout

- `src/app/(authenticated)/` — claims dashboard (server-rendered), claim workspace, clause P&L analytics, settings; guarded client-side by the layout plus middleware redirects.
- `src/app/rooms/[token]/` — the public claim room (server-rendered, token-authenticated, `robots noindex`); intentionally outside the authenticated group and the middleware matcher.
- Public marketing pages at the root (`page.tsx`, `features`, `pricing`, `about`, `contact`, `legal`).
- `src/components/core/` — base UI primitives (Button, Card, Input) with CSS modules; `src/components/laygrounded/` — domain components (document viewer, event timeline, calculation pane, nav/hero/footer). Follow the existing CSS-module-per-component pattern.

## Notes

- Root-level `test_*.ts`, `fix_*.py`, `verify_demo.ts`, `call_init.ts`, `refactor.py` are one-off dev scratch scripts, not part of the app.
- `bun run dev` pipes through `tee dev.log` — check `dev.log` for recent server output when debugging.
