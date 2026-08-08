# Module map (`src/lib`)

Pure logic + unit tests in `src/lib/**`, DB access in the route or a `*-server.ts`. Design ledger, schema map, and verification log live in `docs/build-memory/`.

## `notifications/` — the inbox

The **fourth outbox consumer**. `rules.ts` is pure (`draftFor(event) → draft | null`) and `dispatch.ts` fans each draft out to recipients.

- **Routed by CAPABILITY, never by role name.** "Alert the finance manager" stored as `role: 'finance_manager'` would exclude admins — who outrank them and can do everything they can — and in a small tenant where the admin *is* the finance manager it would deliver to nobody. A rule names the capability a reader would need to act, and recipients are everyone whose role clears it on the Phase 14 ladder.
- **Silence is the default.** `draftFor` returns null for everything without an explicit rule; `claim.recomputed` fires on every engine run, and an inbox that receives it is one nobody reads. A **non-decision-grade** risk assessment is also silent — telling someone to re-plan a voyage around a figure the system will not stand behind is worse than telling them nothing.
- **Idempotent on `(user_id, dedupe_key)`** with duplicates *ignored*, not merged: outbox delivery is at-least-once, and `upsert` with merge semantics would reset `read_at` and resurrect an alert somebody had already dealt with.
- An event with no eligible recipient is **acked, not retried** — a tenant of viewers would otherwise leave a permanently stuck row at the head of the queue.
- `notifications` RLS is keyed on `auth.uid()`, not company membership — the only table in the app where that is true, because an admin has no business reading a colleague's inbox. UPDATE is granted **column-wise** on `read_at`/`dismissed_at`, which is the one thing RLS `WITH CHECK` cannot express.
- Delivery is **polled at 60s**, not Realtime. Nothing here is time-critical to the second, and a websocket per tab is a lot of moving parts for that.

UI: `notification-bell.tsx` (bell + dropdown, mounted in the authenticated layout outside the collapsing nav pill) and `/notifications` (full inbox, including dismissed).

## `auth/` — the RBAC model

`roles.ts` is pure and is the single authority for who may do what: four totally-ordered roles and a **minimum role per capability**, so a capability a lower role holds and a higher one does not cannot be expressed. `roleOf()` fails closed — anything unrecognised becomes `viewer`, and only the legacy `member` is mapped (to `operator`) rather than rejected. Enforcement helpers are in `server-auth.ts`; the SQL mirror (`current_role_rank()`) and the route-gate audit are both pinned by tests in this directory. See the Roles section of the root `CLAUDE.md` for why the API layer, not RLS, is the primary enforcement.

## Engine rule sets

`packages/laytime-core` carries **two** rule sets at once, selected by `cpTerms.engine_version` (absent = 1). v1 is frozen — its 500-case conformance root `bc9f24fdab910a1b` is published and pinned by the build. v2 corrects one defect: an agreed `EXCEPTED_PERIOD` absorbed by GENCON 94's SHINC branch. `src/lib/laytime/engine-version.ts` holds the single rule that governs this — **`claims.engine_version` is the authority, `cp_terms.engine_version` is the transport, and v1 is written as ABSENCE** (adding the key to a legacy claim would change its `cp_terms` Merkle leaf and break every RFC-3161 anchor over it). See the root `CLAUDE.md` before touching `gencon94.ts`.

## Claim intelligence layer (built on the engine's purity)

- **Scenario diffing** — `src/lib/laytime/diff.ts` (pure): applies `event_proposals` to a baseline event set, runs the engine on both versions, returns per-side results plus a money delta (`net = demurrage − despatch`, owner's perspective). Powers claim-room redlines and the owner's proposal review.
- **Claim rooms** — `src/lib/rooms.ts`: counterparties get token-based guest access (no Supabase session). `resolveShare()` validates the unguessable token (revocation + expiry) and `loadRoomView()` assembles the shared negotiation state. All room reads/writes go through the **service-role client after token validation** — the public routes (`/api/rooms/[token]`, `/api/rooms/[token]/proposals`, page `/rooms/[token]`) never accept a claim id from the guest. Owner side: `/api/claims/[claimId]/share` (create/list/revoke links) and `/api/claims/[claimId]/proposals[/proposalId]` (review; accepting applies the amendment to `sof_events` and recomputes).
- **Evidence verification** — `src/lib/evidence/`: `verify.ts` cross-references claimed `WEATHER_DELAY` windows against the Open-Meteo ERA5 archive (`weather.ts`; geocodes the port once and caches `port_lat/lon` on the claim) and NOR position against AIS (`ais.ts`, provider-pluggable; reports `unavailable` when unconfigured — never guesses). Verdicts (`corroborated`/`contradicted`/`inconclusive`/`unavailable`) persist to `evidence_checks` as a replace-on-rerun snapshot. Route: `/api/claims/[claimId]/verify-evidence`.
- **Time bars** — `src/lib/time-bar.ts` (pure): deadline = latest confirmed completion event + `claims.time_bar_days` (default 90), with a claim-pack completeness checklist. Computed in the claim GET route and as a dashboard column.
- **Clause P&L** — `src/lib/analytics/clause-pnl.ts`: counterfactual engine runs per claim (days basis vs SHINC, turn time vs none, weather/shifting removed) aggregated across the company book; rendered at `/analytics`. Settlement recording (`claims.settled_amount/settled_at`, PATCHed via the claim route) feeds its recovery-rate KPI.
- **Dispute sensitivity ("attack surface")** — `src/lib/laytime/sensitivity.ts` (pure): simulates the amendments a counterparty would argue (NOR later, completion earlier, weather extended) and the owner's counters (interruptions struck out), ranking every perturbation by net money moved; immaterial disputes are filtered. Computed on demand via `GET /api/claims/[claimId]/sensitivity`, surfaced as "Negotiation intel" in the workspace panel.
- **Fixture Risk Simulator** — `src/lib/simulator/fixture-risk.ts`: pre-fixture Monte Carlo that replays the last N years of actual ERA5 weather at a port through the engine under hypothetical CP terms (stoppage thresholds shared with evidence verification), producing a demurrage distribution (mean/median/P90, demurrage probability). Pure parts (stoppage flags, voyage synthesis, percentiles) are unit-tested; route `POST /api/simulator/fixture-risk`; page `/simulator`.
- **Pre-arrival risk (Monte Carlo)** — `src/lib/risk/`: seeded, reproducible simulation of demurrage exposure BEFORE arrival, for a vessel with an ETA (distinct from the pre-fixture simulator above, which prices hypothetical terms with no vessel). Pure core — `prng.ts` (xoshiro128\*\* over cyrb128; never `Math.random`), `distributions.ts` (samplers take one uniform each so trials can be mirrored for antithetic variates), `horizon.ts`, `trial.ts`, `aggregate.ts` (every statistic carries its Monte Carlo standard error), `simulate.ts`. I/O in `sources/` and `assess-server.ts`. Route `POST/GET /api/risk/pre-arrival`; table `pre_arrival_risks`. Three invariants worth knowing: the **hybrid horizon is a MIXTURE, never an average** (averaging two weather series destroys autocorrelation and collapses the variance — see `horizon.ts`); **weather is sampled as whole trajectories**, ensemble members or entire historical years, never per-hour draws; and **mock AIS can never be decision-grade** (`provenance.ts` decides this in one place, and `sources/resolve-congestion.ts` refuses mock in production). Replays must compare with `verifyReplay`, not `JSON.stringify` — jsonb does not preserve key order.
- **Workspace UI** — `src/components/laygrounded/claim-intel-panel.tsx` is the collapsible strip in the workspace that surfaces all of the above (time bar, evidence, share links, proposal accept/reject, settlement) plus compliance, drafting, and ERP push.

## Predictive & financial network layer (blue-ocean modules)

Six modules built on the engine's purity (pure math in `src/lib/**` with unit tests, DB access in services/routes). Migrations `20260714000001`–`...06`.

- **In-voyage Legal Shield** — `src/lib/voyage-shield/monitor.ts` re-verifies live (unsettled) claims' weather events; contradicted checks upsert `voyage_alerts` (unique per claim/type/event → idempotent sweeps) and auto-draft a grounded `letter_of_protest` (new `drafts.kind`; the one kind allowed before a calculation exists). `POST /api/voyage-shield/run` (CRON_SECRET or authed, run-sync pattern); `GET` = alert inbox.
- **Honesty Index** — cross-tenant matview `honesty_index` (contradiction rates per port/agent per check type). Matviews carry no RLS, so: zero grants to anon/authenticated, service-role read only inside `GET /api/intel/honesty-index`, k-anonymity floor (`MIN_DECISIVE_CHECKS`), aggregates only. `POST` same route refreshes via SECURITY DEFINER `refresh_honesty_index()` (service_role-only EXECUTE). Pure scoring in `src/lib/intel/honesty-index.ts`.
- **Zero-day settlement clearinghouse** — `src/lib/settlement/`: pure `evaluateEligibility` requires voyage complete + ERP-anchored + calculation + 100% corroborated evidence (unavailable/inconclusive disqualify) + no pending proposals + not settled. `settleClaim` inserts `settlements` (UNIQUE claim_id decides races; idempotency key pins the calculation snapshot) then clears via `banking.ts` (HMAC-signed provider webhook; no `SETTLEMENT_PROVIDER_URL` → clearly-labeled simulated clearing). `GET/POST /api/claims/[claimId]/settle`, sweep `POST /api/settlement/run`. Cleared settlements write back `claims.settled_amount/settled_at`.
- **Settlement party details** — `src/lib/settlement/counterparty-finance.ts` (pure: ISO 13616 MOD-97 IBAN validation cross-checked against `python-stdnum`, ISO 9362 BIC, wallet shape, chain agreement) + `-server.ts` (RLS-scoped CRUD for parties and per-chain escrow deployments). Hydrated into `escrow-server.ts` so settlement payloads carry real IBAN/BIC/wallet instead of nulls. Routes `/api/settlement/counterparty-finance` and `/api/settlement/chain-configs`; UI at Settings → Settlement & Banking, which imports the same pure validators. Agreement + payload UI is `claim-settlement-panel.tsx` on the claim workspace. See `src/lib/settlement/CLAUDE.md`.
- **Pre-fixture pricing oracle** — cross-tenant matview `oracle_voyage_stats` (per-calculation port/month/cargo stats from the stored breakdown; `verified` = evidence never contradicted), same no-grant/service-role pattern. Pure `src/lib/oracle/pricing.ts` replays historical used-hours against a broker's proposed allowance. `POST /api/oracle/pricing` (verified-preferred sample, cargo fallback, `INSUFFICIENT_DATA` → 422); `POST /api/oracle/refresh`.
- **Charter chain ("ripple")** — `src/lib/chain/ripple.ts` clones a claim's confirmed events one tier down (`claims.parent_claim_id/chain_role/chain_depth`, depth-capped) onto a stub document (`mime 'chain'`; never reference parent document rows — cross-claim cascade risk). Events corroborated by evidence clone as `locked` with `locked_reason`; `EVENT_LOCKED` (409) is enforced at guest proposal creation, owner proposal acceptance, and direct event PATCH. `POST/GET /api/claims/[claimId]/sub-claim`.
- **Parametric insurance oracle** — `src/lib/insurance/`: pure `detect.ts` finds the longest *continuous* weather-delay window in a breakdown; `oracle.ts` compares it to each active policy's `threshold_hours`, ledgers `insurance_triggers` (UNIQUE idempotency key → at-most-once per window) and emits HMAC-signed webhooks. Insurers authenticate with a hashed API key (plaintext returned once at creation) on read-only `GET /api/insurance/oracle`; management `POST/GET /api/insurance/policies`; sweep `POST /api/insurance/run`.

## ERP schedules → risk (the pre-arrival bridge)

`erp_vessel_schedules` is the landing table for forward port calls pulled from an ERP. **A schedule is a plan, not a fact**: it is never promoted to a claim, has a SELECT policy and no write policy at all (the sync worker is the only writer, as service_role), and an end user editing it would silently diverge from the source system.

- **`/schedules`** ("Fleet Schedules") lists them, carrying provenance to the surface: the integration's display name, its external ref, and whether it is a **mock** integration serving fixtures. `mappingVerifiedAgainstVendorDocs` is shown as a warning, and still means "follows published vendor documentation", never "live-tested".
- **`src/lib/simulator/prefill.ts`** (pure) is the bridge, imported by **both** ends so the parameter names cannot drift: the schedules page builds the query with `buildPreArrivalQuery`, the simulator reads it with `readPreArrivalPrefill`. A silently-vanishing prefill looks exactly like a user who did not click the button.
- **What is deliberately NOT carried:** laytime allowance, days basis, demurrage/despatch rates and ops duration. An ERP schedule does not contain charterparty terms, and each is an input the exposure is highly sensitive to — carrying a plausible default would produce a figure that *looks* derived from the ERP and is not. The banner on the simulator says so.
- `port_function` maps to the simulator's operation for `load`/`discharge` only. `bunker`, `transit` and `unknown` map to **null**, not to a guess: a bunker call is not a cargo operation.

## Zero-data entry, and the audit room

Two ingestion routes into `sof_events`, and they are complements rather than alternatives:

- **Vision** — `POST /api/claims/[claimId]/documents` → `src/lib/ai/extraction.ts`. Page images to a model; the high-fidelity route for a scanned or photographed SoF. UI: the dropzone in `document-viewer.tsx`.
- **Deterministic text** — `POST /api/claims/[claimId]/ingest-sof-text` → `extractSofTimeline` in `ingestion/multimodal.ts`. Line-based, no model call, instant, free, and the same text always yields the same events — which is what makes it reproducible if a figure derived from it is later disputed. UI: `sof-text-ingest.tsx` (paste, or drop a `.txt`/`.eml`). The M2M twin is `/api/v1/ingestion/sof-text`; **both write through `ingestion/sof-text-server.ts`** so the review contract cannot drift.

Both land events as **`suggested`**. `loadClaimComputationInputs` reads only `accepted`/`edited`, so nothing extracted can move a figure until a human confirms it. Zero-touch data entry, not zero-touch trust. The text path previews before writing: unstructured text can yield nonsense, and thirty junk events to reject one by one is worse than showing them first.

**Timestamps are never guessed.** A naive line is reported and skipped unless the caller supplies the port's UTC offset — and an offset written on the line itself wins over any default, including on day-first maritime dates (`12/03/2024 06:30 +08:00`).

### The audit room

`GET /api/claims/[claimId]/verification` is the owner's mirror of the bank-facing `/api/v1/claims/[claimId]/verify`, plus `?download=1` for the canonical bundle. UI: `claim-verification-panel.tsx`.

**Two hashes live there and conflating them is the trap.** `verifier.conformanceRoot` fingerprints the ENGINE — identical for every claim on a rule set, and it does not move when the claim changes. The notarisation digest is a Merkle root over THIS CLAIM's sealed state and moves the moment anything does. A reader who believed the first was per-claim would conclude a tampered claim was intact.

**Each rule set has its own suite and its own root.** `readVerifierManifest(engineVersion)` selects it; a fixed path would send a v2 claim's reader to v1's cases, where the root they computed would match the manifest and attest the wrong engine. Pinned by `verifier-manifest.test.ts`.

An owner-exported package carries `grant: null` and a caveat saying so, rather than a synthesised grant descriptor — a fabricated authorisation record in a document a bank reads as evidence.

## Spatial verification and negotiation

- **AIS verification map** — `ais-verification-map.tsx` over `GET /api/claims/[id]/ais-track`. Plots the position track as plain SVG (no tile layer: the question is "did she move when the SoF says she moved", which is shape and time, not geography — and it keeps the component self-contained). The track is **fetched on demand, never stored**: `verifyClaimEvidence` persists motion *verdicts* into `evidence_checks` but not the fixes, and a stale copy would show a track that no longer supports the verdict beside it. `fetchAisTrack` returns `null` — never `[]` — so "we could not look" and "we looked and she was nowhere" stay distinct. Long inter-fix intervals draw dashed and classify `unknown`: a gap in the feed is not evidence the vessel sat still. With no provider configured the map says exactly that, and the verdict timeline still renders.
- **Negotiation** — `claim-negotiation-panel.tsx` over `/api/claims/[id]/negotiation` (phase) and `POST /api/claims/[id]/proposals` (owner-raised disputes). **The phase is DERIVED, not stored as a label**: `derivePhase()` reads `agreed_at`, `negotiation_opened_at` and the pending-proposal count, because a claim with a live dispute must never read as anything but negotiating. A dispute is an `event_proposals` row — the same table the claim room writes and the same accept/reject — differing only in provenance (`share_id` null = raised internally). A counter-duration is expressed as a **new timestamp**, since that is what the engine consumes; storing a duration beside it would create a second source of truth for one interval.
- **Concession strategy** — `concession-strategy.tsx`, inside the negotiation panel, over `POST /api/v1/claims/[id]/negotiate`. The engine takes exactly three knobs per side (`maxConcessionUsd`, `hardStopClauses`, `maxRounds`) and the UI does not invent a richer contract: operator-facing **percentages and hours are CONVERTED IN FRONT OF THE USER** into the money figure the engine receives, and the converted figure is what is displayed. Hiding that conversion would make the mandate feel more precise than it is — the agents trade money, not hours. Evidence still overrides the mandate: a contradicted event is conceded whether or not its category is a hard stop.
- **Synthetic AIS** — `src/lib/dev/mock-ais-track.ts` (pure) draws a track with an anchor phase, a feed gap **spanning real distance mid-transit**, a berth phase with a warping excursion, and a duplicate timestamp. Enabled only by `AIS_PROVIDER_URL=mock` outside production. Verdicts are derived in memory via the same `verifyTimelineMotion` the real pipeline uses and are **never persisted** — a fabricated track reaching a stored verdict would put invented evidence into a claim.
- **Not to be confused with `negotiation/autonomous.ts`**, which is agent-to-agent concession trading producing a settlement recommendation (deterministic personas, not LLMs) with its own UI in `claim-actions-panel.tsx`. That answers "what should we settle at"; this answers "what is actually disputed".

## The claim ledger, and where every backend feature surfaces

- **Activity ledger** — `src/lib/audit/claim-activity.ts` (pure) + `GET /api/claims/[id]/activity` + `claim-activity-feed.tsx`. A **read-time projection**, deliberately not a `claim_audit_logs` table: a stored log would need backfilling (inventing timestamps for history), would be a second copy of facts that already carry their own times, and a failed writer would leave a hole nothing could detect. Projecting cannot disagree with the record because it *is* the record. **An actor that cannot be established reads `unknown`, never a person** — attributing a machine's action to a human is the failure that makes an audit trail actively misleading. `domain_events` is included but terse: it records that a transition was *published*, which is a different fact from the transition, already present from its own table.

**Surface-area map** (every user-facing backend feature and its UI):

| Feature | UI |
|---|---|
| Trade-finance grants (`grants-server.ts`) | `finance-grants-panel.tsx` — issue/revoke bank tokens, claim workspace |
| Live exposure (`voyage/exposure.ts`) | `claim-outlook-panel.tsx` (left) |
| Settlement expectation (`settlement/expectation.ts`) | `claim-outlook-panel.tsx` (right) |
| Counterparty intel (`intel/counterparty.ts`) | `counterparty-intel.tsx` on `/analytics` |
| CP risk analyzer (`prefixture/analyze-server.ts`) | `cp-risk-analyzer.tsx` on `/analytics` |
| Notifications (`notifications/dispatch.ts`) | `notification-bell.tsx` in the authenticated layout, plus `/notifications` |

Routes with **no** UI are machine-facing by design: cron sweeps (`*/run`, `events/dispatch`), M2M under `/api/v1/*`, inbound webhooks, the bank-facing `/v1/claims/:id/verify` (grant-redeemed), public verifier artifacts, and `/mcp`.

## Later modules (built after the sections above; same conventions)

- **Voyage console** — `src/lib/console/triage.ts` (pure) ranks the whole book into a work queue: severity tiers first (an expiring time bar outranks a larger comfortable claim, because the deadline is irreversible), money only as the tiebreak within a tier. Page `/console`, server-rendered with batched per-claim queries.
- **MCP + OAuth 2.1** — `src/lib/oauth/` is a full authorization server (PKCE S256 only, RFC 7591 registration, refresh rotation with reuse→family revocation, tokens stored as SHA-256 hashes) fronting `/api/mcp`, a JSON-RPC server exposing 7 company-scoped tools across `claims:read` / `claims:write` / `analysis:read`. Tenancy comes from the token, never the caller: `requireClaim()` in `src/lib/oauth/mcp.ts` is load-bearing because the db handle is service-role.
- **Audit trail API** — `src/lib/api/` (hashed API keys, per-key Postgres rate limiter, time-bar webhooks, generated OpenAPI) behind `/api/v1/audit/*`.
- **Tamper-evident security log** — `src/lib/audit/security-log.ts`: `security_events` hash-chained per company via the SECURITY DEFINER `append_security_event()` under a per-company advisory lock. Settings → "Security Trail".
- **Ingestion channels** — `src/lib/ingestion/`: inbound email (`x-ingestion-secret`, sender resolved via the `get_user_id_by_email` RPC), SMS (Twilio `X-Twilio-Signature`), and multimodal SoF text + AIS geofencing.
- **Legal** — `src/lib/legal/`: RFC-3161 notarization (`anchor.ts`), dossier assembly, arrest pre-filing.
- **Interop** — `src/lib/interop/`: eFTI export plus a federation node with scoped, revocable authority grants (token stored as a hash; a scoped subset is re-signed so it cannot be confused with a full export).
- **Knowledge base** — `kb_clauses` / `kb_precedents` with generated-tsvector FTS; the app's one public anon-readable table. Public pages `/knowledge` (ISR) and `/knowledge/[slug]` (SSG). Case law is only ever user-supplied and licensed — never fabricated.
- **Compliance** — see `src/lib/compliance/CLAUDE.md`.
- Others: `market/` (bunker + AIS telemetry), `negotiation/autonomous.ts` (deterministic personas, **not** LLMs), `optimization/ecospeed.ts`, `security/url-guard.ts` (SSRF), `security/definer-grants.ts`.

## The claim pipeline, step by step

The root `CLAUDE.md` carries the one-line shape of this pipeline and the two rules that bind `packages/laytime-core`. The per-step detail is here because three of the four steps are files under `src/lib`.

1. **Upload & extraction** — `POST /api/claims/[claimId]/documents` validates the file by magic bytes (`file-type`), stores it in the Supabase `sofs` bucket under `{companyId}/{claimId}/`, then calls `uploadSofAndExtract` in `src/lib/ai/extraction.ts`. Extraction sends page images via `generateWithFallback` (`src/lib/ai/gemini.ts` — model chain `GEMINI_MODEL` → `GEMINI_FALLBACK_MODEL`, per-model backoff, falls back on 429/404/5xx but never on 400/401/403), validates the response with Zod (timestamps must carry a timezone; events must match `EventTypeEnum`), and inserts rows into `sof_events`.

2. **Rules engine** — `packages/laytime-core/src/gencon94.ts` takes `SofEventInput[]` + `CpTerms` and returns a `LaytimeResult` (breakdown rows + totals). It carries two rule sets at once, selected by `cpTerms.engine_version` (absent = 1) — see "Engine versioning" in the root `CLAUDE.md`. Under ASBATANKVOY, berthing cuts turn time short, weather never stops laytime, and storm on demurrage bills half rate via `totals.demurrage_half_rate_hours`. It uses `decimal.js` for money and `date-fns-tz` for port-timezone-aware SHEX/SSHEX day exclusions.

3. **Recompute bridge** — `src/lib/laytime/recompute-server.ts` loads a claim's confirmed events and `cp_terms` (validated with Zod) via the shared `loadClaimComputationInputs()`, runs the engine, and persists the result to `laytime_calculations`. Callers running outside a user request (demo seeder, claim rooms) must pass a service-role client explicitly, because the default cookie client has no user and RLS blocks everything.

4. **Clause flagging** — `src/lib/clause-flagging.ts` audits the event chronology for ambiguous triggers (NOR at anchorage, shifting before ALL_FAST, etc.) and writes `clause_flags` with severity + clause reference.

Shared domain types (event enums, `CpTerms`, `LaytimeResult`, `DEFAULT_CP_TERMS`) live in `src/lib/laytime/types.ts`; DB row shapes in `src/lib/database-types.ts`.
