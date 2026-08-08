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

Environment: copy `.env.example` to `.env` — it documents every variable, required and optional. Note that weather verification needs no key (it uses the public Open-Meteo archive), and AIS and sanctions screening report "unavailable" when unconfigured rather than guessing.

## What this app is

LayGrounded is a multi-tenant SaaS for dry bulk shipping laytime/demurrage claims. The core pipeline: a PDF Statement of Facts is uploaded → vision extraction pulls timestamped events → a deterministic GENCON 94 rules engine computes an hour-by-hour laytime breakdown and demurrage/despatch totals.

The only two LLM call sites are SoF extraction and the drafter, both via `src/lib/ai/gemini.ts`. The app moved off the Anthropic SDK — everything goes through `@google/genai`.

Bun workspaces: the pure engine is published as `packages/laytime-core` (`@laygrounded/laytime-core`, Apache-2.0). Run `bun install` after checkout to link it, and clear `.next` after any dependency-graph change.

## The claim pipeline (the heart of the app)

A PDF Statement of Facts is uploaded → vision extraction pulls timestamped events → the rules engine computes the hour-by-hour breakdown and demurrage/despatch totals → the recompute bridge persists them → clause flagging audits the chronology. **Per-step detail lives in `src/lib/CLAUDE.md`.**

The engine supports two CP forms via `cp_terms.cp_form`: **GENCON 94** (default; clause refs `GENCON94-*`) and **ASBATANKVOY** (tanker running-hours regime; refs `ASBA-II-*`).

Two rules bind code outside `src/lib`, so they stay here:

- `packages/laytime-core/src/gencon94.ts` is deliberately **pure TypeScript: no I/O, no AI, no Supabase. Keep this purity: anything touching the DB belongs in `recompute-server.ts`.** `src/lib/laytime/gencon94.ts` is a one-line re-export shim onto that package, as are `types.ts`, `diff.ts` and `sensitivity.ts` — edit the package, not the shim.
- Callers of the recompute bridge running outside a user request (demo seeder, claim rooms) must pass a service-role client explicitly, because the default cookie client has no user and RLS blocks everything.

## Engine versioning (read before touching `gencon94.ts`)

A published calculation is evidence. A claim already served, notarised or agreed must keep reproducing the figures on the document, so the engine **versions** rules rather than replacing them.

- **Rule set 1** — as shipped through Phase 7. **Frozen.** Its 500-case conformance root, `bc9f24fdab910a1b`, is published in the verifier README and pinned by `packages/laytime-verify/src/conformance-roots.test.ts` and by the artifact build. If that number moves, the change is wrong — there is no "new v1 root".
- **Rule set 2** — corrects exactly one defect: under GENCON 94 + SHINC an agreed `EXCEPTED_PERIOD` was absorbed by the Sundays-included branch and never deducted. Root `261e3468d2246f30`. Verified surgical: of the v2 corpus's 500 cases, 44 diverge from v1 and all 44 are in the two SHINC archetypes; the other 456 are byte-identical.
- **`claims.engine_version` is the authority; `cp_terms.engine_version` is the transport.** `src/lib/laytime/engine-version.ts` is the one place that rule lives. **Absence means 1, and v1 is written as absence** — adding the key to a legacy claim's terms would change its `cp_terms` Merkle leaf and break every RFC-3161 anchor over it.
- New claims default to 2 (`DEFAULT_CP_TERMS` and the column default). Existing claims were backfilled to 1 and then **moved to 2 wholesale** by `20260801000004`, which was safe only because the product is pre-release and no claim had been served, agreed or notarised under rule set 1. That migration changed no figures (verified by recomputing every claim on both sides) and did **not** remove the mechanism. `PATCH /api/claims/:id` accepts `engineVersion: 2` only — downgrading is not on offer, and an **agreed** claim refuses the change outright.
- The rule set a claim runs on is shown in the workspace (`claim-settlement-panel.tsx`), because "which engine produced this number" is an audit question a user should not have to ask support.
- A third rule set means a third branch, a third corpus and a third root. It does not mean widening rule set 2.

Module-level docs live next to the code: `src/lib/CLAUDE.md` (module map), `src/app/CLAUDE.md` (route conventions), and per-directory files under `src/lib/integrations`, `src/lib/compliance`, `src/lib/drafting`. Design ledger and lessons: `docs/build-memory/`.

## Auth and multi-tenancy

- Three Supabase client factories: `src/lib/supabase/client.ts` (browser), `createClient()` in `src/lib/supabase/server.ts` (cookie-based, subject to RLS), and `createServiceRoleClient()` (bypasses RLS — only for trusted server paths like seeding/admin).
- Tenancy is company-based: `companies` ↔ `company_members` (a user belongs to one company). `requireAuth()` in `src/lib/server-auth.ts` returns `{ userId, email, companyId, companyName }` and throws `UNAUTHORIZED` / `NO_COMPANY`.
- Every claim-scoped API route both relies on RLS **and** explicitly checks `claim.company_id === auth.companyId` — preserve this defense-in-depth pattern in new routes.
- `bootstrapUserCompany` in `src/lib/auth-helpers.ts` creates a company + admin membership on first sign-in.

## Roles (RBAC)

`company_members.role` is one of `viewer` < `operator` < `finance_manager` < `admin` (text + CHECK; the old `app_role` enum is dropped and legacy `member` was rewritten to `operator`). The model lives in **`src/lib/auth/roles.ts`** and is the authority — a **minimum role per capability**, not a set of roles, so a non-monotonic grant (a finance manager missing something every operator has) is unrepresentable rather than merely unlikely.

- **The API layer is the primary enforcement**, not RLS. Most routes hold a service-role handle, which bypasses RLS entirely, so a model enforced only in the database would be enforced on the routes that need it least. `requireCapability(cap)` / `assertCapability(auth, cap)` in `src/lib/server-auth.ts` throw `FORBIDDEN` → 403.
- The capability check goes **after** the ownership check wherever ownership is already resolved, so a 403 never doubles as confirmation that a stranger's claim id is real. Collection routes with no claim to own (`POST /api/claims`) check first.
- RLS is the second layer, and it genuinely binds on the three tables reached through the **cookie** client: `finance_grants`, `counterparty_finance`, `settlement_chain_configs`. Reads stay open to any member; writes require `current_role_rank() >= 2`. Verified live (operator blocked, finance manager allowed).
- `public.current_role_rank()` restates the ladder in SQL because policies cannot import TypeScript. `roles.test.ts` fails if it drifts from `ROLE_RANK`, and `route-guards.test.ts` fails if a gated route loses its check — that test is mutation-verified, not just green.
- A route that moves money or issues a credential **must** be added to `GATED_ROUTES` in `src/lib/auth/route-guards.test.ts`. That list is the specification.
- Client components read the role through `useCan()` (`src/components/role-provider.tsx`, fed by `GET /api/me`), because the role is **not in the JWT** — `custom_access_token_hook` was never enabled. Hiding a control is courtesy; the server refusal is the security.
- **Demo accounts at each role**, so the refusals can be walked through in a browser: `bun run seed:rbac` puts `operator@` and `viewer@laygrounded.com` (password `demo1234`) in the same company as `demo2@`. `POST /api/init-demo` does the same on every run. No second admin is seeded — `demo2@` already holds that role, and another known-password admin is another key to the tenant for no extra coverage.

## Conventions

- Next.js 16: route handler and page `params` is a Promise — always `await params`.
- CSS-module-per-component: `src/components/core/` holds base UI primitives (Button, Card, Input), `src/components/laygrounded/` the domain components. Follow the existing pattern.

## Database

Schema and RLS policies are in `supabase/migrations/`, applied in filename order. `supabase_setup.sql` at the root is a consolidated setup script that predates the newer migrations — **it is not the source of truth**. Judge what is actually applied from the Postgres catalog (`information_schema`, `pg_constraint`, `pg_proc.proacl`), never from a migration file or from `mcp__supabase__list_migrations`, which only sees migrations applied through that tool.

## Notes

- **`REVOKE ... FROM public` does not lock a Postgres function on Supabase.** Default privileges grant EXECUTE to `anon` and `authenticated` *directly*, so a revoke from the PUBLIC pseudo-role is a no-op against them. Three matview refresh functions shipped world-executable this way. Every `SECURITY DEFINER` function must revoke from `public, anon, authenticated` by name; `src/lib/security/definer-grants.test.ts` fails the build otherwise. Verify with `pg_proc.proacl`, never by reading the migration.
- RLS on the older tables uses the `auth.uid()`-keyed helpers (`is_company_member()`, `user_owns_claim()`); some newer tables use an `auth.jwt() -> app_metadata -> company_id` pattern. **The `custom_access_token_hook` was never enabled, so that claim is always NULL** and those policies deny every end-user JWT by design — the routes concerned work only because they use the service-role client. Check which pattern a table uses before reading it with the cookie client.
- Prefer verifying against an independent implementation (openssl for DER, redocly for OpenAPI, `python-stdnum` for IBANs, a second sweep for idempotence) — self-written tests tend to agree with self-written mistakes.
- **Do not run `bun run verify:build` expecting a wasm locally** — `javy` is absent by design, so the script skips the wasm and reports only the `.mjs` roots. The sealed artifact and the mjs≡wasm equivalence assertion are produced by `.github/workflows/verifier.yml`.
