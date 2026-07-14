# Build Memory — Architectural Decision Ledger

Blue-ocean build (Modules 1–6), started 2026-07-13. One entry per decision;
never delete — supersede with a new entry referencing the old ID.

## AD-001 — Migration numbering
One migration per module, `2026071400000N_<module>.sql` (N = module number),
so files sort after `20260713000000_compliance_integrations_drafts.sql` and
module order is readable from the directory listing.

## AD-002 — Cross-tenant aggregates bypass RLS deliberately, gated in the API layer
Modules 2 and 4 aggregate across *all* companies (that is the product: network
data). Postgres materialized views cannot carry RLS, so: (a) no SELECT grant to
`authenticated`/`anon` — only the service-role key can read them; (b) the API
routes are the sole access path and enforce k-anonymity (suppress any subject
with fewer than MIN_SAMPLE decisive checks/voyages) plus return only
aggregates, never claim ids or company ids.

## AD-003 — Module 1 reuses `drafts` with kind `letter_of_protest`
No new letters table. The Legal Shield writes a `voyage_alerts` row (the
trigger record, deduped per contradicted event) and links the generated draft
via `draft_id`. The drafter gains one kind + brief; grounding verification
applies to LoPs unchanged.

## AD-004 — Engine purity is preserved
`gencon94.ts` is untouched. Every new computation is a pure function over the
engine's outputs (`LaytimeResult`/`breakdown`) or plain rows:
`insurance/detect.ts`, `oracle/pricing.ts` math, `settlement/clearinghouse.ts`
eligibility. DB access stays in services/routes, mirroring
`recompute-server.ts` as the bridge pattern.

## AD-005 — SUPERSEDED by AD-010
(Original plan: relax `sof_events.document_id` to nullable for chain clones.)

## AD-010 — Chain sub-claims clone events onto a stub document (supersedes AD-005)
The proposal-accept route already creates manual stub `documents` rows
(`storage_path 'manual/…'`, `mime 'manual'`) when a claim has no document —
precedent found during Module 5. Sub-claims therefore get one stub document
(`storage_path 'chain/<parentId>'`, `mime 'chain'`) owned by the sub-claim,
and clones point at it. NOT NULL invariant preserved, no cross-claim cascade
path, and the document row dies with the sub-claim. Fact-locking (`locked`,
`locked_reason`) is enforced server-side at all three mutation surfaces:
guest proposal creation, owner proposal acceptance, and direct event PATCH.
Locks propagate down-chain even when the corroborating evidence check
predates the tier.

## AD-006 — All outbound webhooks are HMAC-SHA256 signed
Same discipline as the ERP adapter: settlement (Module 3) and insurance
(Module 6) payloads carry `x-laygrounded-signature: sha256=<hmac(body)>` and
an idempotency key. When no provider URL is configured, the settlement
provider returns a clearly-labeled `simulated` clearing (mock B2B template);
it never silently pretends a real transfer happened.

## AD-007 — Background workers = cron-hit routes (run-sync pattern)
Next.js has no resident worker. Modules 1, 3, 6 expose `POST` routes accepting
either the `x-cron-secret: CRON_SECRET` header (service-role, whole book) or
an authenticated session (scoped to the caller's company). Idempotency comes
from unique indexes (alerts per event, settlements per claim, triggers per
policy+window), so re-runs are safe.

## AD-008 — New API error sentinels are passed via `extraKnown`, not DEFAULT_KNOWN
Keeps `api-errors.ts` untouched (a shared file parallel subagents must not
edit). Sentinels added this build: `NOT_ELIGIBLE` (409), `ALREADY_SETTLED`
(409), `EVENT_LOCKED` (409), `POLICY_NOT_FOUND` (404), `PARENT_NOT_FOUND`
(404), `INSUFFICIENT_DATA` (422), `STATS_UNAVAILABLE` (503).

## AD-009 — Subagent boundaries
Modules 2 and 4 were built by parallel subagents. Hard rule given to both: own
only their module's new files; never touch `api-errors.ts`,
`database-types.ts`, `types.ts`, or another module's migration. Orchestrator
verifies their output at the module gate (tsc + bun test + import audit).

## AD-011 — Frontier expansion consolidates into 3 pure libs + one migration (2026-07-14)
CII degradation / biofouling / SFTW / MRV-ETS / green twin live in one pure
module `src/lib/compliance/carbon.ts`; pre-fixture intelligence / clause-swap
hedging / shock index / ROI / early warnings in `src/lib/analytics/predictive.ts`
(reuses `percentile` + `MIN_SAMPLE_VOYAGES` from `oracle/pricing.ts`); Merkle
notary + arrest pre-filing in `src/lib/legal/prosecution.ts`. Migration
`20260715000002_frontier_expansion.sql`. AD-004 purity discipline holds: all
three libs are I/O-free and unit-tested; routes own persistence.

## AD-012 — The blueprint's chain_tier/parent_claim_id were NOT re-added
`20260714000005` already carries parent_claim_id/chain_role/chain_depth
(chain_depth IS the tier) and sof_events.locked. The frontier migration adds
only `claims.is_locked` (claim-level notarization freeze). Multi-tier ripple
is the existing `createSubClaim` called iteratively per tier by
`/api/v1/claims/[claimId]/ripple`.

## AD-013 — v1 routes live in the App Router, not src/pages
The repo has no pages router; `/api/v1/*` handlers follow the existing
`src/app/api` conventions (apiError sentinels, awaited params, RLS +
explicit company check). M2M telemetry reuses the ERP webhook trust model
verbatim: HMAC over raw body, webhook_logs idempotency (batch-level),
claims upsert on (company_id, external_source='m2m', external_ref).

## AD-014 — Arrest pre-filing is deterministic and HITL-gated, never filed
`prepareArrestPreFiling` is template-based (no AI, no legal conclusions):
eligibility gates (quantum > 0, unsettled, unpaid ≥ grace days), sister-ship
LEADS only (registry proof is counsel's job), cautions for time-bar lapse and
contradicted own evidence. Persisted as drafts kind 'arrest_dossier' +
pending_human_reviews subject 'arrest_dossier'; every dossier embeds the
counsel-review disclaimer.

## AD-015 — Clause-basis multipliers in predictive.ts are ranking heuristics
DAYS_BASIS_EXCLUSION_SHARE approximates SHEX/SSHEX/UU/EIU as calendar-share
multipliers over SHINC-counted hours. Used ONLY to compare scenarios against
each other on identical history — never as an engine substitute. Documented
inline; anything wanting real precision replays the engine (diff.ts pattern).

## AD-016 — Autonomous negotiation agents are deterministic strategy personas (2026-07-14)
The blueprint asked for two LLM agents in a sandbox producing a
"deterministic SettlementMatrix" — those requirements contradict, and money
must not move on sampled text. `src/lib/negotiation/autonomous.ts` implements
the agents as deterministic concession strategies over the sensitivity.ts
agenda (every position is an engine number): evidence verdicts decide items
outright (contradicted event + strike-out finding → forced fact, budget
untouched; corroborated → argument dead), the rest trade cheapest-first,
alternating, ≤ 50 rounds, capped by maxConcessionUsd and hard-stop
categories. Runs persist to autonomous_negotiation_rooms; execution is gated
behind pending_human_reviews subject 'autonomous_settlement'. Triage leans on
sensitivity.ts's stable "struck out" label wording — pinned by a unit test.

## AD-017 — Geofence verdicts are three-state and AIS input is caller-supplied
(The caller-supplied half is amended by AD-020: a track may now be fetched
server-side when the caller has none. The three-state posture below stands.)

`sof_events.ais_geofence_verified` is NULL (never checked) / true / false —
a thin AIS track yields "unverifiable", never a silent pass (matches the
sanctions/AIS honesty posture). The audit routes take the AIS track in the
request body instead of calling AIS_PROVIDER_URL: provider payload shapes
differ (see ais.ts), and a deterministic audit needs deterministic input.
Discrepancies get critical clause_flags with clause_ref 'AIS-GEOFENCE',
replace-on-rerun. NOR gets the wider anchorage fence (WIBON tenders at the
roads legitimately); weather/shifting are not position-bound and stay NULL.

## AD-018 — Eco-speed optimizer prices a FIFO queue, never reads the clock
`src/lib/optimization/ecospeed.ts`: total(v) = sea fuel + at-sea ETS (0.5
coverage) + anchorage waiting (aux fuel @ 100% ETS) + demurrage exposure
beyond laytimeBufferHours + laycan penalty. Congestion model: berth ready at
now + predicted delay, independent of own arrival. `nowISO` is an input
(pure, deterministic); ties go to the slower/greener speed; slow-steaming
recommendations carry a CP-UTMOST-DESPATCH consent caution. Route falls back
to the resilience matview median (k-floor 5) when telemetry has no
congestion figure and records the source in the response.

## AD-019 — eFTI export is owner-initiated and ledgered, not a public node
`/api/v1/interoperability/efti` signs a canonical consignment payload
(sha256; anchored to the latest time_proof Merkle root when one exists) and
ledgers every export as compliance_ledger entry_kind 'efti_export'
(append-only receipt of exactly what left the tenant). Laytime internals
(weather/shifting/hatch/excepted) never export — port-call milestones only.
Token-federated authority access is future work; today the tenant forwards
the signed packet through its own channel.

## AD-020 — Autopilot geofences both ingestion paths; AIS input is now optional (amends AD-017)
AD-017 kept AIS input caller-supplied so the audit stayed deterministic. That
held for the text-ingest route but left the Claude-vision path (scanned PDFs,
`/api/claims/[claimId]/documents`) never geofenced at all: a discrepancy meant
something different depending on how the SoF arrived. Both paths now share
`src/lib/ingestion/geofence-server.ts` (the DB half; `multimodal.ts` stays
pure), so verdicts and AIS-GEOFENCE flags mean one thing.

The determinism concern is answered by pure `normalizeAisTrack` rather than by
refusing to fetch: it maps the known provider spellings (envelope keys,
lat/latitude, epoch s vs ms) and *drops* rows it cannot read, so a garbled
payload yields a thin track ("unverifiable") rather than a confident fix in
the wrong place. `fetchAisTrack` returns null — never [] — when the track
can't be had, keeping "no AIS to check against" distinct from "AIS says the
vessel wasn't there". A caller-supplied track still wins and remains the
deterministic path; `aisHistory` is merely optional now, and an unconfigured
provider answers AIS_UNAVAILABLE (422), never a green all-clear.
Geofencing in extraction is best-effort: it must never fail a good extraction,
so a failure leaves the verdict NULL (never checked), which reads as
unverified in the workspace.

## AD-021 — OCR normalization collapses whitespace but never repairs words
`extractSofTimeline` matches against whitespace-normalized text (nbsp, thin/
zero-width, ideographic spaces; ragged runs) and accepts the hour/minute
separators the wild produces (`14:30`, `1430`, `14.30`, `14h30`), because OCR
noise that hides a real event is a silent failure — the operator gets no
warning that it went missing. Character-level repair of garbled keywords
("BERTHEO" → BERTHED) is deliberately refused: that is a guess, and this
module's whole posture is that a guessed event is worse than a reported gap.
raw_text keeps the verbatim line — the record an arbitrator sees.

## AD-022 — The ROI calculator reports the SHEX swap with its sign, never as a "saving"
The brief asked for "potential savings if SHEX was used instead of SHINC".
On an owner's book there are none: SHEX excludes Sundays/holidays from
laytime, so fewer hours count, so less demurrage is earned. Verified against
the engine on a Sunday-spanning voyage — SHINC 70,833.33 vs SHEX 45,833.33,
i.e. the swap COSTS the owner 25,000. The saving is the charterer's. So
`RoiBasisFinding.deltaNet` preserves the sign (SHEX net − SHINC net, owner's
perspective) instead of abs()'ing it, the tile reads its direction off that
sign, and with no data it says nothing at all rather than defaulting to
"(a saving)" — a default that would promise money that does not exist. A unit
test pins the negative direction so a later "fix" can't quietly invert it.

Disputed weather strikes only the windows an evidence check marks
'contradicted', paired via the exported findPairs() from sensitivity.ts —
reused, not re-implemented, because two pairing rules would give two answers
to "what is this window worth?". Windowing is on the completion anchor (the
same anchor the time bar uses); claims with no confirmed completion count as
outOfWindow rather than vanishing.

## AD-023 — An unpriceable claim still gets a time-bar deadline
buildRoiReport first ran the engine and `continue`d on failure, which dropped
the claim before its time bar was computed — silently hiding the claim most
likely to be forgotten (the one whose numbers don't work). The time bar now
runs independently of pricing: valueAtRisk goes null ("not computable" in the
UI, never a 0 that reads as "nothing at stake") and the claim stays on the
queue. Regression-tested with a voyage past the engine's 1440-iteration cap.
