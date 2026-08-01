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
5. **`AIS_CONGESTION_PROVIDER` is unset**, so a pre-arrival assessment refuses
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
