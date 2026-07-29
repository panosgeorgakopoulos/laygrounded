# LayGrounded — Market Leadership Roadmap

Merged plan: the six-tier feature list plus additions that exploit moats the
codebase already has. Ranked by leverage, sequenced by dependency.

Status date: 2026-07-25. Baseline commit: `ced09eb`.

---

## Part 0 — Stability verdict (verified, not assumed)

| Check | Result |
|---|---|
| `bun test src/lib/` | **976 pass / 0 fail**, 40 files, 2261 assertions, 1.04 s |
| `bun run lint` | clean |
| `bunx tsc --noEmit` | clean |
| `bun run build` | succeeds; 20 pages, no suppressed type/lint errors in `next.config` |
| Migrations | applied through `20260725095341_efti_grants` |
| Supabase security advisors | 1 real finding (below), rest informational |

**The build is stable.** The 500-case synthetic corpus replays green, so the
engine has not drifted.

### Finding: cross-tenant matview refresh functions were world-executable

`refresh_honesty_index()`, `refresh_oracle_voyage_stats()` and
`refresh_port_honesty_and_resilience_index()` are `SECURITY DEFINER` and were
still holding explicit `EXECUTE` grants for `anon` and `authenticated`.

Root cause: the three migrations declared intent as `REVOKE EXECUTE ... FROM
public`. On Supabase that is insufficient — default privileges grant EXECUTE on
new public-schema functions to `anon`/`authenticated` *directly*, not through
the `PUBLIC` pseudo-role, so the revoke was a no-op against them.

Impact: any holder of the publishable anon key could `POST
/rest/v1/rpc/refresh_honesty_index` unauthenticated and force a full
cross-tenant `REFRESH MATERIALIZED VIEW`, repeatedly. Compute amplification,
not a data leak — `REVOKE ALL` on the matview *relations* did apply, so the rows
were never readable. `src/app/api/intel/honesty-index/route.ts:71` asserts the
invariant in a comment; the database disagreed.

Fix written to `supabase/migrations/20260725100000_lock_matview_refresh_grants.sql`
(not yet applied — sandbox blocked the DDL). Both in-app callers already use the
service-role client, so the revoke is safe. `rls_auto_enable` is included for
hygiene; it returns `event_trigger` and is not reachable over PostgREST, so the
linter's flag on it is a false positive.

**Adopt as a convention:** every `SECURITY DEFINER` function revokes from
`public, anon, authenticated` explicitly. The newer migrations
(`20260724000000_get_user_id_by_phone.sql`) already do this correctly.

---

## Part 1 — The strategic read

Counted at baseline:

```
79 API routes   28 lib modules   40 test files   7 authenticated UI surfaces
```

The backend is roughly a decade of product surface. The frontend is a claims
list, a workspace, analytics, compliance, simulator, settings, and a claim room.
Modules with real logic, tests, and routes — but no way for a user to reach
them — include: negotiation/autonomous, optimization/ecospeed, legal/prosecution
and anchoring, interop/eFTI, market/bunker and AIS telemetry, ingestion
(email/SMS/multimodal), insurance oracle, settlement clearinghouse, charter
chain, voyage shield, audit API, MCP server.

**The binding constraint is not features. It is that most of what is built is
unreachable and therefore unsold and unvalidated.** Adding twenty more modules
in this state makes the ratio worse and the codebase harder to defend.

This does not mean stop building — the feature list below is genuinely strong.
It means **Phase 0 is non-negotiable and comes first**, and every subsequent
phase ships its UI in the same phase as its logic. No module lands without a
surface.

I have kept the full scope you asked for. Nothing is dropped; it is sequenced.

Legend: **[Y]** = from your list · **[+]** = addition · **[Y+]** = yours, extended.

---

## Phase 0 — Make the existing product reachable — ✅ DONE 2026-07-26

Prerequisite to everything. No new domain logic.

**Shipped:** grant-fix migration applied and verified against `pg_proc.proacl`; a
static CI guard (`src/lib/security/definer-grants.ts`) that fails the build on any
`SECURITY DEFINER` function left executable by `anon`/`authenticated`; the voyage
console (`src/lib/console/triage.ts` + `/console`, driven live against the demo
tenant); and a CLAUDE.md reconciliation.

**The guard paid for itself immediately** — it found `get_user_id_by_email`
declared in `init.sql` but absent from the hosted database, which had silently
killed the whole inbound-email SoF channel and was routing existing-account
invites past the `USER_ALREADY_IN_ANOTHER_COMPANY` guard. Fixed, applied,
verified, and both call sites now surface the RPC error instead of reading a
fault as "no such user".

Items 3 (surface the orphans) and 4 (onboarding path) turned out to be already
done by the 2026-07-22/23/25 passes. Funnel *instrumentation* — actually watching
a new user reach their first computed claim — remains unbuilt and is the one
piece of the exit criterion still open.

1. **Apply the grant fix migration**, re-run advisors, add a CI check that fails
   when a `SECURITY DEFINER` function is executable by `anon`.
2. **Voyage console** — one page that surfaces voyage-shield alerts, live claims,
   time-bar countdowns, and the ingestion inbox. This is the daily-use surface
   the product currently lacks entirely.
3. **Surface the orphans** — route the built-but-hidden modules into the
   workspace intel panel or the console: eco-speed, bunker, notarization,
   prosecution pack, eFTI sharing, autonomous negotiation, insurance policies.
   Mostly wiring, no new engines.
4. **Onboarding path** — `/v1/onboard` exists as an API with no funnel in front
   of it. Sign-up → first SoF → first calculation, instrumented.
5. **Reconcile `CLAUDE.md`** — it documents roughly the `20260714` era. Six
   migrations and ~30 routes of drift. Cheap now, expensive at 3× the size.

Exit criterion: every shipped module is reachable in ≤3 clicks, and you can
watch a new user reach a computed claim.

---

## Phase 1 — Own the inbound side (4–6 weeks) · highest leverage

### 1.1 **[+] Defense Mode — inbound claim adjudication** — ✅ DONE 2026-07-26

Shipped: `src/lib/defense/audit.ts` (pure, 21 tests) + `service.ts`, migration
`20260726000001_defense_mode.sql` (`inbound_claims` + `inbound_claim_audits`,
applied), routes `/api/defense/claims[/[id]/audit]`, page `/defense`, nav entry.
Verified end-to-end in the browser against the live DB.

**The design error worth remembering.** The first implementation modelled a
defensive evidence challenge as "strike out a weather stoppage the record
contradicts" — mirroring `sensitivity.ts`. That is backwards. Under a WWD basis
an exclusion does not consume laytime, so it delays demurrage and already works
for the payer; striking one out *raises* the bill (verified on the engine:
36,000 → 48,000). The tests caught it as a zero-valued challenge.

A defender's money comes from four moves, now encoded: arithmetic (the invoice
exceeds the claimant's own calculation), terms (our fixture beats theirs), a
later start or earlier end on AIS evidence, and **exclusions the claimant
omitted** — the quiet overcharge nobody audits for, because the stoppage that
was never written down leaves no trace to check.

Two other decisions held: individually-priced reductions are never summed (the
defensible position is one combined engine run, since interacting amendments
double-count), and `arguable` clause challenges are shown as negotiating room
but excluded from the number we would assert.

### 1.1b Defense Mode — next increments (not yet built)

- Ingest the counterparty's claim from a PDF rather than a form (reuse the
  extraction pipeline; the intake shape is already correct).
- Wire the real evidence pipeline in: `evidence/verify.ts` can supply the
  contradicted-NOR and omitted-weather inputs the audit already accepts, instead
  of the caller passing them by hand.
- A grounded rebuttal letter from the audit, via the existing drafter +
  `grounding.ts`.

Today the product helps you *make* a claim. Charterers, traders, and receivers
*receive* hundreds of them and under-scrutinize because manual audit costs more
than the error. That is the larger, more under-served half of the same market.

Everything needed already exists: `sensitivity.ts` literally computes the
attack surface of a calculation; `evidence/verify.ts` contradicts weather
claims against ERA5; `diff.ts` scores counter-positions in money; `drafting/`
produces grounded rebuttals.

Build: inbound claim intake (PDF/email of a counterparty's claim) → parse
their calculation → re-run the engine on their own facts → auto-audit
(evidence contradictions, clause misapplication, arithmetic) → ranked rebuttal
with a grounded counter-letter and a defensible counter-offer.

Why it wins: doubles TAM with ~15% new code, sells on hard ROI ("we cut 9% off
inbound demurrage"), and is the natural second side of the co-claim network in
Phase 4. Also the strongest wedge into charterers, who are the buyers your
pricing oracle needs most.

### 1.2 **[Y] Port waiting-time & congestion index** — ✅ DONE 2026-07-26

Migration `20260726000002_port_congestion_index.sql` (applied): matview
`port_congestion_stats` (NOR→all-fast per voyage, confirmed events only, waits
capped at 720h to keep clock-skew out of a published figure) plus
`companies.share_market_data` as a real, respected opt-out. Pure
`src/lib/intel/congestion.ts` (+18 tests), route `/api/intel/congestion`, public
page `/congestion`.

**Dual k-anonymity floor**, because a voyage count alone is not enough: a cell
needs ≥5 voyages AND ≥3 distinct companies. Five voyages from one charterer is
that charterer's private operating data republished under a port's name; two
companies lets each difference out the other. Suppressed cells withhold even
their voyage count, and are retained rather than dropped so a blank port reads
as "not enough data" instead of "no traffic". Verified against the live DB by
replicating the floor in SQL and confirming both implementations agree.

**Publication is OFF by default** (`PUBLIC_CONGESTION_INDEX`). Building the
capability and publishing a dataset derived from customers' operating data are
two different decisions, and the second is the operator's.

Two traps found by driving it: an ISR-prerendered page bakes the gate in at
BUILD time, so flipping the env var later silently does nothing; and `notFound()`
in a dynamic page body returns HTTP **200** with a 404 view, because headers are
already flushed — a soft 404 that search engines index. The gate now lives in
`src/proxy.ts`, verified returning a true 404 unpublished and 200 published.

### 1.4 **[Y] Benchmarking dashboard** — ✅ DONE 2026-07-26

Pure `src/lib/intel/benchmark.ts` (+14 tests), route `/api/intel/benchmark`,
`MarketBenchmark` card on `/analytics`. Waiting time, demurrage recovery rate,
and claim-to-settlement days, each as your median against the market's.

Two rules enforced in the pure module rather than trusted to the caller's query:
**your own company is never in the market baseline** (on a thin lane you would
otherwise be benchmarked largely against yourself and always look average), and
the market side carries the same ≥3-distinct-companies floor. `advantagePct` is
sign-flipped for lower-is-better metrics so positive always means "you are
ahead", whichever way the metric runs.

### 1.2-old **[Y] Port waiting-time & congestion index** (original note)

Partly built: `port_honesty_and_resilience_index` matview,
`market/ais-telemetry.ts`, `/api/v1/intel/prefixture` with k-anonymity floors.
Missing: the **public** surface.

Build: a public, k-anonymous congestion nowcast per port, statically generated
on the `/knowledge/[slug]` pattern already proven for SEO (SSG, 1 h revalidate).
Free, indexable, updated by every claim.

Guardrail: this publishes cross-tenant aggregates. Set the k-floor, the
suppression rule, and the tenant opt-out **before** the first page ships —
retrofitting a privacy posture onto a public dataset is not possible.

### 1.3 **[+] Port working-calendar dataset** — ⏸ BLOCKED ON A DATA DECISION

The only Phase 1 item not built, and deliberately so. It needs two things this
project's own rules say I must not invent:

1. **The data.** Port holidays and shift patterns are facts about the real
   world. Fabricating a calendar would put invented non-working days into a
   legal calculation — the same failure mode as fabricating case law, which is
   why `kb_precedents` ships empty and requires a `source_label`. Options: a
   licensed commercial feed, a public-holiday API plus per-port shift overrides
   captured from actual SoFs, or customer-supplied calendars.
2. **An engine change.** SHEX/SSHEX exclusions live in the pure engine, which is
   pinned by the 500-case regression corpus. Adding a calendar input changes
   blessed goldens, so it needs a deliberate regenerate-and-review pass rather
   than being tacked onto the end of a session.

Recommended shape when unblocked: `port_calendars` (port, date, kind, source,
effective range) + an optional `calendar` input on `CpTerms` that the engine
consults for day exclusions, defaulting to today's behaviour when absent so the
corpus stays green. Ship the schema and import pipeline first, seeded only from
a source that can be cited.

### 1.3-old **[+] Port working-calendar dataset** (original note)

Holidays, shift patterns, and local working hours per port are the single
largest source of laytime disputes, and `gencon94.ts` already consumes port
timezones for SHEX/SSHEX. There is no clean commercial dataset. Building one —
seeded from public sources, corrected by every disputed claim that flows
through — directly improves engine output, is defensible, and compounds.

Boring. Probably the highest ratio of moat to effort on this page.

### 1.4 **[Y] Benchmarking dashboard**

Extends the honesty index and pricing oracle. "Your recovery rate / dispute
cycle / waiting time vs. the market for this lane." Retention driver: nobody
churns away from their own benchmark. Needs 1.2's aggregation layer, so it
follows directly.

---

## Phase 2 — Trust as an exportable artifact (4–5 weeks)

### 2.1 **[+] Offline verifier — the engine as a WASM oracle** ★ makes 5.2 real

Your Tier 5.2 "verifiable claim standard" cannot succeed while verification
requires trusting the vendor's server. An arbitrator will not adopt that.

Because `gencon94.ts` is pure — no I/O, no AI, no Supabase — you can compile it
to WASM and ship a standalone verifier plus a signed input bundle (events,
CP terms, notarization anchor). Anyone re-runs the calculation offline and gets
byte-identical output. The 500-case corpus is the conformance suite.

This converts "trust us" into "check it yourself," which is the only version of
a standard that arbitrators, P&I clubs, and lenders actually adopt. It also
underwrites Phase 5 financing and is the credible basis for open-sourcing the
engine (your Tier 4.2).

### 2.2 **[Y] Counterparty risk graph — Know Your Counterparty** — ✅ DONE 2026-07-29 (own-book scope)

`src/lib/intel/counterparty.ts` (pure, 21 tests) + `counterparty-server.ts`;
route `GET /api/intel/counterparty` (list) and `?name=<x>` (profile).

**Scope decision — the important part.** Every behavioural signal is computed
from the **viewing company's own book**. This build deliberately does NOT
create a cross-tenant reputation database keyed by counterparty name.

The distinction is not squeamishness. `honesty_index` and
`oracle_voyage_stats` are keyed by **port and month** — places and time
buckets. A score keyed by a **named company** is a different object: it lets
one customer's private settlement behaviour be inferred from an aggregate, and
it publishes a commercial judgement about a third party who has no account, no
notice and no way to contest it. k-anonymity does not fix that, because the
subject of the score *is* the identified entity. Widening this is a product and
legal decision, not a migration — the pure module would not need to change.

Sanctions screening is the one exception (public-record data, already run per
claim) and is reported **verbatim**, never folded into a score. A match or
possible-match forces `elevated` and is named as the first driver.

Three properties the shape enforces:
1. **No opaque number.** Every signal carries its value, sample size and a
   plain-language reading; the band is a *count of adverse signals*, not a
   weighted score, and names which ones drove it. A weighted score would imply
   precision this data lacks and hide the reasoning.
2. **Insufficient signals are ignored, not scored neutral.** Otherwise a
   two-claim history quietly averages out to a confident "moderate". Thin
   history reads `unrated`.
3. **Counterparty matching is exact, never fuzzy.** Silently merging "Cargill"
   and "Cargill International" would attribute one legal entity's behaviour to
   another — the precise error this kind of profile must not make.

### 2.3 **[+] Settlement expectation model** — ✅ DONE 2026-07-29

`src/lib/settlement/expectation.ts` (pure, 26 tests); route
`GET /api/claims/[claimId]/settlement-expectation`.

Tiered matching (`exact` → `posture` → `form` → `all`) that **always discloses
which tier it settled on** — an estimate from a relaxed sample presenting
itself as an exact one is worse than no estimate. Below `MIN_SAMPLE_SETTLEMENTS`
it returns `insufficient_data` with a reason rather than a number from two
observations.

Two subtleties worth keeping:
- **The k-anonymity floor applies only when the sample spans more than one
  company.** A desk querying purely its own book must never be blocked by a
  rule that exists to protect other people's data.
- **`unverified` is a distinct posture from `corroborated`.** "We checked and
  the archive agreed" is a materially stronger position than "we never
  checked"; collapsing them would let an unchecked claim borrow a verified
  one's settlement history.

Currently own-book only. Widening the sample cross-tenant is defensible — it is
keyed by claim *shape*, not by a named party, and the floor is already built —
but it is customers' settlement data, so it is not switched on silently.

### 2.4 **[+] Protective notice automation** — ✅ DONE 2026-07-29

`src/lib/voyage/protective-notice.ts` (pure, 16 tests) decides from a
`TimeBarStatus` whether a notice is due; the sweep in `notices-server.ts`
drafts it and queues it for approval. Shipped together with 3.2 — see below.

**The judgement call worth keeping:** an *expired* bar returns `expired`, not
`due`. Serving a protective notice after the deadline does not revive the
claim, and a letter implying otherwise puts a false position in writing. The
console still shows the claim as expired; this module simply refuses to paper
over it. Verdict precedence is `settled` → `already_filed` → `no_deadline` →
`expired` → window check, and `already_filed` deliberately outranks the
deadline so a re-sweep cannot double-file.

---

## Phase 3 — In-voyage engagement (4–6 weeks)

### 3.1 **[Y] Live demurrage meter** — ✅ DONE 2026-07-29

Running exposure counter for voyages still in progress, on the Phase 0 console.

- `src/lib/voyage/exposure.ts` (pure, 29 tests) + `exposure-server.ts` (I/O).
- `GET /api/claims/[claimId]/exposure`; `LiveExposureMeter` on `/console`.

**How it works, and why it is not a second implementation of the counting
rules.** The engine derives its window end from the last COMPLETED_* event, so
"used laytime as of T" is exactly the engine's own answer for an event set whose
operations completed at T. The module appends a *synthetic* completion at the
cut-off and runs the real engine. Exact, not approximate, including under `-UU`
bases — `getOperationsIntervals` already closes an unpaired operation at
`windowEnd`.

**Three things that cost time and will cost it again:**

1. `used_hours` is **uncapped** and the engine **throws**
   `CALCULATION_TIMEOUT` past 1440 hours from commencement. A fixed 60-day probe
   trips it, and a `catch` around the probe silently reports "never exhausted".
   The search now grows outward and lets the engine declare its own horizon.
2. Bisect the **demurrage clock**, not `used_hours >= allowed`. The engine
   credits a whole hour for a partial final hour, so `used_hours` reaches the
   allowance when the *last laytime hour begins* — an hour early. Bisecting on
   `time_on_demurrage_hours > 0` lands on the instant money starts and needs no
   assumption that hour blocks are clock-aligned (they are aligned to
   commencement, which an odd NOR time makes arbitrary).
3. Alert bands must be **min(absolute, share of allowance)**. A flat 72h
   "approaching" band fires from hour one of a 72h fixture — permanently on,
   therefore ignored. A pure percentage fails the other way on short fixtures.

**Not done:** `projectedCompletionAt` is wired through the pure module and
tested, but `exposure-server.ts` passes `null` — no AIS ETA source is connected
yet. The module refuses to invent a completion time, so the meter currently
reports accrued exposure only. Connecting `market/ais-telemetry.ts` is the next
increment.

### 3.2a **[Y] Auto SoF chasing** — ✅ DONE 2026-07-29

`src/lib/ingestion/sof-gaps.ts` (pure, 26 tests) finds missing milestones;
`src/lib/voyage/notices-server.ts` drafts a chase to the agent and queues it.
Route `POST /api/voyage-notices/run` (cron or authed, `dryRun` supported);
`GET` on the same route is the approval queue. Migration
`20260729000000_protective_notices_and_sof_chasing.sql` — applied and verified
in the catalog.

**Design decisions that will look arbitrary later but are not:**

1. **Not `voyage_alerts`.** That table's `event_id` is `NOT NULL`, and both of
   these are about *absent* facts. Its triage wording is also evidence-specific
   ("Independent evidence contradicts a claimed delay"), so reusing it would
   mislabel every notice on the console. Both features ride
   `drafts` + `pending_human_reviews` instead, which is what that table's own
   header comment says it is for.
2. **Two different idempotency guards, because they fail differently.** A
   protective notice is once-per-claim-ever, so the guard is "does a
   `protective_notice` draft exist" — it survives a review being approved or
   rejected, which the partial unique index does not. A chase is
   once-per-*gap-set*: the `signature` from `detectSofGaps` is stored on the
   review payload and compared next pass, so re-chasing an unanswered request is
   suppressed but a newly-missing milestone still gets asked for.
3. **Staleness gating.** Absent milestones only count as gaps after
   `staleAfterHours` (default 48) of silence — a live voyage is *supposed* to
   have no completion event. Two exceptions are reported immediately: a missing
   NOR (the engine throws without one, so there is nothing to wait for) and an
   unclosed interruption (the engine runs it to the end of the window, silently
   skewing the result rather than failing loudly).
4. **A chase is not legal correspondence.** It gets its own system prompt — an
   operator emailing an agent, not counsel drafting in a dispute — and
   `verifyDraftGrounding(..., { forbidAmounts: true })` rejects *any* monetary
   amount, including a correct one. A figure turns a request for a timestamp
   into an implied claim against the recipient. Prompting alone would not be
   checkable; this is.

`DraftContext` gained `timeBar` and `sofGaps` because the closed-world rule
means a letter can only cite what is in the context. Two test fixtures
(`grounding.test.ts`, `pdf.test.ts`) construct a full context and were updated.

**Verified end to end** against the live book on 2026-07-29: the sweep's
verdicts were checked against SQL (2 chases due on the two event-less claims, 0
notices due because all three complete claims are ~780 days past their bars →
the `expired` path), the `already_filed` guard was confirmed to suppress a
re-sweep, and a duplicate pending review was confirmed rejected with 23505.
**Not verified: the generated letters themselves** — the `GEMINI_API_KEY` is at
quota (429 on both models in the chain). The sweep handled that correctly,
recording the failure per-claim in `report.errors` and continuing.

### 3.2b **[+] Agent-side capture** ★ fix the supply side

Chasing agents for SoFs attacks the symptom. The cause is that port agents —
who *originate* every SoF — have no tooling and are chased by email by every
counterparty.

Ship both: (a) detect missing milestones and auto-draft grounded requests
(ingestion channels for email/SMS already exist), and (b) a free, offline-capable
agent capture app that timestamps and geofence-stamps events at source
(`ingestion/geofence-server.ts` is already there).

Agent-side capture is the supply side of the two-sided network, and it is the
piece competitors consistently skip because it does not monetize directly. It
is what makes Phase 4 reconciliation actually work — you cannot reconcile two
parties' SoFs if neither is structured at origin.

---

## Phase 4 — Two-sided network (6–10 weeks)

### 4.1 **[Y] Co-claim reconciliation network** — strongest long-term moat

When both sides are on-platform, claims reconcile against one shared, notarized
calculation. Foundations exist: claim rooms, `event_proposals`, `diff.ts`,
`legal/anchor.ts`, `chain/ripple.ts`. Defense Mode (1.1) is what puts the second
side on the platform, and agent capture (3.2) is what gives both sides the same
facts — which is why this phase sits after them rather than before.

### 4.2 **[Y] Open-source engine + developer ecosystem**

Docs site, hosted playground, community CP forms (NYPE, SHELLTIME, more tanker
forms). Credible only once 2.1 ships the offline verifier and conformance suite
— otherwise "open source" is a code dump with no way to prove a fork is correct.
Community-contributed forms grow coverage; "verified by LayGrounded" feeds the
funnel.

### 4.3 **[Y] eFTI federation as compliance hub**

`interop/efti-federation.ts` and the grant/share routes are built. eFTI
(EU 2020/1056) trends mandatory ~2027+, so the window is real but not immediate.
Position as the node operators adopt; keep warm, invest hard only on a
regulatory or design-partner trigger.

---

## Phase 5 — TAM expansion and fintech (parallel track from Phase 3)

### 5.1 **[Y] Pre-fixture CP risk analyzer**

Paste a charter party → extract and flag risky clauses, grounded against
`kb_clauses`/`kb_precedents`. Best top-of-funnel available: pulls users before
fixing, and grounding discipline is the differentiator against generic LLM
tools. `/v1/intel/prefixture` is the numeric half; this is the clause half.

Extension worth taking: **clause benchmarking** — "this WWD SHEX variant is more
owner-favorable than 78% of fixtures at this port," priced from your corpus.

### 5.2 **[Y] Full voyage P&L / freight & hire accounting**

Biggest TAM unlock; also the biggest build and the most crowded competitively
(Veson, Q88, Sea/). Freight, hire, bunkers (`market/bunker.ts` exists), port
costs, commissions — demurrage becomes one line. Reuses the pure engine's
determinism.

Sequenced late deliberately: it is a frontal assault on incumbents, and it is
far more winnable once Phases 1–4 make you the system of record for the
*disputed* numbers. Consider entering via settlement-grade voyage results rather
than full estimation.

### 5.3 **[Y] Adjacent claim types** — bunker quality, cargo shortage/damage, on
the same evidence-verification and grounded-drafting spine.

### 5.4 **[Y] Demurrage financing / factoring**

Advance against a notarized, evidence-verified, grounded claim. Depends on 2.1:
the offline verifier is what makes the advance underwritable by a third party.
Natural extension of the parametric insurance oracle. Note this crosses into
regulated financial services — the diligence and licensing work is the long
pole, not the code.

### 5.5 **[Y] The verifiable claim standard** — push the notarized + grounded
pack as a format arbitrators and P&I clubs accept. Standards are adopted through
institutions, not shipped; treat as a business-development track riding on 2.1.

---

## Phase 6 — AI frontier

### 6.1 **[Y] Grounded Claims Copilot (MCP-native)**

More built than the list assumes: `/api/mcp` serves JSON-RPC with seven
company-scoped tools (`list_claims`, `get_claim`, `create_claim`,
`update_cp_terms`, `get_laytime_breakdown`, `get_negotiation_intel`,
`get_evidence`) behind a full OAuth2 authorization server.

Remaining work is mostly product, not architecture: a conversational surface
over the whole book, drafting and scenario tools exposed as MCP tools, time-bar
flagging, and every figure passed through `grounding.ts`. Your note says this is
gated — the sentence was cut off in your message, so tell me what the blocker is
and I will sequence around it.

### 6.2 **[Y] Agent-to-agent settlement**

`negotiation/autonomous.ts` plus MCP. Bounded auto-negotiation between
counterparties' agents. Correctly last: it needs the co-claim network (4.1) to
have both agents, the verifier (2.1) to make outcomes checkable, and the
settlement model (2.3) to know what a reasonable bound even is. Hard-bounded
mandates and a human-approval gate on anything that moves money.

---

## Sequencing summary

| Phase | Theme | Weeks | Gate |
|---|---|---|---|
| 0 | Make it reachable | 2–3 | Every module ≤3 clicks; grant fix applied |
| 1 | Own the inbound side | 4–6 | Defense Mode live; congestion index public |
| 2 | Trust as artifact | 4–5 | Third party verifies a claim offline |
| 3 | In-voyage | 4–6 | Daily-active usage on the voyage console |
| 4 | Two-sided network | 6–10 | First claim reconciled by both sides |
| 5 | TAM + fintech | parallel | Charter-party analyzer converting pre-fixture |
| 6 | AI frontier | trailing | Copilot on the whole book, grounded |

## What changed versus the original list

- **Phase 0 inserted.** The gap between backend and reachable product is the
  binding constraint; nothing else compounds until it closes.
- **Defense Mode promoted to first.** Doubles TAM with the least new code, and
  supplies the second side that Tier 4.1 needs.
- **Offline verifier promoted ahead of open-sourcing and financing.** It is the
  precondition for both, not a follow-on.
- **Voyage P&L moved later.** Biggest TAM, but a frontal fight with incumbents;
  far more winnable from a position of owning disputed numbers.
- **Added:** port working-calendar dataset, settlement expectation model,
  protective notice automation, agent-side SoF capture.

## Open questions

1. What is the Copilot gated on? (sentence truncated in your message)
2. What was the Tier 4.2 note — "You just A…"? Reads like the engine is already
   extracted or licensed a particular way.
3. Current design partners: owner-side, charterer-side, or both? Defense Mode's
   priority is highest if you have charterer access.
