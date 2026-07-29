# Handoff prompt — LayGrounded Phase 3 and beyond

Paste the block below into a fresh session. It is written to be self-contained:
it states where things stand, the conventions that are load-bearing, the traps
that have already cost time, and what to build next.

---

You are continuing work on **LayGrounded** at `/Users/panosgeorgakopoulos/Downloads/laygrounded`.

## Where things stand

Phase 0, Phase 1 and Phase **2.1** of `docs/build-memory/PLAN-market-leadership.md`
are **done, merged to `main`, and pushed** (merge commit `f171c91`). An earlier
version of this line claimed all of Phase 2 was done; it was not. **2.2
(counterparty risk graph), 2.3 (settlement expectation model) and 2.4
(protective notice automation) are unbuilt** — there is no `reputation`,
settlement-expectation or protective-notice code anywhere in `src/`. Verified by
grep on 2026-07-29, not by reading this file. Read the plan and
`docs/build-memory/LEDGER.md` before starting.

Phase **3.1 (live demurrage meter)**, **2.4 (protective notice automation)** and
**3.2a (auto SoF chasing)** are done — see the plan file for each. Baseline:
1183 app tests + 64 package tests, tsc/lint/build clean.

Still open from Phase 2: **2.2 counterparty risk graph** and **2.3 settlement
expectation model**. Still open from Phase 3: **3.2b agent-side capture**.

Shipped so far: the voyage console (`/console`), Defense Mode (`/defense`,
inbound claim adjudication), the port congestion index (`/congestion`, publication
gated OFF behind `PUBLIC_CONGESTION_INDEX`), market benchmarking, port working
calendars with a three-tier review UI, engine determinism (canonical event
ordering + a pinned timezone table replacing `date-fns-tz`), and an offline
verifier shipping as both `.mjs` and `.wasm` with CI asserting they agree.

## Non-negotiable conventions

1. **Keep the engine pure.** `packages/laytime-core` has no I/O, no clock, no
   randomness, and exactly one runtime dependency (`decimal.js`). Anything
   touching a database belongs in a `*-server.ts`. The offline verifier and the
   500-case corpus both depend on this.
2. **Never fabricate.** If the data cannot support a figure, build the honest
   shape and name the gap. Precedent: `kb_precedents` ships empty and demands a
   `source_label`; observed port-calendar days land `pending` and are excluded
   from every calculation until a human confirms them; an unknown timezone throws
   rather than falling back to UTC.
3. **Verify against an independent implementation.** Self-written tests agree
   with self-written mistakes. Use `openssl` for DER, `redocly` for OpenAPI, ICU
   for timezone maths, a second sweep for idempotence.
4. **Drive the real UI.** Several genuine bugs this project has shipped were
   invisible to unit tests and obvious in a browser. The user has a live
   authenticated Chrome session; run the production build on a spare port
   (`NODE_ENV=production PORT=3999 bun .next/standalone/server.js` after sourcing
   `.env`) and use the `claude-in-chrome` skill.
5. **Clean up live-DB test artifacts** and say what you left behind.

## Traps that have already cost time

- `REVOKE ... FROM public` does **not** lock a Postgres function on Supabase —
  `anon`/`authenticated` hold direct grants. Revoke by name.
  `src/lib/security/definer-grants.test.ts` fails the build otherwise.
- The `custom_access_token_hook` was never enabled, so
  `auth.jwt()->app_metadata->company_id` is always NULL. Tables with that RLS
  pattern work only via the service-role client. New tables should use
  `is_company_member()`.
- Migrations apply via `mcp__supabase__apply_migration` (direct psql is dead).
  `list_migrations` only shows MCP-applied ones — judge from the catalog.
- Next 16 uses `src/proxy.ts`, not `middleware.ts`.
- `notFound()` in a dynamic page body returns HTTP 200 with a 404 view; gate in
  the proxy when the status matters.
- An ISR page evaluates env gates at **build** time.
- eslint's `react-hooks/set-state-in-effect` fires when an effect calls a
  memoized loader; inline an async IIFE with a `cancelled` guard.
- Weather-related test fixtures must use a **WWD** `days_basis` — under
  SHINC/SHEX weather pairs are inert and every perturbation prices at zero.
- Corpus PDFs are not byte-reproducible (embedded timestamp). Revert
  `synthetic-corpus/sofs/` after regenerating. Deliberate, per the user.
- Before building a numbered work item, **check whether it already exists**. The
  free-tier W1–W5 items are all complete.

## What to build next

Work in plan order unless the user redirects, and ask before anything that
publishes data or changes how established figures compute.

**Phase 3 — in-voyage (the retention play).**
- *Live demurrage meter*: a running exposure counter and projected demurrage for
  active voyages, alerting before laytime is exhausted. `voyage-shield/monitor.ts`
  already sweeps live claims; AIS ETA lives in `market/ais-telemetry.ts`. Surface
  it on `/console`.
- *Auto SoF chasing*: detect missing milestones and auto-draft grounded requests
  to the agent. Email/SMS ingestion already exists (`src/lib/ingestion/`).
- *Agent-side capture* (the harder, more valuable half): a free, offline-capable
  app letting port agents timestamp and geofence events at source.
  `ingestion/geofence-server.ts` exists. This is the supply side of the two-sided
  network and what makes Phase 4 reconciliation actually work.

**Deferred items worth folding in early:**
- Defense Mode increments: PDF intake of a counterparty's claim, wiring
  `evidence/verify.ts` into the audit (the audit already *accepts* those inputs;
  today the caller passes them by hand), and a grounded rebuttal letter.
- Funnel instrumentation — nobody can currently watch a new user reach their
  first computed claim.

**Phase 4+** is in the plan file: co-claim reconciliation, developer ecosystem
(the engine is already extracted and Apache-2.0, so this is docs + a playground +
community CP forms), eFTI as a compliance hub, then the TAM and AI tiers.

## Open questions for the user

1. Are the design partners owner-side or charterer-side? It decides how much
   further to invest in Defense Mode.
2. What is the MCP Copilot gated on? (`/api/mcp` already serves 7 company-scoped
   tools behind a full OAuth2 server; the remaining work looked like product, not
   architecture.)
3. Byte-reproducible WASM builds — only worth doing if a specific counterparty
   demands it. Javy's output is not deterministic; the reproducible attestation
   today is the behavioural conformance root.
