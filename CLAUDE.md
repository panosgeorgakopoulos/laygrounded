# CLAUDE.md

## Commands

Bun is the runtime for scripts and tests (Node also works for `next dev`).

**Bun is also the package manager, and that is load-bearing for deployment.**
`bun.lock` is the lockfile of record; `package-lock.json` is gitignored. The
workspace dependency uses the `workspace:*` protocol, which npm's older
resolvers reject — and Vercel picks its package manager by sniffing lockfiles,
so a stray `package-lock.json` silently switches the build to npm and breaks it
(`Unsupported URL Type "workspace:"`). `vercel.json` pins
`installCommand: "bun install --frozen-lockfile"` so detection never decides.
Do not enable `ENABLE_EXPERIMENTAL_COREPACK` on Vercel: Corepack manages
npm/pnpm/yarn only, and would choke on the `packageManager: "bun@…"` field.

Scripts live in `package.json`. The invocations you can't guess from it:

```bash
bun test src/lib/                        # app unit tests (bun:test)
bun test packages/                       # engine package tests (@laygrounded/laytime-core)
bun test -t "<fixture name>"             # run a single fixture
bun run corpus -- --count 500 --seed 20260712 --no-pdf   # flags are not in the manifest
bun run corpus -- --engine-version 2 --no-pdf            # the rule-set-2 corpus
```

Regenerating or debugging the synthetic claim corpus: see the `synthetic-corpus` skill.

Migrations are applied with `mcp__supabase__apply_migration`, and ad-hoc queries with `mcp__supabase__execute_sql`. **Direct `psql` no longer works** — Supabase deprecated direct IPv4, so `db.<ref>.supabase.co` does not resolve and the pooler rejects the credential (`tenant or user not found`). The `DATABASE_URL` line in `.env` is retained for tooling that reads it, but is not a working ad-hoc path.

Full production stack (Next.js standalone in Alpine + Caddy reverse proxy on `http://localhost:81`):

```bash
docker compose build --no-cache && docker compose up -d
```

Environment: copy `.env.example` to `.env` — it documents every variable, required and optional. Note that weather verification needs no key (it uses the public Open-Meteo archive), and AIS and sanctions screening report "unavailable" when unconfigured rather than guessing.

## What this app is

LayGrounded is a multi-tenant SaaS for dry bulk shipping laytime/demurrage claims. The core pipeline: a PDF Statement of Facts is uploaded → vision extraction pulls timestamped events → a deterministic GENCON 94 rules engine computes an hour-by-hour laytime breakdown and demurrage/despatch totals.

The only two LLM call sites are SoF extraction and the drafter, both via `src/lib/ai/gemini.ts`. The app moved off the Anthropic SDK — everything goes through `@google/genai`.

Bun workspaces: the pure engine is published as `packages/laytime-core` (`@laygrounded/laytime-core`, Apache-2.0). Run `bun install` after checkout to link it, and clear `.next` after any dependency-graph change.

## The claim pipeline (the heart of the app)

1. **Upload & extraction** — `POST /api/claims/[claimId]/documents` validates the file by magic bytes (`file-type`), stores it in the Supabase `sofs` bucket under `{companyId}/{claimId}/`, then calls `uploadSofAndExtract` in `src/lib/ai/extraction.ts`. Extraction sends page images via `generateWithFallback` (`src/lib/ai/gemini.ts` — model chain `GEMINI_MODEL` → `GEMINI_FALLBACK_MODEL`, per-model backoff, falls back on 429/404/5xx but never on 400/401/403), validates the response with Zod (timestamps must carry a timezone; events must match `EventTypeEnum`), and inserts rows into `sof_events`.

2. **Rules engine** — `packages/laytime-core/src/gencon94.ts` is deliberately **pure TypeScript: no I/O, no AI, no Supabase**. It carries **two rule sets at once**, selected by `cpTerms.engine_version` (absent = 1) — see "Engine versioning" below. (`src/lib/laytime/gencon94.ts` is now a one-line re-export shim onto that package, as are `types.ts`, `diff.ts` and `sensitivity.ts` — edit the package, not the shim.) It takes `SofEventInput[]` + `CpTerms` and returns a `LaytimeResult` (breakdown rows + totals). It supports two CP forms via `cp_terms.cp_form`: **GENCON 94** (default; clause refs `GENCON94-*`) and **ASBATANKVOY** (tanker running-hours regime; refs `ASBA-II-*` — berthing cuts turn time short, weather never stops laytime, storm on demurrage bills half rate via `totals.demurrage_half_rate_hours`). It uses `decimal.js` for money and `date-fns-tz` for port-timezone-aware SHEX/SSHEX day exclusions. **Keep this purity: anything touching the DB belongs in `recompute-server.ts`.**

3. **Recompute bridge** — `src/lib/laytime/recompute-server.ts` loads a claim's confirmed events and `cp_terms` (validated with Zod) via the shared `loadClaimComputationInputs()`, runs the engine, and persists the result to `laytime_calculations`. Callers running outside a user request (demo seeder, claim rooms) must pass a service-role client explicitly, because the default cookie client has no user and RLS blocks everything.

4. **Clause flagging** — `src/lib/clause-flagging.ts` audits the event chronology for ambiguous triggers (NOR at anchorage, shifting before ALL_FAST, etc.) and writes `clause_flags` with severity + clause reference.

Shared domain types (event enums, `CpTerms`, `LaytimeResult`, `DEFAULT_CP_TERMS`) live in `src/lib/laytime/types.ts`; DB row shapes in `src/lib/database-types.ts`.

## Engine versioning (read before touching `gencon94.ts`)

A published calculation is evidence. A claim already served, notarised or agreed must keep reproducing the figures on the document, so the engine **versions** rules rather than replacing them.

- **Rule set 1** — as shipped through Phase 7. **Frozen.** Its 500-case conformance root, `bc9f24fdab910a1b`, is published in the verifier README and pinned by `packages/laytime-verify/src/conformance-roots.test.ts` and by the artifact build. If that number moves, the change is wrong — there is no "new v1 root".
- **Rule set 2** — corrects exactly one defect: under GENCON 94 + SHINC an agreed `EXCEPTED_PERIOD` was absorbed by the Sundays-included branch and never deducted. Root `261e3468d2246f30`. Verified surgical: of the v2 corpus's 500 cases, 44 diverge from v1 and all 44 are in the two SHINC archetypes; the other 456 are byte-identical.
- **`claims.engine_version` is the authority; `cp_terms.engine_version` is the transport.** `src/lib/laytime/engine-version.ts` is the one place that rule lives. **Absence means 1, and v1 is written as absence** — adding the key to a legacy claim's terms would change its `cp_terms` Merkle leaf and break every RFC-3161 anchor over it.
- New claims default to 2 (`DEFAULT_CP_TERMS` and the column default). Existing claims were backfilled to 1. `PATCH /api/claims/:id` accepts `engineVersion: 2` only — downgrading is not on offer, and an **agreed** claim refuses the change outright.
- A third rule set means a third branch, a third corpus and a third root. It does not mean widening rule set 2.

Module-level docs live next to the code: `src/lib/CLAUDE.md` (module map), `src/app/CLAUDE.md` (route conventions), and per-directory files under `src/lib/integrations`, `src/lib/compliance`, `src/lib/drafting`. Design ledger and lessons: `docs/build-memory/`.

## Auth and multi-tenancy

- Three Supabase client factories: `src/lib/supabase/client.ts` (browser), `createClient()` in `src/lib/supabase/server.ts` (cookie-based, subject to RLS), and `createServiceRoleClient()` (bypasses RLS — only for trusted server paths like seeding/admin).
- Tenancy is company-based: `companies` ↔ `company_members` (a user belongs to one company). `requireAuth()` in `src/lib/server-auth.ts` returns `{ userId, email, companyId, companyName }` and throws `UNAUTHORIZED` / `NO_COMPANY`.
- Every claim-scoped API route both relies on RLS **and** explicitly checks `claim.company_id === auth.companyId` — preserve this defense-in-depth pattern in new routes.
- `bootstrapUserCompany` in `src/lib/auth-helpers.ts` creates a company + admin membership on first sign-in.

## Conventions

- Next.js 16: route handler and page `params` is a Promise — always `await params`.
- CSS-module-per-component: `src/components/core/` holds base UI primitives (Button, Card, Input), `src/components/laygrounded/` the domain components. Follow the existing pattern.

## Database

Schema and RLS policies are in `supabase/migrations/`, applied in filename order. `supabase_setup.sql` at the root is a consolidated setup script that predates the newer migrations — **it is not the source of truth**. Judge what is actually applied from the Postgres catalog (`information_schema`, `pg_constraint`, `pg_proc.proacl`), never from a migration file or from `mcp__supabase__list_migrations`, which only sees migrations applied through that tool.

## Demo & seeding

- `POST /api/init-demo` (guarded by the `x-init-secret` header matching `INIT_DEMO_SECRET`) creates the demo user `demo2@laygrounded.com` and seeds demo claims via the service-role client.
- `POST /api/seed` seeds demo scenarios into the authenticated user's company, idempotently (skips if the company already has claims). Scenario data lives in `src/lib/seed-data.ts` / `src/lib/seed-claims.ts`.

## Notes

- **`REVOKE ... FROM public` does not lock a Postgres function on Supabase.** Default privileges grant EXECUTE to `anon` and `authenticated` *directly*, so a revoke from the PUBLIC pseudo-role is a no-op against them. Three matview refresh functions shipped world-executable this way. Every `SECURITY DEFINER` function must revoke from `public, anon, authenticated` by name; `src/lib/security/definer-grants.test.ts` fails the build otherwise. Verify with `pg_proc.proacl`, never by reading the migration.
- RLS on the older tables uses the `auth.uid()`-keyed helpers (`is_company_member()`, `user_owns_claim()`); some newer tables use an `auth.jwt() -> app_metadata -> company_id` pattern. **The `custom_access_token_hook` was never enabled, so that claim is always NULL** and those policies deny every end-user JWT by design — the routes concerned work only because they use the service-role client. Check which pattern a table uses before reading it with the cookie client.
- Migrations are applied with `mcp__supabase__apply_migration` (direct `psql` to `db.<ref>.supabase.co` no longer resolves — Supabase deprecated direct IPv4). `mcp__supabase__list_migrations` only lists migrations applied through that tool, so judge applied state from the catalog (`list_tables` / `pg_proc`), never from that list.
- Prefer verifying against an independent implementation (openssl for DER, redocly for OpenAPI, `python-stdnum` for IBANs, a second sweep for idempotence) — self-written tests tend to agree with self-written mistakes.
- **Do not run `bun run verify:build` expecting a wasm locally** — `javy` is absent by design, so the script skips the wasm and reports only the `.mjs` roots. The sealed artifact and the mjs≡wasm equivalence assertion are produced by `.github/workflows/verifier.yml`.
