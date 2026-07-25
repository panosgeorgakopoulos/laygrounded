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

## AD-024 — Grounding is re-verified at publish time, not read off the drafts row
The stored `drafts.grounding` records whether a letter was true when it was
*generated*. A claim is a living record: accepting a proposal or recomputing
leaves a week-old letter quoting a figure the claim no longer says. So
`prepareGroundedLetter` (src/lib/drafting/publish-server.ts) reassembles the
context and re-runs verifyDraftGrounding at the moment of publishing — the
moment that matters — and corrects the stored verdict if it has drifted
(otherwise the workspace keeps badging "VERIFICATION PASSED" on a letter we
just refused to render). Re-verification is a pure function over data already
loaded; being right costs nothing. Both the PDF and send routes go through
this one gate, so a refusal means the same thing whichever door you tried.
DraftNotGroundedError carries the issues → 422 lists which figure drifted.

## AD-025 — CLAUSE_RE could not match its own sub-clause refs (bug fix)
`/\b(?:GENCON94-[\w()]+|ASBA-II-\d+)\b/` truncated the trailing ")" — \b
cannot sit after a non-word character — so a letter correctly citing
GENCON94-7(d) (a ref the engine really emits, and which the demo book
genuinely uses) was looked up as "GENCON94-7(d" and reported as a
hallucinated clause. Latent while grounding was advisory; AD-024 makes it
fatal, since a false positive now blocks legitimate correspondence. Pattern is
now `/\bGENCON94-\w+(?:\(\w+\))?|\bASBA-II-\w+/` — parens as an explicit
optional group. Also fixes ASBA-II-\d+ never matching non-numeric Part II
refs. Regression-tested both directions (real ref passes, fake ref still
caught, and the issue now quotes the full ref).

## AD-026 — Delivery refuses rather than simulates (departs from banking.ts)
settlement/banking.ts returns a clearly-labeled *simulated* clearing when no
provider is set. delivery.ts deliberately does NOT follow that precedent: a
simulated clearing is a useful demo, whereas a simulated send would tell an
operator the charterer has their demand letter when it is sitting in nobody's
inbox — and time bars run on that belief. With no EMAIL_PROVIDER_API_KEY /
EMAIL_FROM_ADDRESS it reports sent:false / not_configured, and the route
answers 503 DELIVERY_UNAVAILABLE (the letter is valid; the channel isn't
there) pointing the operator at the PDF. Sending also requires an explicit
`confirm: true` per request — no default — because it is an outward-facing
legal act that must never be the by-product of a mis-click or a replay.

## AD-027 — The letter renderer paginates; the claim-pack exporter does not
export.ts's generatePDF adds exactly one page and lets overflow run off the
bottom (pre-existing; long claim packs silently lose content). A letter is
prose, so drafting/pdf.ts owns a Cursor that starts a new page when it runs
out of vertical space, reserving room for the footer. It reuses export.ts's
loadPdfFonts (now exported) rather than growing a second font story. NB those
Roboto TTFs in public/fonts are 14-byte "404: Not Found" placeholders, so the
WinAnsi fallback is the path that actually runs and non-ASCII renders as "?";
dropping real TTFs in fixes both consumers with no code change. Only the
letter body is model text — the reference block, calculation and timeline are
read straight off DraftContext, so they cannot drift whatever the model wrote.

## AD-028 — The MRV report emits the format but refuses to fabricate it
The brief asked for "exact EU ETS carbon allowance liabilities per voyage" and
a "verified EU MRV annual report ... audit-proof for European regulators".
None of those three claims survives contact with the data. Reg (EU) 2015/757
reports per-voyage FUEL CONSUMPTION measured by an Annex I Part B method (BDN
+ tank stocktakes, tank monitoring, flow meters, direct CO2). This system
holds no bunker data, no gross tonnage, no cargo mass, no voyage distance —
only laytime events and ets.ts's ASSUMED 4 t/day at-berth burn, whose own
header calls it "not a verified MRV figure". Filling MRV fields from that
assumption would put un-measured numbers in a regulatory format, and
misreporting under MRV/ETS carries penalties for the operator relying on it.

So mrv.ts emits the real Annex I/II structure with one rule: a fuel or CO2
figure appears ONLY where measured bunker data was supplied (with its
monitoring method — an unattributed number is not monitoring data). Every
other field reports NOT MONITORED, never 0 and never an estimate. Aggregates
stay null unless EVERY voyage in the period is measured: a total over the
measured subset reads as the period's emissions and understates them by
exactly the unmonitored part. `submittable` is false until all gaps close —
and stays false even with full bunker data, because the monitoring plan and
ship particulars are out of scope, which the report says. It is a map of the
distance to a submittable report, not a substitute for one.

`verification.status` is hard-coded "unverified" with no code path to change
it, and mrv_reports.verification_status carries a CHECK pinning it — so not
even a future bug can self-certify a report into the database (dry-run
confirmed the CHECK rejects 'verified'). Only an accredited verifier can
verify, via THETIS-MRV.

## AD-029 — Sealing is integrity, not verification, and not audit-proofing
The Merkle seal (sealMrvReport) proves the report has not been altered since
`asOf`, and mrvVoyageProof discloses one port call to a counterparty without
revealing the rest of the book. That is all it does. It says nothing about
whether a figure was measured — an unmonitored field seals exactly as well as
a monitored one; sealing an unmonitored report yields tamper-evident proof
that it is unmonitored. No cryptography makes a report audit-proof for
regulators; an accredited verifier does. The seal restates
verificationStatus/submittable inside itself so a detached root can never be
waved as proof of a verified report.

Leaves hash via prosecution.ts's leafMaterial (now exported, `kind` widened to
string, format byte-identical so existing notarized roots stay valid) — one
hashing convention across both sealed artifacts, or an auditor could not
re-verify one with the other's method.

## AD-030 — MRV reports get their own table; seals append, never replace
compliance_ledger is claim-scoped (claim_id NOT NULL) and its entry_kind CHECK
is claim-level carbon findings; an annual report spans a company's whole book
for a period. Hence `mrv_reports` (20260716000001). Append-only, departing
from the replace-on-rerun pattern used for evidence/compliance snapshots: each
row is a seal of what the book looked like at that instant, and replacing it
destroys the proof that the earlier state existed — the only thing a seal is
for. Read latest by (company_id, reporting_period, sealed_at DESC).

EEA scope reuses `claims.ets_applicable` rather than adding a second input for
the same judgement. It is nullable and unset by default; null means unknown
and the report declines to assert scope either way — "Port Hedland, AU" is
free text and nothing derives that it isn't an EEA call. NB computeEtsEstimate
does NOT gate on it: it applies COVERAGE_PCT 1.0 unconditionally, so an ETS
estimate for a non-EEA port call would be asserted at full EU coverage. The
MRV module does not inherit that behaviour.

## AD-031 — Anchoring: RFC 3161 is the real path; EBSI refuses rather than fakes
The notary proves record INTEGRITY but not TIME: the snapshot's `asOf` is
asserted by LayGrounded, so nothing in the ledger stops a backdated root and
an auditor must trust our clock. Anchoring closes exactly that gap.

EBSI was asked for and is deliberately NOT implemented. It is a permissioned
network: writing requires onboarding as a participant, a DID in the EBSI
registry, and accreditation via the European Blockchain Partnership. We hold
no credentials and would be inventing endpoint shapes; a fabricated "anchored
on EBSI" claim is fabricated legal evidence — the worst failure available to
this product. ANCHOR_PROVIDER=ebsi returns unsupported with the onboarding
requirements spelled out and points at rfc3161.

RFC 3161 (`ANCHOR_PROVIDER=rfc3161`, `TSA_URL`) is implemented and works. From
a QTSP under eIDAS a qualified electronic time stamp carries a legal
presumption as to date and time across the EU — stronger evidence in a
charterparty dispute than an unqualified chain entry, and no onboarding. No
ASN.1 dependency: anchor.ts encodes TimeStampReq and reads PKIStatusInfo
directly (~120 lines). Verified against OpenSSL 3.6.2 — our TimeStampReq is
byte-identical to `openssl ts -query` (golden vectors pinned in
anchor.test.ts), and a live freetsa.org round trip returned status 0 with a
4634-byte token whose signed imprint equalled the submitted root exactly.

We deliberately do NOT parse TSTInfo to extract genTime: that means parsing
CMS SignedData, and a half-right parser would let us *assert* a signed time we
had not verified. The token is stored whole (base64) and the dossier gives the
`openssl ts -verify` recipe — verification never routes through us.

## AD-032 — Hourly cadence, but proofs only on content CHANGE
The sweep runs hourly; it writes a proof only when the record changed. Caught
by running the sweep twice against the live DB: dedupe on the Merkle root can
NEVER fire, because generateCryptographicSnapshot embeds as_of in its header
leaf, so the root differs every pass even on an untouched claim. Unfixed, the
hourly sweep writes 24 substantively-identical proofs per claim per day and
spends a TSA request on each. `contentHashOf()` hashes cpTerms/totals/
breakdown/events/clauseFlags — the record, not the instant we looked — and is
stored in details.content_hash; the next sweep compares that. Pinned by a test
asserting the content hash is stable across as-of times while the root is not.

Dedupe costs nothing evidentially: unchanged root ⇒ unchanged record ⇒ the
previous proof already covers every instant since. So "state at 14:00" is
answered by proofAsOf() taking the latest proof at or before 14:00. It never
falls forward to a later proof (that would attest a state which did not exist
at the instant asked about) — no proof at or before ⇒ 404 NO_PROOF_AS_OF.
Proofs written before this change carry no content_hash and never dedupe,
erring toward writing rather than skipping a real change.

## AD-033 — The dossier states what the proof does NOT establish
buildAuditDossier already covered the fingerprint, leaf inventory and manual
re-verification. /api/v1/claims/[id]/dossier adds the anchor section, and when
there is no anchor it says so in those words: integrity yes, time no, the
as-of rests on LayGrounded's clock, and a relying party is trusting our good
faith. `independentlyTimestamped` is an explicit boolean in the JSON rather
than something a client infers from anchor===null.

## AD-034 — Audit API quotas are per KEY, in Postgres, and fail closed
src/middleware.ts limits by IP in an in-memory Map: per-instance (N instances
⇒ N× the limit), reset on cold start, and keyed on the wrong subject — an ERP
behind NAT is one IP for many tenants, one tenant may call from many. A
contractual quota cannot rest on that. api_rate_limits + the
consume_api_rate_limit() SECURITY DEFINER function give a shared, per-key
counter; INSERT … ON CONFLICT DO UPDATE … RETURNING is one statement, so
concurrent requests across instances cannot both read the same count and both
decide they are under quota (an application-side read-then-write would).
Verified by dry-run: 1,2,3 allowed at limit 3, 4th refused, next window resets.

Fixed window (one row per key per clock minute), so a caller can burst to 2×
across a boundary. Stated in the OpenAPI description rather than hidden — a
sliding window is the fix if that ever matters.

Fails CLOSED: if the limiter errors we cannot know whether the request is
within quota, and an API that stops limiting under database trouble is what
turns a hammering client into an outage. 429 RATE_LIMIT_UNAVAILABLE.

The middleware IP ceiling had to be raised for /api/v1/audit (2000/min, its
own bucket): at 100/min a key licensed for more would be silently capped and
the quota would be a lie. It remains as a crude anti-flood net for the
unauthenticated case — bad keys are rejected on shape before any DB hit.

## AD-035 — Pushed events are 'suggested'; key management is session-only
A voyage push lands events as status 'suggested', following the SoF ingestion
route's precedent verbatim ("zero-touch data entry, not zero-touch trust").
Load-bearing: confirmed events are what the time bar anchors to and what the
notary and the MRV report treat as evidence. An event no human reviewed must
not acquire that standing merely by arriving over an API. The push response
says so, and the OpenAPI description says so, because an integrator who learns
it in production learns it expensively.

Keys are minted only through a SESSION-authenticated route: you cannot
bootstrap the first key with a key, and a leaked integration key must not be
able to mint more or widen its own scope. Revoke ≠ delete — the row is the
record of what that credential could do and when it was last used, which is
exactly what you want after a leak. Scopes are granted explicitly (no default,
no wildcard); scope failure is 403 naming the scope, while unknown/revoked/
expired/malformed keys are all an identical opaque 401 so the endpoint is not
an oracle for which keys exist. SHA-256 not bcrypt: 192-bit random tokens have
no dictionary to slow, and this path runs on every request.

## AD-036 — The OpenAPI document is generated, and an external validator gates it
buildOpenApiSpec() derives from API_SCOPES, TIME_BAR_EVENTS and
EVENT_TYPE_VALUES, so the document cannot describe a scope or event the code
does not have; tests assert exactly that. Hand-written YAML drifts the first
time a scope is added and nobody notices.

Generating it is not enough. `redocly lint` found 4 errors our own structural
tests passed happily: the spec declared openapi 3.1.0 while using 3.0's
`nullable` keyword, which JSON Schema 2020-12 removed — generated clients
would mis-handle precisely the fields whose null carries meaning (calculation:
null means "not computed", not "nothing owed"). Now type unions, with a test
asserting `nullable` never appears. Remaining redocly warning: info.license —
left alone deliberately, since the repo declares no license and inventing
legal metadata about the product is not ours to do.

## AD-037 — The audit trail is append-only by RLS, not by convention
security_events has a SELECT policy and NO insert/update/delete policy at all.
With RLS enabled, an absent policy denies — so `authenticated` and `anon`
cannot write the table through PostgREST even though Supabase grants them
table privileges by default. The only writer is append_security_event() under
the service role, whose EXECUTE is revoked from public/anon/authenticated.

Verified on Postgres 17, not assumed: a member of the company whose JWT
matches company_id can SELECT all rows and gets `UPDATE 0` / `DELETE 0` on
them. The subject of the trail cannot edit the trail. That is the whole
property — an audit log its subject can rewrite is decoration.

Read is open to every member rather than admins only. Seeing what happened in
your own tenant is not privilege escalation, and a trail readable only by the
person most likely to be investigated is worth less.

## AD-038 — Hash-chaining, and what it does NOT prove
Each entry commits to its predecessor: sha256(seq ‖ prev_hash ‖ body), per
company, serialised under a per-company advisory lock so concurrent appends
cannot fork the chain. Editing any stored field or removing a middle row
breaks every hash after it. All three cases were exercised against a live
database — amount rewritten (metadata_mismatch), metadata_hash patched to
cover it up (hash_mismatch), row deleted (sequence_gap + prev_hash_mismatch).

Honest limits, stated in the API response rather than buried: truncating the
chain from its END leaves a shorter but internally consistent chain, so
verification reports `headHash` for external pinning (the RFC-3161 notary in
src/lib/legal/ already anchors fingerprints); and a page of recent entries
reports `anchored: false`, because a window that does not start at seq 1
vouches only for itself.

Metadata is hashed INDIRECTLY, via a stored metadata_hash, rather than folded
into the entry hash. Postgres jsonb does not preserve key order, so a
round-trip difference could otherwise masquerade as a broken chain; splitting
them keeps "the payload changed" and "the chain is broken" distinguishable.
Confirmed live: jsonb returned the keys reordered and verification still
passed.

## AD-039 — The formatting lives in TypeScript; SQL only does what it alone can
append_security_event() receives the canonical body as text and prepends just
seq and prev_hash — the two values only the database can assign atomically.
Every format-sensitive decision (timestamp spelling, canonical JSON, null
handling) happens once, in unit-tested TypeScript. Two implementations of a
hash that must agree byte-for-byte is a standing bug source; this shrinks the
agreement surface to a bigint and a hex string.

Parity was proven against Postgres 17 rather than reasoned about: entries
written through the function, read back with a plain SELECT, and verified by
the TypeScript verifier — including unicode, apostrophes and reordered jsonb.
The chain uses the BUILT-IN sha256(bytea), so the migration has no pgcrypto
dependency to fail on.

## AD-040 — Denied attempts are recorded, and one write is fail-closed
Most audit writes are best-effort: refusing to do the work because the log is
unavailable is usually worse than the missing line. Two are `critical` and
propagate AUDIT_WRITE_FAILED (503) — clearing settlement funds and issuing an
API key. Both create something that outlives the request (money moved, a
credential exists), and both are idempotent underneath (UNIQUE claim_id on
settlements), so a retry reconciles rather than double-paying. That is what
makes failing loudly the safe choice there and the wrong one elsewhere.

Refusals are logged too — a claim reached for that the company cannot see, a
non-admin trying to remove a colleague. RLS means "belongs to another tenant"
and "does not exist" are indistinguishable without a service-role lookup on
every miss, so the entry records the fact and does not speculate. Secrets are
scrubbed before storage (SENSITIVE_KEY regex with an allowlist for the
deliberately non-secret keyPrefix/_id/hash names): an audit row every member
can read is no place for a webhook secret, and the room-share token — the
credential itself — is never written at all.

## AD-041 — The CSP allowlist was measured in a browser, not predicted
Every source in the policy traces to something found by reading the code or
watching the app run, and two of them would have been missed by reasoning
alone:

- `img-src` must include the Supabase origin. document-viewer.tsx renders a
  NON-PDF document straight from its signed URL (`<img src={documentUrl}>`);
  omitting the origin breaks viewing every uploaded JPEG/PNG SoF while PDFs
  keep working — a failure nobody would attribute to a header.
- `script-src 'wasm-unsafe-eval'` is required. A violation report showed
  WebAssembly being refused on the claim workspace. pdfjs-dist 6.x decodes
  scanned pages with WASM codecs (jbig2.wasm, openjpeg.wasm) — exactly the
  formats a scanned Statement of Facts arrives in. Text-layer PDFs render
  without it and scanned ones silently fail, which is the worst kind of bug
  for this product. `'wasm-unsafe-eval'` permits WebAssembly compilation only
  and does NOT re-enable eval(), so it is strictly better than 'unsafe-eval'.

What did NOT need allowlisting, because it was checked rather than assumed:
next/font/google self-hosts at build time (no Google origin); @vercel/analytics
loads /_vercel/insights/script.js same-origin in production (its console
warning on this deployment is a 404 — not on Vercel — not a CSP block); no
Supabase Realtime channel is ever opened, so no wss: source.

Verified in Chrome against a production build across /, /pricing, /sign-in,
/claims, the claim workspace, /compliance, /simulator, /analytics and
/settings: zero violations from application code, and the PDF viewer rendered
2 pages as data: URLs through the same-origin worker.

## AD-042 — script-src keeps 'unsafe-inline', and that is a stated limit
Next.js ships hydration state in inline <script> tags and this app is largely
statically prerendered; a per-request nonce cannot be embedded in a
prerendered page, so nonces would force the whole app into dynamic rendering.
That is an architecture change to measure, not a header tweak, and it is
recorded here as a decision rather than left as an oversight.

What the directive still buys is real: no script from any other origin can
execute, closing CDN compromise and injected-<script src> vectors. The
residual XSS exposure is also small in this app — React escapes by default and
there is no dangerouslySetInnerHTML anywhere. The higher-value control for
this threat model is `connect-src`, which is tight ('self' + Supabase only)
and is what stops exfiltration of claim data to an attacker's host.

## AD-043 — A CSP needs a violation channel, or it fails silently
CSP failures are invisible server-side: the browser refuses a resource and the
user sees an empty panel. Every policy therefore ships with
`report-uri /api/security/csp-report`, a deliberately unauthenticated
collector (browsers post reports without credentials, and a report that needed
a session would never arrive from the sign-in page). Being a public write
endpoint, it is treated as hostile input: 8 KB body cap before parsing, only
known fields read and truncated, nothing persisted or echoed, always 204 so it
cannot be used as an oracle. It accepts both the legacy `{"csp-report":{…}}`
and Reporting-API array shapes.

This paid for itself immediately — the collector caught the WebAssembly
refusal that the extension's console hook never surfaced, because CSP
violations are browser-level events rather than console.* calls. CSP_REPORT_ONLY=1
sends the identical policy as Content-Security-Policy-Report-Only for a
watch-first rollout in a new environment.

## AD-044 — pdf.js runtime assets are generated, not vendored by hand
pdf.js does not bundle its character maps, standard fonts or WASM image
decoders. They are fetched at runtime from caller-supplied paths, and
cMapUrl / standardFontDataUrl / wasmUrl ALL default to null. pdf.js only
complains when a document actually needs one, which is what made this
invisible: text-layer PDFs render perfectly and scanned or CJK ones throw
"Ensure that the `wasmUrl` API parameter is provided."

That is the wrong way round for this product. A Statement of Facts emailed by
a port agent is typically a SCAN — JBIG2 or JPEG2000 — and dry bulk voyages
call at CN/JP/KR ports whose PDFs need CJK cmaps. Both the workspace viewer
and, more seriously, the server-side extraction pipeline (which would have
rasterised blank pages and then run the model against them) were affected.

scripts/sync-pdfjs-assets.ts copies wasm/, cmaps/ and standard_fonts/ out of
the installed pdfjs-dist into public/pdfjs/ on every `bun run dev` and
`bun run build`; public/pdfjs is gitignored. Committing the binaries instead
is how a vendored copy drifts from the installed library — the pre-existing
hand-vendored public/pdf.worker.min.mjs is exactly that risk, so the script
refreshes it in place too and prints a notice when it changed.

## AD-045 — The browser and Node halves resolve differently, so they are separate modules
DOMBinaryDataFactory fetches assets over HTTP; NodeBinaryDataFactory calls
fs.readFile on the same string. A URL handed to the server fails at read time,
so pdfjsClientAssets() (URL paths) and pdfjsServerAssets() (absolute
filesystem paths) are deliberately not one shared constant. Both append a
trailing slash because pdf.js concatenates the filename directly and throws
"Invalid factory url" without one.

assets.ts must stay free of node: imports — it is pulled into a client
component, and importing node:fs there fails the Turbopack client build (it
did). The filesystem half is assets-server.ts, matching the -server suffix
convention already used by recompute-server.ts and friends.

pdfjsServerAssets() returns NULL rather than a guessed path when the tree is
absent: the caller spreads it into getDocument, so a missing tree leaves
behaviour exactly as it was (text PDFs keep working) instead of failing every
document with an ENOENT. It warns, because a silent degrade is what created
this bug in the first place.

Verified: all three paths resolve with trailing slashes, the specific files
pdf.js requests return 200 with correct sizes over HTTP, getDocument accepts
the server paths and rendered a corpus PDF (59 text items), and the workspace
viewer still renders 2 pages under the CSP. NOT verified end to end: an actual
JBIG2/JPEG2000 scan — no such fixture exists in the repo. The corpus generator
emits text-layer PDFs only, which is itself worth fixing if scanned-document
handling is to be tested rather than reasoned about.

## AD-046 — The onboarding engine existed for a year of commits with no way in
parseFixtureRecap() and POST /api/v1/onboard were built, unit-tested and
session-authenticated, and reachable only by a machine: the sole mention in
the UI was a line of M2M reference text in the developer settings tab. A
capability nobody can reach is not a feature. RecapOnboarding now sits at the
TOP of /claims/new, above the manual form, because a user arriving to create a
claim usually already holds a recap and retyping it into a form is work the
parser can do.

The card states what it does not do, deliberately: no LLM call. The parser is
regex, so onboarding is instant, free, reproducible and works with zero AI
quota — which is what lets it be the first thing a prospect touches, and why
it kept working through the period when gemini-2.5-pro returned 429s.

Every field the parser missed is listed with the default it fell back to,
before the user reaches a calculation. A demurrage figure resting on a
silently-guessed laytime allowance is worse than no figure — the same
principle as AD-022/AD-028.

## AD-047 — Driving the feature found a parser gap that unit tests did not
The recap "MV ARCTIC HORIZON / VR-2024-0336" parsed the vessel and reported
voyage ref as fallen-back-to-default. A voyage reference sharing the vessel's
line after a slash is at least as common in real recaps as a labelled
VOYAGE: line, and the fixture the tests used happened to have the labelled
form — so the suite was green and the product was wrong.

The fallback requires a letters-then-digit shape, which is what makes it safe:
the other things following a slash in a recap are cargo quantities
("/ 54,000 MT", starts with a digit) and prose ("/ despatch half demurrage",
never reaches a digit), and "M/V" fails for the same reason. All three are
pinned as negative tests, plus one asserting a labelled VOYAGE: still wins.

Recurring lesson, now several times over (AD-025, the notary dedupe, the
OpenAPI 3.1/nullable mismatch): my tests agree with my assumptions. Running
the actual feature is what disagrees.

## AD-048 — LayGrounded is its own OAuth authorization server, because Supabase can't be
The MCP endpoint needs OAuth 2.1 so an operator can connect an AI client to
their own book without pasting a long-lived key into it. Supabase Auth cannot
be that authorization server: it has no dynamic client registration (RFC 7591)
and does not mint audience-bound tokens for arbitrary third-party clients. So
the split is — Supabase authenticates the HUMAN (the existing session), and
this layer issues the CLIENT's token on top of that session. The token acts as
one user inside one company, so every existing RLS predicate keeps working
unchanged; that is the whole reason for company_id living on the token rows.

Two discovery documents, built by one module (src/lib/oauth/metadata.ts):
RFC 9728 protected-resource ("who guards me") and RFC 8414 authorization-server
("how to get a token"). Both routes use an OPTIONAL CATCH-ALL [[...suffix]]
because RFC 9728 locates the resource document by INSERTING the well-known
segment before the resource path (/.well-known/oauth-protected-resource/api/mcp),
while other clients probe the bare path — serving only one is a common
discovery-404 that surfaces to the user as an unexplained login failure. Both
verified live at both path forms.

## AD-049 — The issuer is configured, never taken from the Host header
resolveIssuer() prefers OAUTH_ISSUER_URL / NEXTAUTH_URL and falls back to the
request origin ONLY when nothing is configured (local dev). Deriving the issuer
from the request alone would let anyone who can reach the app with a forged
Host publish metadata whose authorization_endpoint points at a server they
control — and any client that follows discovery would send its user there to
log in. Behind a proxy the Host header is attacker-influenced, so it is the
last resort. Pinned by a test that feeds a hostile request URL and asserts the
configured issuer wins; verified live with `curl -H "Host: evil.example.com"`.

## AD-050 — OAuth 2.1 constraints live in CHECK/UNIQUE/FK, not just app code
The database refuses the unsafe states rather than trusting every code path to
validate them (verified on Postgres 17):
  - code_challenge_method CHECK (= 'S256') — 'plain' is refused at insert, so
    a PKCE downgrade cannot be persisted. 'plain' makes the challenge equal to
    the verifier, i.e. no protection against anyone who sees the auth request.
  - code_hash / token_hash UNIQUE — tokens and codes are stored ONLY as
    SHA-256 hashes (same reasoning as api_keys, AD-035: high-entropy randoms,
    not passwords, and this path runs per request so a KDF is a self-DoS). A DB
    leak yields no redeemable credential.
  - redirect_uris NOT NULL + cardinality > 0, exact-match array — OAuth 2.1
    forbids wildcard/prefix redirect matching, the classic open-redirect →
    code-theft → account-takeover chain.
  - refresh tokens carry family_id + consumed_at for rotation WITH reuse
    detection: presenting a consumed refresh token means two parties hold it,
    so the whole family is revoked. Rotation without reuse detection just means
    a stolen token works once.
The metadata advertises exactly these limits (S256 only; code response type
only; no implicit/password/client_credentials grant; bearer in header only),
so "PKCE required, no legacy flows" is machine-readable, not a README line.
18 metadata tests pin them.

## AD-051 — The OAuth tables are service-role only, except a user's own consents
RLS on with no policy denies by default (the security_events mechanism,
AD-037). Verified on PG17: a logged-in `authenticated` role sees 0 rows in
oauth_clients / _authorization_codes / _access_tokens / _refresh_tokens, cannot
INSERT a forged token (permission denied), and cannot EXECUTE the purge
function — while reading exactly 1 row from oauth_consents, its own. Consents
are split out from the token tables precisely so "which AI clients can reach my
claims" is one user-readable row rather than an archaeology exercise; the read
is SELECT-only, because revocation must go through a route that also kills the
tokens.

## AD-052 — The OAuth flow endpoints, and where each security property lives
Five endpoints complete the authorization server the metadata advertised:
/oauth/register (RFC 7591), /oauth/authorize (+ /decision), /oauth/token,
/oauth/revoke, and the /api/mcp transport. The security lives in three pure,
unit-tested modules, and the routes are thin adapters over them:
  - tokens.ts — credential generation (256-bit random, SHA-256 stored, prefixed),
    constant-time compare, and PKCE S256 (verifyPkce; 'plain' cannot pass).
  - store.ts — the DB state machine: single-use codes with replay→descendant
    revocation, refresh rotation with reuse→family revocation, scope that only
    ever narrows. Every function takes an injected client so the whole flow is
    integration-testable.
  - authorize.ts — the fatal-vs-redirectable error split.
Verified end-to-end against Postgres 17 (18/18): PKCE reject, redirect
mismatch, code replay, audience mismatch, forged token, refresh reuse →
family kill, revocation — plus the MCP tools returning company-scoped data.

## AD-053 — /oauth/authorize: fatal errors are shown, never redirected
The one rule that makes an authorize endpoint safe. A bad client_id or an
unregistered redirect_uri renders an error page; redirecting an UNVALIDATED
uri is exactly how the code reaches an attacker. Only after the redirect
target is proven on the client's exact allowlist do other errors
(unsupported_response_type, missing PKCE, invalid_scope) bounce back to it
with state. The /decision handler RE-derives all of this from the DB and
session — the hidden form fields are untrusted, the code is minted for the
logged-in user's own id/company, and the Supabase SameSite cookie makes the
approval un-forgeable cross-origin. Consent grant/deny both write to the
security_events trail (AD-037). Also taught the sign-in form a `next` param
with a path-only open-redirect guard, so a signed-out user returns to consent.

## AD-054 — /api/mcp: the 401 IS the discovery trigger
An unauthenticated call returns 401 with
WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"
— the RFC 9728 breadcrumb that starts the whole OAuth dance, so a tokenless
request is the first step, not a dead end. This is why the discovery routes
and this 401 must agree on the resource URL (both derive it from resolveIssuer
+ MCP_ENDPOINT_PATH). bearer.ts is the boundary: SHA-256 hash lookup, live
check, audience binding (a token minted for another MCP server the user also
authorized is refused here), returning a company-scoped caller every tool is
confined to. Tools (mcp.ts, JSON-RPC 2.0) thread companyId from the TOKEN, not
from tool input, so a tool cannot forget to scope. Per-tool scope enforcement
returns an isError result (not a transport error) so the model relays it.
Known follow-ups: /oauth/* token/register/revoke are NOT under the /api proxy
matcher so they miss its per-IP flood limit (client_secret is 256-bit and codes
single-use, so low risk — but worth adding); browser-origin MCP clients would
need CORS on /api/mcp (native clients don't).
