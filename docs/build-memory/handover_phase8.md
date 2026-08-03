# Phase 8 — wrap-up and handover

State of `main` after Phase 8: **Engine v2 & Counterparty Finance**. Two pieces
of work that look unrelated and share one discipline — *never invent, never
silently re-version*.

Read with `handover_phase7.md` (integrations, outbox, settlement payloads) and
`handover_phase6.md` (engine, ETS, terminal attribution).

---

## 1. Read this first

The three rules from Phase 6/7 held again, and a fourth earned its place:

- **Judge shipped-ness by grepping `src/`.** `src/lib/settlement/banking.ts`
  already existed and is *not* what this phase needed — it clears settlements
  through a provider webhook. The gap was party *identity*, not clearing.
- **Judge applied-ness from the catalog.** Both migrations verified with
  `pg_constraint` / `pg_indexes` / `pg_policies` after applying, and then
  probed live (§5).
- **Prefer an independent check to a self-written test.** This phase's single
  highest-yield decision: see §4.
- **NEW — a published number is a promise, not an observation.** The conformance
  root is cited in a README and in documents. It is now pinned in three places
  that fail the build rather than report a new value.

---

## 2. What Phase 8 shipped

### Part 1 — Engine v2 (the GENCON 94 + SHINC defect)

| Piece | Where |
|---|---|
| Two rule sets in one engine | `packages/laytime-core/src/gencon94.ts` |
| `EngineVersion`, `resolveEngineVersion` | `packages/laytime-core/src/types.ts` |
| Version-aware behavioural fingerprint | `packages/laytime-core/src/fingerprint.ts` |
| The "absence means 1" rule, in one place | `src/lib/laytime/engine-version.ts` |
| v2 corpus (500 cases) | `synthetic-corpus-v2/` |
| v2-only archetypes | `V2_ONLY_ARCHETYPES` in `scripts/synthetic-claims/scenarios.ts` |
| Root pinning + differential proof | `packages/laytime-verify/src/conformance-roots.test.ts` |

**The defect.** Under GENCON 94 with a SHINC days basis, an explicitly agreed
`EXCEPTED_PERIOD` was absorbed by the "Sundays and holidays included" branch and
never deducted. SHINC deletes the *weekend* exception; it says nothing about
exceptions the parties agreed on that voyage (Cl. 7(c)). Deferred since Phase 6
because fixing it changes engine output.

**The fix is one branch.** Every other form × basis was probed and deducts
correctly, so v2 changes the SHINC branch *alone*. A versioned engine has to
justify each divergence separately, and "while we were in here" is not a
justification.

**Numbers that matter:**

| | Value |
|---|---|
| v1 conformance root | `bc9f24fdab910a1b` — **unchanged** |
| v2 conformance root | `261e3468d2246f30` |
| v1 corpus case files after the engine change | 500 / 500 **byte-identical** |
| v1's 500 published cases that diverge under v2 | **0** |
| v2 corpus cases that diverge from v1 | **44**, all in the two SHINC archetypes |
| v2 cases identical across rule sets | **456** |
| Money moved across the 44 | $243,583.35 |

The 0 is not an accident: `exceptedPeriod` in `scenarios.ts` pins `days_basis:
"SHEX"` with a comment saying SHINC could not express the correct answer. The
corpus was written *around* the defect, which is why the new archetypes had to
be new — under rule set 1 their `feature` predicates are unsatisfiable and the
generator refuses to emit a case at all. That refusal is the cleanest statement
of the bug available.

### Part 2 — Counterparty finance

| Piece | Where |
|---|---|
| Validation + normalisation (pure) | `src/lib/settlement/counterparty-finance.ts` |
| DB bridge | `src/lib/settlement/counterparty-finance-server.ts` |
| Hydration into the payload | `src/lib/settlement/escrow-server.ts` |
| Tenant CRUD | `POST/GET/DELETE /api/settlement/counterparty-finance` |
| Independent IBAN fixtures | `scripts/settlement/build-iban-fixtures.py` |

Closes Phase 7 gap #8. `escrow-server.ts` previously emitted every party with a
null IBAN, BIC and wallet: the payload was correct and unactionable.

Details in `src/lib/settlement/CLAUDE.md`. The load-bearing decisions:

- **Loading a stored fact is not inventing a derived one.** Terminal shortfall
  and carbon stay caller-supplied because their *value* depends on a live price
  or an unreviewed computation. An IBAN is a fact somebody typed in and a
  checksum validated. Absent details still stay absent.
- **`legal_name` is not the match key.** `party_key` is the normalised name;
  `legal_name` is the account holder as the bank knows them.
- **A wallet requires a `chain_id`** (DB CHECK). The same 20 bytes exist on every
  EVM chain and mean a different account on each.
- **Two parties on different chains blocks**, exactly as mixed currencies split
  into separate legs — bridging is a custody decision nobody made.
- **EIP-55 checksums are still not verified.** That needs keccak-256, and the
  Phase 7 decision not to hand-roll one stands.

---

## 3. The architectural decision that matters most

**`claims.engine_version` is the authority; `cp_terms.engine_version` is the
transport — and v1 is written as ABSENCE.**

Three properties fall out of that, and all three were verified rather than
assumed:

1. **No call-site churn.** The version rides on `CpTerms`, so all ~30
   `recomputeLaytime` callers route correctly without a signature change.
2. **Bundles are self-describing.** The verifier receives the rule set with the
   claim. A bundle that did not say which rules produced it could not be
   independently checked at all.
3. **Nothing historical moves.** `cp_terms` is a leaf in the notarised Merkle
   snapshot. Writing `engine_version: 1` onto a legacy claim would change that
   leaf, change the root, and break every RFC-3161 token anchored over it. So v1
   claims come back byte-identical to what is stored.

The column exists because `cp_terms` is user-editable jsonb reachable from
several routes: a PATCH that dropped the key would silently move a claim back to
v1, changing money on a claim that may already have been served.

`engineFingerprint()` is now **per rule set**. Two engines that compute different
money must not share a fingerprint — and v2's canaries had to be built carefully
(§5) so its fingerprint differs *behaviourally* and not merely by a label.

---

## 4. The independent check that paid

`isValidIban` was cross-checked against **`python-stdnum`** — its IBAN registry
and its own ISO 13616 MOD-97-10 implementation — over 1,190 generated cases,
rather than against expectations written by whoever wrote the validator.

Two findings, neither of which a hand-written test would have produced:

1. **FK (Falkland Islands) was missing from the length table.** Added to the
   registry in 2023. A valid Falklands IBAN would have been rejected outright.
2. **Five corrupted strings passed MOD-97 with check digits `00`.** MOD-97 has a
   ~1/97 false-accept rate on corrupted input, and some of those land on `00`.
   ISO 13616-1 puts the check digits in **02–98**, so no legitimate IBAN can
   have them. We now enforce that range and are **deliberately stricter than
   stdnum**, which does not.

The cross-check also flagged BE/ES/ME/NO, where stdnum applies an extra
*national* BBAN check we do not implement. Recorded in
`nationalCheckCountries` rather than quietly skipped — a reader needs to know a
valid-looking Belgian IBAN passes here on ISO grounds alone.

`scripts/settlement/build-iban-fixtures.py` regenerates the fixtures; it needs
`pip install python-stdnum` and is not part of the test run.

---

## 5. Traps already paid for this phase

- **A fingerprint canary that never reaches the branch under test proves
  nothing.** The v2 canaries initially inherited `laytime_allowed_hours: 48`,
  which this canary voyage exhausts *before* the excepted period begins — and
  once on demurrage, Cl. 8 counts every hour regardless. The material was
  byte-identical to v1's apart from a `rules|2` label, i.e. the fingerprint
  asserted a difference it could not actually see. Caught only because
  `engine-version.test.ts` asserts on canary *content*, not on the two strings
  merely differing.
- **"Once on demurrage, always on demurrage" must survive the fix.** An agreed
  exception does not interrupt Cl. 8. Pinned by a test, because the natural
  instinct when fixing a Cl. 7 deduction is to make it apply everywhere.
- **Adding an archetype renumbers the whole corpus.** Allocation is proportional
  to weight across the entire list, so any addition to `ARCHETYPES` moves all 500
  case ids and the published root with them. Hence a separate `ARCHETYPES_V2`.
- **`--no-pdf` deletes the committed PDFs.** `main()` removes `sofs/`
  unconditionally and only recreates it when PDFs are enabled. Regenerating v1
  for a byte-comparison must go to a scratch `--out`, never over the real corpus.
- **The corpus PDFs are NOT byte-reproducible; the case JSONs are.** A full v1
  regeneration produces 500 identical case files and 500 differing PDFs. The
  skill only ever claimed determinism for the JSONs, so this is not a broken
  promise — but it does mean a routine regen would churn 2 MB of binary for
  nothing. `synthetic-corpus/manifest.json` was refreshed on its own (the
  `engineSha256` it carried was stale the moment `gencon94.ts` changed, and a
  stale digest that looks like provenance is worse than none).
- **A `text[] := '{}'` concat in a `DO` block fails with 22P02**, and `RAISE
  NOTICE` is invisible through `execute_sql` anyway (Phase 7 §5). Live constraint
  probes are written as a `returns setof text` function, called, then dropped.
- **`apiError` matches sentinels against the WHOLE message** (Phase 7, again).
  `InvalidFinanceDetailsError` carries its reasons on a property and the route
  returns `NextResponse.json` directly — the specific reasons are the entire
  value of that response to someone correcting an IBAN.
- **PostgREST `on_conflict` cannot name a PARTIAL unique index.** The two
  uniqueness rules here are partial (`where party_kind = 'self'` /
  `= 'counterparty'`), so the upsert is find-then-write; the indexes remain the
  real guard and a race correctly loses to a 23505.
- **A stale caveat is a live wrong answer.** `attribution.ts` warned that agreed
  excepted hours "will NOT reduce the calculation". Left unversioned, it would
  now talk an operator out of a deduction v2 actually applies. It is gated on
  `engineVersion === 1`.

---

## 6. Verification state

- `tsc --noEmit` clean; `eslint src/lib src/app` clean.
- **2,657 tests pass** (0 fail): 2,569 app + 88 package, including 1,000 corpus
  replays across both rule sets and 22 counterparty-finance tests.
- `bun run verify:build` reproduces `bc9f24fdab910a1b` **and**
  `261e3468d2246f30` through the `.mjs` artifact. The wasm is built in CI
  (`javy` is absent locally by design); the workflow now asserts both roots and
  the mjs≡wasm equivalence for both suites.
- v1 corpus regenerated to a scratch directory and diffed: **500/500 byte-identical**.
  CI now runs that diff on every push.
- **Live-database checks**, not just unit tests:
  - nine constraint probes on `counterparty_finance` and `claims.engine_version`
    (wallet-without-chain, malformed IBAN, counterparty-without-key, duplicate
    self, duplicate party key, `engine_version = 3`, and the new-row default),
    all refused/accepted as intended, run through a `returns setof text`
    function and cleaned up to zero rows;
  - end-to-end hydration probe: a claim with no finance records reported
    `missingForBank: [creditor.accountId, creditor.bic, debtor.accountId,
    debtor.bic]` and a null EIP-712; after configuring both parties,
    `missingForBank: []`, `missingForChain: []`, `ready: true`, a fully
    populated pacs.008 and an EIP-712 with real payer/payee — with the debtor
    correctly the charterer and the creditor the owner;
  - counterparty matching proven against deliberately mismatched whitespace
    (`"  ACME  Shipping   Ltd "` on the claim vs `"acme shipping ltd"` stored);
  - cross-chain pair correctly blocked;
  - all probe rows deleted, leftovers verified zero.

---

## 6b. Phase 8b — the pre-release correction

Phase 8 shipped the versioning mechanism and then left every existing claim on
rule set 1, reasoning from a constraint that does not yet bind. **The product is
pre-release: no claim has been served, agreed or notarised**, so there was no
legacy figure to protect and no reason to leave claims on an engine with a known
defect. `20260801000004` moved all of them to rule set 2.

**The mechanism is untouched.** `claims.engine_version` keeps its CHECK (1, 2),
`resolveEngineVersion` still reads absence as 1, and the v1 corpus and root are
still frozen. What changed is which rule set today's rows point at. Post-launch
the same migration would be unacceptable, and §3's reasoning applies again in
full.

Verified rather than assumed: all three claims recompute **identically** under
both rule sets (none carries an `EXCEPTED_PERIOD` event, which is the only
branch that differs), and the figures still match the persisted calculations —
58,333.33 / 22,000 / 4,500. Both conformance roots re-verified unchanged.

### The UI gap, closed

The standing product rule is that a backend feature without a UI is not shipped.
An audit found four features with no frontend at all; three are now built:

| Was missing | Now |
|---|---|
| `counterparty_finance` (entire feature) | Settings → **Settlement & Banking** |
| Escrow contract configuration (an unset env var) | `settlement_chain_configs`, same page |
| `engine_version` — invisible to users | Rule-set chip on the claim workspace |
| `agreed_at` + `settlement_payloads` — API-only | **Agreement & settlement** panel on the workspace |

Two decisions worth keeping:

- **The settings form imports the server's validators rather than
  reimplementing them.** `counterparty-finance.ts` is pure precisely so it can
  run in both places. A second client-side IBAN check would drift within a
  release, and the failure mode is a form that accepts an IBAN the API rejects —
  or worse, one it accepts.
- **Escrow contracts are per (company, chain), not an env var.** An escrow
  contract IS a deployment on one chain; a platform-wide address is wrong
  everywhere except where it was deployed, and would route one tenant's money
  through another's contract. The env var survives as a fallback for
  single-deployment installs.
- A missing escrow is a **memo, not a blocker** — the bank leg settles on its
  own, and refusing a working instruction because an optional route is
  unconfigured helps nobody.

Verified in the browser against the running app, then confirmed against the
database rather than the screenshot (the standing rule about automation drift
earned its keep again — a save that had already persisted still showed stale
field values on screen):

- invalid IBAN → *"fails the ISO 13616 checksum"*; valid, space-formatted IBAN →
  *"✓ checksum valid"*, stored normalised as `GB33BUKB20201555555555`;
- the party list, the "your company" badge and the missing-details warning all
  reacted correctly to the record appearing;
- the workspace panel rendered the **ENGINE V2** chip and the seven-row
  eligibility checklist, with *Anchored to ERP voyage data* and *Evidence fully
  corroborated* correctly failing and the agree button correctly disabled;
- the example record was deleted afterwards. **A documentation IBAN must not sit
  in a tenant that generates payment instructions.**

---

## 7. Known gaps and open decisions

1. **The ERP schedules UI is built** (`/schedules` + `src/lib/simulator/prefill.ts`),
   closing the last item from the UI audit. Verified end to end by driving a real
   `pull_schedules` sync through the Fortune adapter in mock mode rather than by
   inserting rows: 5 schedules landed, the page rendered them with provenance,
   and "Assess risk" carried the port call into the Monte Carlo. The engine's own
   seed — `kythnos voyager|7101/2026|tubarao|2026-08-03T12:14:26.683Z|…` — is
   derived from the schedule, which is what proves the ERP data reached the
   engine rather than merely the form.
2. **v2's root is not yet attested by the wasm.** Only CI can build it (`javy` is
   absent locally by design). The `.mjs` reproduces both roots; the sealed
   artifact's agreement is asserted by the workflow on push.
3. **The delete paths were exercised at the API and database layers, not through
   the browser.** Both are behind `confirm()` dialogs, which block the automation
   tools outright.
4. **A mock FORTUNE integration and its 5 fixture schedules are live in the demo
   tenant**, left deliberately so `/schedules` demonstrates something. Every row
   is labelled `mock` in the UI with a banner saying an assessment run from it is
   a rehearsal. Remove with:
   `delete from integrations where display_name = 'Fortune ERP (demo mock)';`
5. **The AIS map has been verified against a SYNTHETIC track only**
   (`AIS_PROVIDER_URL=mock`). The projection, segment colouring, gap dashing,
   event-to-fix matching and both highlight branches now all draw correctly —
   but no real provider has ever been connected, so field quirks (ordering,
   duplicate fixes at scale, coverage holes) remain unmet. First contact with a
   live provider is still a review, not a deploy.
6. **`AIS_CONGESTION_PROVIDER` is unset**, so a pre-arrival assessment refuses
   with an actionable message rather than guessing port queueing — correct, and
   unchanged. The end-to-end verification used an ephemeral `mock` value passed
   to the dev process; `.env` was not modified.
4. **The v2 corpus ships no PDFs.** They are extraction fixtures, irrelevant to
   engine conformance, and would duplicate 2 MB.
5. **EIP-55 and the EIP-712 digest remain uncomputed.** Both need keccak-256.
   Unchanged from Phase 7 and still the right trade.
6. **No escrow contract is registered anywhere yet**, so no chain leg is
   generated. That is correct — none has been deployed. The tenant path
   (Settings → Settlement & Banking) and the env fallback both exist and are
   verified; neither invents an address.
7. Phase 7 gaps 1, 3, 4, 5, 7 and 9 are **unchanged** — no adapter has met a live
   ERP, `p90_waiting_hours` is still not backfilled, Ulysses' revision cursor is
   still not honoured, webhook v1 signatures still ship, cross-tenant matviews
   are still data-starved, and nothing consumes `settlement_payloads`.


---

## 9. Phase 9 — zero-data entry & the audit room

### The audit came first, and changed the work

The directive asked for a drag-and-drop SoF uploader. **It already existed** —
`document-viewer.tsx` has a dropzone (drag state, click-to-browse,
`accept="application/pdf,image/*"`, 20 MB) wired to
`POST /api/claims/[id]/documents` → vision extraction → events for review.
Building a second one would have been the most expensive possible mistake, and
the Phase 6/7 rule ("grep `src/`, do not read a status line") is what stopped it.

The **real** gap was narrower and the directive named it correctly:
`ingestion/multimodal.ts` had no user-facing route at all — `extractSofTimeline`
was reachable only through the API-key M2M endpoint. That is what got built.

| Directive | Reality |
|---|---|
| Drag-and-drop PDF/image upload | Already shipped; untouched |
| `multimodal.ts` has no UI | True — built `/api/claims/[id]/ingest-sof-text` + `sof-text-ingest.tsx` |
| Audit/verification UI | Genuinely absent; built |

### Two defects found by verifying rather than assuming

1. **The audit panel showed v1's conformance root on a v2 claim.**
   `readVerifierManifest()` read the manifest's unqualified `conformance` key,
   which is v1's. The bank-facing `/api/v1/claims/[id]/verify` had the SAME bug,
   which matters more: a bank would run v1's suite, get a root matching the
   manifest, and conclude they had attested the engine behind a v2 figure. Fixed
   by making the reader version-aware and pinning it in
   `verifier-manifest.test.ts`. Found by looking at the rendered page.
2. **`howToVerify` still quoted v1's path in prose** after the machine-readable
   field was fixed — the two had drifted within the same object. Caught by the
   test written for defect 1, which is the argument for asserting on content
   rather than on "the values differ".

### One product gap found by using it

`DMY_RE` — the **maritime day-first convention**, per the module's own comment —
had no offset variant, so `12/03/2024 06:30 +08:00` was rejected as naive and the
user was told to supply an offset they had already written on the line. Not
wrong (it refused rather than guessed) but needlessly lossy on the format real
SoFs use. Now the line's own offset is honoured and beats any default.

### Verification state

- `tsc` + `eslint` clean; **2,700 tests pass**.
- Verified in the browser on a live claim, then confirmed in the database:
  8 events landed `status=suggested`, `source=multimodal`, `bbox` zeroed (no
  fabricated regions), `ais_geofence_verified` NULL (not checked ≠ failed), and
  **the calculation did not move** — 122 used hours before and after, because
  suggested events are invisible to the engine. Test rows deleted afterwards.
- The audit panel renders the correct v2 root `261e3468d2246f30`, the engine
  fingerprint, tzdata digest, notarisation Merkle root, and a 4.5 KB downloadable
  bundle. WASM digest reads "not built" locally, honestly, because `javy` is
  absent by design.


---

## 10. Phase 10 — spatial verification and negotiation

### Audited first, again, and again it mattered

The negotiation directive was **partly already built**: `event_proposals`
(amend/add/remove, pending/accepted/rejected, notes) plus owner-side review UI
and a guest-side POST through the claim room had shipped in Phase 4. What was
missing was narrower — no way for the OWNER to raise a dispute, and no phase
workflow. The AIS half was a genuine gap: `micro-movement.ts` and
`geofence-server.ts` had no `.tsx` referencing them at all.

### The phase is derived, and that is the design

`claims.status` could not hold "negotiating": `recompute-server.ts` overwrites
status on every calculation, so the phase would survive until the next recompute
and then vanish with no error anywhere — the claim would leave negotiation
because somebody edited an event. Phase 7 hit this exact wall with agreement and
solved it the same way, with a column.

`derivePhase()` reads `agreed_at`, `negotiation_opened_at` and the pending count.
**A pending dispute alone is enough to read as negotiating**, whatever the flag
says: a stored label that disagrees with reality is worse than no label, and the
settlement gate reasons about this.

`negotiation_opened_at <= agreed_at` is a DB CHECK. Not a workflow gate — a claim
may be agreed with no dispute ever raised, which is the happy path — but an
agreement dated before the negotiation that produced it is a corrupt record, and
the settlement payload derives from it. Probed live.

### Two defects found by looking at the running page

1. **The redline rendered "undefined NaN".** My `Diff` interface assumed
   `{net, currency}`; the engine returns `ScenarioDiff` with `delta.net_amount`
   and the currency on `baseline.totals`. A money figure that renders as
   "undefined NaN" is worse than no figure — it looks like one. Now the redline
   simply does not render when the comparison could not be made, and says why.
2. **A comment that misdescribed its own code.** It claimed the server rejects an
   amendment whose timestamp is unchanged. It does not — it accepts it, which is
   the desired behaviour (a recorded objection with no counter-time). The code
   was right and the comment was wrong, which is the more dangerous direction.

### Verification state

- `tsc` + `eslint` clean; **2,698 tests pass**.
- End-to-end in the browser: raising a dispute moved the workflow Open →
  Negotiating, blocked agreement with "1 dispute is still open", and priced the
  redline at **USD 2,333.34 / +2.0h** — arithmetic confirmed by hand (2h at
  28,000/day). The settlement panel independently flipped "No pending
  counterparty proposals" to failing, so the two panels agree.
- Confirmed in the database: `share_id` NULL (internal, not from a claim room),
  the company name as `proposed_by_label`, negotiation auto-opened by the first
  dispute, and the event **unmutated while the proposal is pending**. All test
  rows removed and the claim restored.
- The AIS map renders its unavailable state honestly (no provider configured)
  while still listing every event's motion verdict. **It has never been seen with
  a real track** — see gaps below.


---

## 11. Phase 11 — the strategy room, and looking at the map

### Visual QA found three defects the tests could not

The AIS map had never rendered a track. `src/lib/dev/mock-ais-track.ts` fixed
that, and looking at the result found three things in sequence:

1. **The map rendered over 700px tall.** `height: auto` with a 640x340 viewBox
   scales with the container, so on a wide workspace it became a wall of empty
   sea with a line down it. Now a fixed 20rem with `preserveAspectRatio` —
   letterboxed rather than stretched, because a distorted projection would make
   a berth shift look like a run to sea.
2. **Nine dashed gaps where one was intended.** The mock spread the shift across
   a proportional slice of the window, which on a five-day claim put 78 minutes
   between fixes — past `maxGapMinutes` (60). **The test asserted `gaps > 0` and
   passed the whole time.** It now asserts exactly one, plus that no ordinary
   sampling interval exceeds the threshold.
3. **The one real gap drew as an invisible dot.** It sat between the anchorage
   and the start of the transit, so it spanned no distance. Moved to 30–70% of
   the transit, where a feed drop actually matters, and the dashed branch is
   now visible.

Both highlight branches were then verified by temporarily adding a SHIFTING
event during the moored berth phase: the chip went to **1 CONTRADICTED** and the
marker turned red. Probe rows deleted.

### The mock is a fixture, not a data source

`isMockAisEnabled` requires `AIS_PROVIDER_URL === "mock"` **and**
`NODE_ENV !== "production"`. Verdicts derived from it are computed in memory via
the same pure `verifyTimelineMotion` the real pipeline uses and are **never
written to `evidence_checks`**; the UI carries a loud synthetic banner. A
fabricated position track that reached a persisted verdict would put invented
evidence into a claim, which is the one thing this product exists to be trusted
about.

### The strategy room converts in front of the user

`executeAgenticArbitration` takes exactly three knobs per side —
`maxConcessionUsd`, `hardStopClauses`, `maxRounds`. The UI does not invent a
richer contract. Operators think in percentages ("hold 85%") and hours ("give up
three hours of weather"); both are shown, both are converted **visibly** into the
money figure the engine receives, and the converted figure is the one displayed.
Hiding the conversion would make the mandate feel more precise than it is.

Verified live: an 85% floor on a USD 58,333 claim produced a USD 8,750 budget
(≈7.5h at 28,000/day), and the run returned USD 46,667 recommended — the
midpoint of final positions 53,667 and 39,667, gap 14,000, 4 rounds, queued
behind a human review. Room and review rows deleted afterwards.

Nothing here touches engine determinism: the agents price every position with a
real laytime run through `sensitivity.ts`; the limits only decide how far each
side may move.


---

## 12. Phase 12 — the ledger, and the orphan sweep

### The sweep, done properly

Table names barely appear in `.tsx`, so counting those would have proved
nothing. The real test is whether a route reading a feature is fetched by any
component: 117 routes on disk, cross-referenced against every `/api/...` string
literal in every `.tsx`. **39 unreferenced, of which 34 are correctly
machine-facing** — cron sweeps, M2M under `/api/v1/*`, inbound webhooks, the
bank-facing grant redemption, public verifier artifacts, `/mcp`.

**Five genuine orphans, all now built:**

| Orphan | Why it mattered | UI |
|---|---|---|
| `finance-grants` | The trade-finance moat: nothing could issue a bank a token, so the audit room's bundle was unreachable | `finance-grants-panel.tsx` |
| `exposure` | Live demurrage accrual on an unfinished voyage | `claim-outlook-panel.tsx` |
| `settlement-expectation` | What claims like this actually settle at | `claim-outlook-panel.tsx` |
| `intel/counterparty` | Counterparty behaviour from your own book | `/analytics` |
| `prefixture/analyze` | Price a CP's risky clauses before fixing | `/analytics` |

The grants one is the significant find: Phase 8 built the audit room showing
what a bank would be handed, and Phase 12 discovered nothing could actually hand
it to them. The two halves existed for four phases without meeting.

### The ledger is a projection, not a table

The directive offered `claim_audit_logs` as an option. A stored log is worse:
it needs backfilling (inventing timestamps for everything before it existed), it
is a second copy of facts that already carry their own times, and a writer that
failed would leave a hole nothing could detect. **A read-time projection cannot
disagree with the record because it is the record.** The cost is a bounded
fan-out of narrow queries, paid only when the tab is opened.

`actorForEventSource` defaults to **`unknown`, never `human`**. Attributing a
machine's action to a person is the failure mode that makes an audit trail
actively misleading — somebody will believe it. Pinned by a test.

`domain_events` is included but deliberately terse: it records that a transition
was *published to consumers*, which is a different fact from the transition
itself, and the transition is already in the ledger from its own table.
Including it as an equal peer would double-count every state change.

### Verification state

- `tsc` + `eslint` clean; **2,724 tests pass**; production build clean.
- Browser-verified: the ledger rendered 19 entries on the demo claim with
  filters reading Person 1 / AI 6 / System 9 / External 3, and the AI filter
  correctly isolated the six vision-extracted timeline events — *not* attributed
  to a person. Outlook rendered COMPLETED / USD 58,333 / 122-of-72 hours with
  the meter over-full, and distinguished "no settled claims yet" from "market
  comparison switched off". The CP analyzer parsed a real recap and reported
  **"not priceable"** against 0 historical voyages while still listing the
  unpriced structural risks and naming the one field it could not parse.


---

## 13. Phase 13 — guardrails and E2E

### The orphan guardrail

`scripts/check-orphaned-routes.ts` (`bun run check:routes`), wired into
`verifier.yml`. 118 routes, cross-referenced against every `/api` string
literal in every `.tsx`/`.ts` outside the route handlers.

**The allowlist requires a REASON, and that is the design.** A list of bare
paths degrades into a place to silence failures, which is exactly how the gap
it exists to prevent got in. The reason is what a reviewer checks to tell a
deliberate integration endpoint from a feature somebody forgot to finish.

On its first run it flagged three. One was a scanner bug — `${qs}` appended
without a `/` is a query string, not a path segment, so `/intel/benchmark${qs}`
was normalised to a path matching no route and a live feature read as orphaned.
The other two (`/knowledge/search`, `/intel/congestion`) turned out to be
**deliberate public APIs whose UI reads the underlying library directly**. Both
are now allowlisted with that reason recorded — previously it was tacit, and a
later reader would eventually have deleted one.

Verified by negative test: adding an unreferenced route makes it exit 1.

### The E2E suite, and what writing it found

`tests/e2e/golden-path.spec.ts`, 7 steps, all green in ~37s. Playwright starts
the app itself on :3100.

**Writing it found three defects, none of which any unit test could see:**

1. **`Input` had no label association.** No `htmlFor`/`id`, so screen readers
   announced every labelled field as unlabelled and clicking a label did not
   focus it. Fixed with `useId`, plus `aria-invalid`/`aria-describedby` on the
   error path.
2. **Two panels were not landmarks.** A `<section>` with no accessible name is
   not exposed as a region at all; a screen-reader user navigating by landmark
   skipped straight past them.
3. **Grant revocation recorded no reason.** The Phase 12 panel sent `reason` in
   a JSON body; the route reads it from the query string. Revocation worked, so
   every server-side check passed — and every revocation was logged as an
   unexplained action. Only an assertion about what appears on screen
   *afterwards* caught it.

Two more findings were about the harness rather than the product, and both are
worth remembering:

- **The proxy's 100-req/min anti-flood bucket fails an E2E run.** One browser
  loading a twelve-panel workspace four times clears it, and the 429 surfaced
  in the UI as **"Claim not found"** — indistinguishable from a product bug.
  `E2E_DISABLE_RATE_LIMIT=1`, honoured only outside production (the same gate
  the synthetic AIS track uses).
- **A Playwright `afterAll` cleanup hook ran before the last tests**, deleting
  the claim mid-suite. Cleanup is now an explicit final step, where a failure
  is reported rather than swallowed.

### The suite does not clean up after itself, deliberately

There is no claim-deletion route and this phase did not add one. A claim is
evidence — notarisation anchors, an audit ledger, possibly a settlement
instruction. Adding a destructive endpoint so a test could tidy up would be a
product decision made for a test's convenience, and that endpoint would
eventually be called by something other than a test.

Artifacts carry a run id instead. **E2E runs leave claims named
`E2E PATHFINDER <RUN>` in the demo tenant**; clear them with
`delete from public.claims where vessel like 'E2E PATHFINDER %';`

### Verification state

- `tsc` + `eslint` clean; **2,636 unit tests** and **7 E2E steps** pass;
  production build clean; `check:routes` green with 0 orphans.
- The CI pipeline gains two jobs: `check:routes` in `verifier.yml`, and a new
  `e2e.yml` that fails loudly if Supabase credentials are absent rather than
  silently skipping.
