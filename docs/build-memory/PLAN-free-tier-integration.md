# PLAN — Full free-tier integration (single tier, no paid part)

> **Progress:** ALL DONE — W1 ✅, W2 ✅, W5 ✅ (2026-07-24), W4 ✅, W3 ✅ (2026-07-25).
> The free-tier roadmap is fully integrated; every Batch 1–8 capability now ships
> ungated. No remaining items.
>
> W3 as-built: migration `20260725000001_efti_grants.sql` (token-HASHED grants,
> per-company RLS read). Pure `src/lib/interop/efti-federation.ts` (scope vocab +
> MVSD default + `scopeConsignment` re-signs the filtered subset + verify) with 7
> tests. Server `src/lib/interop/efti-grants.ts` (create/list/revoke/resolve +
> `loadEftiConsignment` loader mirroring the export route). Routes: owner
> `POST/GET /api/v1/interoperability/efti/grants` + `DELETE .../grants/[grantId]`
> (requireAuth, audit share.created/revoked + metadata.event); authority
> `GET .../efti/shared/[token]` (token-auth, claimId FROM the grant not the caller,
> 404 on unknown/revoked/expired). UI: "Authority sharing" block in
> claim-actions-panel (label + scope checkboxes + create → link shown once + list/
> revoke). DEFERRED: the optional HMAC push to a configured authority endpoint
> (needs a pilot partner). Verified grant round-trip live via MCP (hash lookup +
> scope array; test row cleaned up). 995 tests, tsc 0, lint 0, build 81/81.
>
> W4 as-built: migration `20260725000000_knowledge_graph.sql` (kb_clauses +
> kb_precedents, generated-tsvector FTS, PUBLIC anon-read RLS, 16 curated clause
> rows seeded IN the migration). Public pages `/knowledge` (ISR) + `/knowledge/[slug]`
> (SSG, 16 pages) + `KnowledgeBrowser` client filter; `GET /api/knowledge/search`
> (public FTS); `src/lib/knowledge/query.ts` (service-role reads, try/catch → []
> fallback so build never breaks); `src/app/robots.ts` + `sitemap.ts`; layout
> `metadataBase`; footer link; `scripts/seed/kb-import.ts` (precedent import — ships
> empty, requires source_label per row, NO fabrication). GOTCHA: generated tsvector
> column can't use `array_to_string(tags,' ')` (STABLE, not IMMUTABLE) → use
> `array_to_tsvector(tags)`.
>
> W5 as-built: pure engine extracted to `packages/laytime-core/` (bun workspace,
> `@laygrounded/laytime-core`, Apache-2.0). App consumes it via re-export shims at
> `src/lib/laytime/{gencon94,types,diff,sensitivity}.ts` + tsconfig `paths` +
> `transpilePackages` in next.config. `bun install` is REQUIRED after checkout
> (links the workspace symlink). Two gotchas hit: (1) removed the broken
> `@types/bcryptjs` deprecation stub (unused; TS2688) and had to `rm -rf` its
> stale node_modules dir; (2) a stale `.next` cache made `/claims/new` prerender
> throw a "workStore" invariant — `rm -rf .next` fixed it. Do a clean `.next` build
> after any workspace/dep-graph change.


**Objective.** Ship every capability from the original Batch 1–8 roadmap as ONE
free tier. No Stripe, no plans, no usage metering, no feature gating. Batch 4
(monetization) is permanently descoped; its downstream items (A1/A3/A8) become
"build the capability, expose it ungated."

**Guiding principle for every item below:** if a step introduces a paywall,
quota, tier check, or "upgrade" path, it is wrong. Features are gated only by
auth + tenancy (RLS + `claim.company_id === auth.companyId`), never by plan.

Read `SKILLS.md` (repo root) first — verify loop, migrations-via-Supabase-MCP
(psql is dead; `list_migrations` returns `[]`; judge from `list_tables`), and the
repo gotchas. Design ledger: `LEDGER.md` / `SCHEMA.md` / `LESSONS.md`.

---

## Verified status (2026-07-23)

| Batch (code) | Feature | Status |
|---|---|---|
| 1 (G6/A7) | NOx/SOx emissions, carbon-cost-of-delay, ETS scope+phase-in, FuelEU | **DONE** |
| 2 (G9/F1) | Bunker-price feed, live-AIS telemetry (honest-unavailable) | **DONE** |
| 3 (F3) | Inbound email ingestion | **DONE** (SMS variant pending → W2) |
| 4 | Monetization | **CANCELLED** — residue is `/pricing` copy → W1 |
| 5 (A1) | PLG self-serve (recap onboarding) | **DONE**, already free |
| 6 (G8) | eFTI — **export** done; **federation node** | **GAP → W3** |
| 7 (A5) | Legal Knowledge Graph | **GAP → W4** |
| 8 (A6) | Open-source core | **GAP → W5** |

App code has **zero** paid gating today (audited: no stripe/quota/tier/entitlement
logic; the only hits are webhook "subscriptions", auth listeners, rate-limit
"quota"). The single "paid part" is the marketing `/pricing` page.

---

## W1 — Free-tier consolidation (from Batch 4 cancellation) · effort: S

**Gap.** `src/app/pricing/page.tsx` advertises 3 tiers — "Free Trial" (Up to 5
calcs/month), "Professional" (unlimited + evidence/rooms), "Enterprise"
(drafter/shield/settlement/oracles/SSO, "Contact Sales"). The 5/month limit and
the tier split contradict "single free tier".

**Do.**
1. Rewrite `pricing/page.tsx` to ONE plan — everything included, free. Fold the
   three `<li>` lists into a single feature list; drop "Up to 5…/month",
   "Contact Sales", price columns. CTA → sign-up.
2. Grep marketing copy for tier language and reconcile: `rg -n "Professional|Enterprise|Free Trial|per month|/mo|Contact Sales|upgrade" src/app` (check `features/`, `about/`, `page.tsx` hero, `story/`).
3. Confirm (not assume) no code gate exists: `rg -li "stripe|plan_tier|entitlement|usage.?limit|freemium|paywall" src` → expect none. If any appears later, remove it.

**Verify.** `bun run build`; visually the pricing page shows one free tier.
**Decisions:** none (pure copy). Keep a feature list for marketing value.

---

## W2 — SMS ingestion (F3 remainder) · effort: S

**Gap.** Inbound **email** ingestion exists; SMS (Twilio-shape webhook) does not.
It is the same shape.

**Do.** Mirror `src/lib/ingestion/inbound-email.ts` → `sms.ts` (parse a
Twilio-style form-encoded webhook: `From`, `Body`, optional `MediaUrl*`). Route
`POST /api/v1/ingestion/sms` mirroring `src/app/api/v1/ingestion/email/route.ts`:
secret-gate (`x-ingestion-secret` or Twilio signature), resolve tenant, reuse
`extractSofTimeline` + geofence, land events as suggested. Pure parser gets a
unit test like `inbound-email.test.ts`. Add the endpoint to the developer-settings
API reference card. Env: reuse `INGESTION_INBOUND_SECRET` (or `TWILIO_AUTH_TOKEN`
for signature verification — honest-unavailable if unset).

**Verify.** `bun test src/lib/ingestion`; tsc; build.
**Decisions:** Twilio signature vs shared-secret auth (recommend: support both,
signature preferred when `TWILIO_AUTH_TOKEN` set).

---

## W3 — eFTI federation node (Batch 6 / G8) · effort: L · biggest external dependency

**Gap.** `src/lib/interop/efti.ts` builds an eFTI **export** (dataset per Reg (EU)
2020/1056). Missing: a **federated node** that shares a *permissioned, scoped,
revocable* eFTI dataset subset with a named authority/platform and logs access.

**Do (fully buildable in-repo without a live partner — the authority is
configured, not hardcoded).**
1. Migration (next in sequence, apply via Supabase MCP): `efti_grants`
   (id, claim_id, company_id, authority_label, dataset_scope text[] — which eFTI
   subsets, token_hash, expires_at, revoked_at, created_by). Service-role-only
   RLS + a users-read-own-company SELECT, mirroring `claim_shares`
   (`src/lib/rooms.ts`) and `oauth_*`.
2. `src/lib/interop/efti-federation.ts` (pure): given a claim's eFTI export +
   a grant's `dataset_scope`, return the authority-visible subset (filter fields).
3. Routes: owner side `POST/GET/DELETE /api/v1/interoperability/efti/grants`
   (create scoped grant → return token once; list; revoke). Authority side
   `GET /api/v1/interoperability/efti/shared/[token]` (token-auth, service-role
   after validation, NEVER accepts a claim id from the caller — copy the
   `resolveShare()` pattern in `rooms.ts`). Every access appends a
   `security_events` row (`recordSecurityEvent`, action reuse + `metadata.event:
   "efti_shared_access"`, per the decision-route convention — do NOT extend
   SECURITY_ACTIONS).
4. HMAC-signed push option to a configured authority endpoint (reuse
   `src/lib/security/url-guard.ts` + the webhook signer in `api/webhooks.ts`).
5. UI: an "eFTI authority sharing" card on the claim intel/actions panel (create
   grant, list, revoke) — pattern = the existing share-link UI.

**Verify.** Pure filter unit test; migration on throwaway PG or MCP; token flow
E2E via MCP `execute_sql`; tsc/lint/build.
**Decisions (user):** (a) which authority/platform profile to target first (the
grant is generic, but a reference profile helps); (b) confirm eFTI subset scopes
to expose. Free: no gate — grants are an owner capability.

---

## W4 — Legal Knowledge Graph (Batch 7 / A5) · effort: L · content-bound

**Gap.** No public precedents/clause DB. Hard part is DATA — **do not fabricate
law** (AD-036). Build the shell + seed only with content the repo legitimately
owns; leave third-party case law to a clearly-marked import pipeline.

**Do.**
1. Migration: `kb_clauses` (id, cp_form, clause_ref, title, body text,
   source_url, source_label, is_curated bool, created_at) and optional
   `kb_precedents` (case_name, citation, jurisdiction, summary, source_url,
   holding, tags text[]). Public read (anon SELECT allowed — this is the SEO
   play), writes service-role only.
2. **Honest seed (no fabrication):** the GENCON 94 / ASBATANKVOY clause reference
   text ALREADY in the codebase — `src/lib/laytime/gencon94.ts` (clause refs
   `GENCON94-*` / `ASBA-II-*`), `src/lib/clause-flagging.ts`,
   `src/lib/drafting/context.ts`/`grounding.ts` (clause reference text used for
   grounding). Extract these into a `scripts/seed/kb-clauses.ts` seeder. This is
   the app's own annotations, not copied law.
3. Case-law / precedents: an **import pipeline** (`scripts/seed/kb-import.ts`)
   that ingests a CSV/JSON the user supplies from a licensed source; every row
   carries `source_url`+`source_label`; NOTHING is auto-generated. Ship empty
   until real data is provided.
4. Public pages (outside the authenticated group, indexable): `/knowledge`
   (search + filter by cp_form/tag), `/knowledge/[slug]` (one clause/precedent),
   server-rendered for SEO; add to `sitemap`/`robots` (currently rooms are
   noindex — these are the opposite: DO index). Reuse the public marketing-page
   layout.
5. Search: Postgres `to_tsvector` FTS on body/title (add a GIN index in the
   migration) → a `GET /api/knowledge/search?q=` route (public, read-only).

**Verify.** Seeder populates from repo clause text; FTS route returns hits;
Lighthouse/`next build` shows the pages static/SSR; tsc/lint.
**Decisions (user):** case-law data source (must be user-provided/licensed — I
will not fabricate). SEO scope. Free + public by design.

---

## W5 — Open-source core (Batch 8 / A6) · effort: M · mostly packaging

**Gap.** No LICENSE; `package.json` is `private:true`, name
`nextjs_tailwind_shadcn_ts`. The pure engine is publishable; AI/evidence/collab
stay proprietary.

**Do.**
1. Extract the pure, I/O-free core into a standalone package
   `packages/laytime-core/` (bun/npm workspace): `gencon94.ts` (422 L),
   `types.ts` (116 L), `diff.ts` (122 L), `sensitivity.ts` (233 L) + their tests
   (`gencon94.test.ts`, `diff.test.ts`, `sensitivity.test.ts`, `regression.test.ts`
   + the synthetic corpus). These already import only `decimal.js` / `date-fns-tz`
   — no repo-internal deps except each other and `types.ts`. Confirm with
   `rg "@/lib" src/lib/laytime/{gencon94,diff,sensitivity,types}.ts` (expect only
   intra-laytime imports).
2. Add a workspace to root `package.json` (`"workspaces": ["packages/*"]`), make
   the package public (`"name": "@laygrounded/laytime-core"`, `"private": false`,
   `exports`, `types`, a `tsup`/`bun build` step). The Next app imports it via the
   workspace (keep `@/*` alias for everything else).
3. Root `LICENSE` for the package + a `packages/laytime-core/README.md` (usage,
   the GENCON94/ASBATANKVOY regimes, the corpus safety net).
4. Keep proprietary: `ai/`, `evidence/`, `drafting/`, `oauth/`, `rooms`,
   collab, integrations — do NOT move them.

**Verify.** `bun install` resolves the workspace; `bun test packages/laytime-core`
green; the app still builds importing from the package; corpus regression passes.
**Decisions (user, BLOCKING):** the **LICENSE** (MIT / Apache-2.0 / BSL-1.1 /
other). Per AD-036 do not invent legal metadata — the user must choose. Also: keep
the extracted code in-repo (monorepo publish) vs a separate public repo.

---

## Recommended order (fastest value first)

1. **W1** (S) — one-file copy change; delivers the "single free tier" headline immediately.
2. **W2** (S) — small, mechanical, closes F3.
3. **W5** (M) — packaging; blocked only on the LICENSE choice (ask up front).
4. **W4** (L) — schema + shell + honest seed now; case-law import when data arrives.
5. **W3** (L) — most surface area (migration + routes + UI + audit); do last.

W1+W2 are one short session. W3/W4/W5 are one session each.

## Open decisions to resolve before/at the start of the implementing session
1. **W5 LICENSE** (blocking): MIT / Apache-2.0 / BSL-1.1 / other?
2. **W4 case-law data**: user provides a licensed CSV/JSON, or ship clause-only (repo-owned) first?
3. **W3 eFTI**: target authority/platform profile, and confirmed dataset scopes.
4. **W2 SMS auth**: Twilio signature, shared secret, or both?

All four items ship ungated. The only removal is the `/pricing` tier copy (W1).
