# Strategic roadmap & architecture — Phase 6 and beyond

Written 2026-07-30, against `main` @ `7f28e9a`. Baseline: **1592 app tests + 64
package tests**, 104 API routes, 53 tables + 4 matviews, 40 migrations, tsc /
lint / build clean, CI green.

Read this with `CLAUDE.md`, `src/lib/CLAUDE.md`, and
`docs/build-memory/handover_phase4.md`. Where they disagree with this document,
**grep `src/` and query the catalog** — that rule has already caught two wrong
status documents in this project, and it applies to this one too.

---

## 0. Read this first — most of the proposed backlog is already built

Before planning Phase 6 I audited the requested epics against the codebase
rather than against memory. **Six of the ten named features already exist**, in
some cases more completely than the epic description implies. Building them
again would be the single most expensive mistake available to us.

| Requested feature | Status | Where it lives |
|---|---|---|
| **A1** Virtual Arrival / Eco-Speed JIT | **BUILT** (293 lines, pure, tested) | `src/lib/optimization/ecospeed.ts` → `POST /api/v1/optimization/ecospeed` |
| **A2** CII & carbon-cost demurrage | **BUILT** (598 lines + ETS/MRV/FuelEU) | `src/lib/compliance/carbon.ts`, `ets.ts`, `mrv.ts`, `fueleu.ts` → `/api/claims/:id/carbon-cost`, `/api/compliance/fueleu`, `/api/v1/compliance/mrv-report` |
| **B1** Terminal inefficiency attribution | **PARTIAL** — lane benchmarking exists; per-crane/per-gang attribution does not | `src/lib/intel/benchmark.ts` → `/api/intel/benchmark` |
| **B2** Digital Free Pratique | **NOT BUILT** | — |
| **B3** AIS SoF verification | **BUILT** (AIS geofencing); **CV/satellite NOT built** | `src/lib/ingestion/multimodal.ts`, `geofence-server.ts` → `/api/v1/claims/:id/geofence-audit` |
| **C1** NLP inbox agent (zero data entry) | **BUILT** — deterministic extractor + email/SMS ingestion | `src/lib/ingestion/` → `/api/v1/ingestion/email`, `/sms`, `/sof-text` |
| **C2** Smart-contract escrow settlement | **PARTIAL** — clearing + HMAC bank webhook built; no on-chain escrow | `src/lib/settlement/clearinghouse.ts`, `banking.ts` |
| **C3** Hinterland supply-chain sync | **NOT BUILT** (generic integrations layer exists) | `src/lib/integrations/` |
| **C4** AI-to-AI settlement negotiation | **BUILT** (393 lines) — and deliberately *not* LLMs | `src/lib/negotiation/autonomous.ts` → `/api/v1/claims/:id/negotiate` |

Two of these deserve a closer look before anyone "improves" them.

**`ecospeed.ts` already is Virtual Arrival.** It prices every arrival speed
against sea fuel + at-sea ETS + anchorage aux fuel + at-berth ETS + demurrage
exposure while waiting + laycan penalty, and recommends the cheapest. The epic
description adds nothing it does not already do. What it *lacks* is a live
feed of terminal berth-availability windows — that is the gap, not the optimizer.

**`autonomous.ts` is better than "AI-to-AI negotiation" implies.** It is two
deterministic concession strategies whose every position is an engine number,
with contradicted evidence forcing a yield. The header states the reason
plainly: *money must not move on sampled text*. Replacing it with two LLMs
would be a downgrade dressed as an upgrade. If we want an LLM here, its only
defensible job is drafting the covering message — never choosing the number.

**Net new work in the stated backlog: B1 (deepening), B2, B3-CV, C2-on-chain,
C3.** That is a much smaller and sharper Phase 6 than the epic list suggests,
which is good news.

---

## 1. Architectural evolution

### 1.1 The honest starting position

We do not have a monolith with a scaling problem. We have a **modular monolith
that is already partly decomposed**:

- `packages/laytime-core` — the engine, a pure package with no I/O, published
  under Apache-2.0 and compiled to a sealed `.wasm` artifact.
- `packages/laytime-verify` — the offline verifier, two artifacts proven to
  compute identically over 500 conformance cases.
- Every route handler is already an independently-scaled serverless function.
- Four sweep endpoints already behave as workers: `/api/settlement/run`,
  `/api/insurance/run`, `/api/voyage-shield/run`, `/api/integrations/run-sync`.

**So the question is not "should we adopt microservices".** It is "which
workloads have a genuinely different runtime profile from an HTTP request?"
Splitting on *domain* lines (a claims service, a compliance service) would buy
us distributed transactions, network failure modes, and a deployment matrix, in
exchange for nothing — the domains share one Postgres and one tenancy model,
and that is the correct design for them.

### 1.2 The extraction criterion

Extract a workload **only** when it satisfies at least two of:

1. **Different time profile.** It cannot finish inside a request budget.
2. **Different failure profile.** It must retry independently without the user
   waiting (a rate-limited vendor, a flaky third party).
3. **Different resource profile.** It is CPU- or memory-bound where the web
   tier is I/O-bound.
4. **Different trust profile.** It must not share the web tier's credentials.

By that test, exactly **three** workloads qualify today:

| Workload | Criteria met | Why |
|---|---|---|
| **Monte Carlo risk** | 1, 3 | 50k trials ≈ 4.2s locally; the *wall-clock* is dominated by 30 ensemble + 8 ERA5 fetches (1–5s). CPU-bound and bursty. |
| **LLM calls** (SoF extraction, drafter) | 1, 2 | Vendor rate limits and 429s; the Phase 4 handover records `GEMINI_API_KEY` at quota making every LLM path unexercisable. Must retry out-of-band. |
| **Outbound webhooks / integrations** | 2, 4 | Third-party endpoints fail arbitrarily; signing keys should not sit in the web tier. |

Everything else — the engine, the verifier, laytime recompute, clause flagging,
P&L, compliance — stays in the app. The engine in particular must **never**
become a network service: its whole value is that it is a pure function that a
bank can run offline. Putting it behind an RPC would destroy the property the
trade-finance moat rests on.

### 1.3 The target: event-driven, one database, three workers

```
┌──────────────────────────────────────────────────────────────────┐
│  Next.js app (Vercel)  — request/response only                   │
│  routes · RLS · auth · the PURE engine in-process                │
└───────────────┬──────────────────────────────────────────────────┘
                │ transactional OUTBOX write (same tx as the state change)
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  Postgres (Supabase)  —  the event log AND the state             │
│  domain_events (append-only)  ·  pgmq queues  ·  pg_cron         │
└───────┬───────────────┬───────────────────────┬──────────────────┘
        ▼               ▼                       ▼
  risk-worker       ai-worker             delivery-worker
  (CPU, WASM)       (LLM, retries)        (webhooks, ERP, banks)
```

**Verified available on our instance** (`pg_available_extensions`, none yet
installed): `pgmq` 1.5.1, `pg_cron` 1.6.4, `pg_net` 0.20.3, `pg_partman` 5.3.1,
`vector` 0.8.2. That is a complete event-driven substrate with **no Kafka, no
Redis, no new vendor** — and, critically, no second source of truth.

**The transactional outbox is the load-bearing pattern.** An event is written in
the *same transaction* as the state change that caused it. Never publish from
application code after a commit: that is how "the claim settled but the webhook
never fired" happens, and in this product that class of bug is a financial
discrepancy, not a missed notification.

```sql
create table public.domain_events (
  id           bigserial primary key,
  company_id   uuid not null references public.companies(id) on delete cascade,
  aggregate    text not null,              -- 'claim' | 'pre_arrival_risk' | …
  aggregate_id uuid not null,
  event_type   text not null,              -- 'claim.recomputed' | 'risk.requested'
  payload      jsonb not null,
  -- Idempotency is the consumer's contract, not the producer's hope.
  idempotency_key text not null unique,
  occurred_at  timestamptz not null default now(),
  processed_at timestamptz
);
```

**Rules that must not bend:**

- **`company_id` on every event.** Tenancy travels with the message. A worker
  running as service-role has no RLS to fall back on, so the event must carry
  the scope — same reason `requireClaim()` in `src/lib/oauth/mcp.ts` is
  load-bearing today.
- **Every consumer is idempotent**, keyed on `idempotency_key`. We already do
  this well: `insurance_triggers` and `settlements` both use unique keys to
  make at-most-once real. Extend, don't reinvent.
- **Events are facts, not commands** — `claim.recomputed`, not
  `recompute_claim`. A fact can have many consumers; a command has an owner and
  becomes a distributed RPC in disguise.
- **The payload is a pointer plus a digest, not a snapshot.** Carry
  `{claim_id, calculation_digest}`, and let the consumer read the row. A fat
  payload becomes a second, stale copy of the truth.
- **Workers never bypass the domain invariants.** Machine-derived events land
  `suggested`, never `accepted`. That rule is older than the queue and survives it.

### 1.4 Migration sequence (each step independently shippable)

1. **Outbox only.** Add `domain_events`, write from `recompute-server.ts`,
   `assess-server.ts`, `clearinghouse.ts`. Nothing consumes it yet. Zero risk,
   and it immediately gives us an audit stream we do not have.
2. **Replace the four sweeps with `pg_cron` + `pgmq`.** Same code, pulled by a
   queue rather than an HTTP poke. Removes `CRON_SECRET` as a single point of
   compromise.
3. **Extract `risk-worker`.** `POST /api/risk/pre-arrival` becomes
   202-Accepted + queue; the UI polls or subscribes via Supabase Realtime. This
   is the one extraction with a user-visible payoff: the wall-clock today is
   1–5s of weather fetching that the user watches.
4. **Extract `ai-worker`.** Every LLM call becomes a queued job with retry and
   dead-lettering. Directly fixes the "quota exhausted ⇒ feature unusable"
   failure the Phase 4 handover recorded.
5. **Extract `delivery-worker`.** Webhooks, ERP pushes, bank clearing.

**Do not do step 3 before step 1.** An extracted worker without an event log is
a distributed system with no audit trail.

### 1.5 Rules for cross-session AI development

This roadmap spans sessions with no shared memory. These rules exist because
each one has already cost time in this project.

**Judging state**
1. **Shipped-ness is judged by `grep src/`. Applied-ness is judged by the
   catalog** (`information_schema`, `pg_proc.proacl`, `pg_matviews`) — never by
   `list_migrations`, which only sees migrations applied through that tool.
2. **Audit before building.** Section 0 of this document exists because six of
   ten "new" features were already built. Start every epic with an audit and
   write the result down.

**Leaving state behind**
3. **One handover document per phase**, in `docs/build-memory/`, written at the
   end and naming: what shipped, load-bearing invariants, traps already paid
   for, and known gaps. `handover_phase4.md` is the template.
4. **Memory files record the non-obvious only** — the trap, the reason, the
   verified external fact. Never what the repo already says. Convert relative
   dates to absolute.
5. **Contracts live next to the code as types plus tests**, not in prose. A
   `*.test.ts` beside a pure module is the contract; prose drifts, tests fail.

**Verifying**
6. **Verify against an independent implementation.** Self-written tests agree
   with self-written mistakes. Precedents: openssl for DER, redocly for
   OpenAPI, `node:wasi` for the sealed `.wasm`, the live Open-Meteo API for
   ensemble coverage.
7. **Drive the real system.** Most bugs in this project were invisible to unit
   tests and obvious against the live database or in a browser.
8. **Clean up live-DB fixtures and say what was left behind.**

**Traps that have already been paid for — do not rediscover**
9. `canonicalJson` skips `undefined` but **serializes `null`**. Absent ≠ null.
   This bit whole-object verification, and then bit the risk replay check.
10. **Postgres `jsonb` does not preserve key order.** Never compare stored JSON
    with `JSON.stringify`; use `verifyReplay` / canonical comparison.
11. **`REVOKE … FROM public` does not lock a Supabase function.** Revoke from
    `public, anon, authenticated` by name; `definer-grants.test.ts` enforces it.
12. **`auth.jwt() -> app_metadata -> company_id` is always NULL here** — the
    hook was never enabled. New tables use `is_company_member()`.
13. **`ON CONFLICT` cannot infer a partial unique index.**
14. **Do not run `bun run verify:build` locally** — `javy` is absent, so it
    strips the `wasm` entry from the manifest and flips `agreementVerified`.
15. **`icon_seamless` ensemble members go null after ~133h** while still
    returning 336 timestamps. Use `gfs_seamless`.
16. **A per-test timeout must exceed that test's own wall-clock assertion**, or
    it fires first and reports "timed out" instead of "too slow".

---

## 2. The unified epic backlog

Ordered within each epic by value ÷ effort. Every item names the honest gap,
not the pitch.

### Epic A — Green shipping

Both headline features are built. What remains is the **data** that would make
them bite.

**A1 · Berth-window feed for Virtual Arrival** — *the actual gap.*
`ecospeed.ts` optimizes against a *predicted* congestion delay supplied by the
caller. Real JIT arrival needs the terminal's berth-availability window. No
open standard exists; realistically this is per-terminal integration, starting
with the handful of terminals a design partner actually calls at.
*Architecture:* a `berth_windows` table with mandatory `source_label` and a
staleness clock; `ecospeed` takes it as an optional input and degrades to the
current behaviour when absent — never guesses.
*Moat:* low technically, high commercially (relationships).

**A2 · CII forward projection across the fleet.** `carbon.ts` computes how one
port delay moves the vessel's annual CII. The unexploited step is the *book*
view: which vessels are on track to drop a rating band this year, and which
delays are driving it. All the maths exists; this is aggregation + a page.
*Effort:* small. *Value:* high — a band drop is a chartering-eligibility event.

**A3 · Deprioritise: EU-ETS penalty conversion.** Already implemented in
`ets.ts` and surfaced at `/api/claims/:id/carbon-cost`. Verify before touching.

### Epic B — The objective truth layer

This is where the genuinely new work is, and it is the epic most aligned with
the product's existing moat (verifiable facts).

**B1 · Terminal inefficiency attribution.** Today `benchmark.ts` compares
*lanes*. The new claim is causal: *this* terminal's crane rate ran 38% below
its own 12-month median during our call, and here is the excepted-time
consequence.
*Architecture:* derive gross/net cargo rates from the existing breakdown +
cargo quantity; a new cross-tenant matview keyed by `(port, terminal, cargo,
month)`; **reuse the existing k-anonymity floors** (`MIN_VOYAGES`,
`MIN_COMPANIES`) by importing them, not restating them.
*Hard constraint:* this publishes a commercial judgement about a **named third
party**. The counterparty-risk decision in `src/lib/intel/counterparty.ts`
already refused exactly this shape. Terminal *performance* is more defensible
than counterparty *scoring* — it is a measurable rate, not a character
judgement — but it needs the same care: aggregates only, floors enforced, and a
stated method the terminal can contest.
*Moat:* **high**. Requires the cross-tenant corpus. Legacy vendors have the
data and have never dared publish it.

**B2 · Digital Free Pratique.** Genuinely not built. Free pratique gates when
laytime can start under many CPs, and today it is asserted in the SoF with no
independent evidence.
*Reality check:* there is no global API. This is a per-jurisdiction integration
(some national single windows expose it; most do not), so scope it as an
*evidence adapter* with the same `unavailable` verdict discipline the AIS and
sanctions adapters already use. Ship the adapter shape and one real
jurisdiction; never fabricate a verdict for the rest.
*Effort:* medium. *Value:* high where it exists, zero where it does not.

**B3 · Micro-movement SoF verification (the strongest item in this epic).**
We already cross-check *position* against AIS. The unexploited signal is
**motion**: a vessel genuinely working cargo sits at near-zero speed with
periodic small positional corrections as she is warped along the berth, and her
**draught changes** as cargo comes aboard. A vessel idle at berth shows neither.

*Prerequisite — verified, and it is not free.* `AisFix` in
`src/lib/ingestion/multimodal.ts` is **`{at, lat, lon}` only**; `normalizeAisTrack`
discards everything else. So:
 - **Derived motion is available today.** Speed and heading-change can be
   computed from consecutive fixes with no adapter change at all. This alone
   distinguishes "alongside and working" from "alongside and idle".
 - **Draught is NOT available today.** It requires extending `AisFix` and the
   normalizer, *and* confirming the configured provider actually returns it —
   many AIS feeds carry the static/voyage message only intermittently, and
   draught is master-entered, so it is evidence of a *claim* about cargo, not a
   measurement of it. Treat it as a second increment, gated on a provider check.

*Architecture:* pure `src/lib/evidence/micro-movement.ts` consuming the track
already fetched, emitting the same three-state verdicts
(`corroborated` / `contradicted` / `inconclusive` / `unavailable`) into
`evidence_checks`. Ship the derived-motion signal first; add draught behind a
capability flag once a provider is confirmed.
*Explicitly not computer vision or satellite imagery.* Those need a paid
imagery pipeline to recover a signal the position track largely already
carries. If SAR is ever wanted for dark-vessel cases it is a separate adapter
behind the same verdict interface — not a reason to delay this.
*Moat:* **very high** and cheap. Nobody audits berth micro-movement against
claimed cargo operations.

### Epic C — Autonomous ops & integrations

**C1 · Deprioritise: NLP inbox agent.** Built. `multimodal.ts` extracts
timelines deterministically and `/api/v1/ingestion/email` ingests them. The
remaining gap is *coverage of messy real emails*, which is a corpus problem,
not an architecture problem. Feed it real forwarded emails and fix what misses.
Note the deliberate design: the deterministic extractor runs first because it
is instant, free and reproducible; the vision model is the fallback for scans.
Do not invert that.

**C2 · Settlement escrow — resolve the ambiguity before building.**
`clearinghouse.ts` + `banking.ts` already clear settlements via an HMAC-signed
provider webhook. "Smart contract" could mean two very different things:
 - *(a)* **stablecoin escrow on a public chain.** Introduces custody, KYC/AML,
   sanctions exposure and jurisdictional questions that dwarf the engineering.
   The existing `anchor.ts` header already documents why we refused EBSI:
   we hold no credentials and claim no anchor.
 - *(b)* **an escrow-backed bank product** with the same auto-release triggers.
   Delivers the commercial promise — money moves the moment both sides verify —
   with none of the custody risk.
*Recommendation: (b).* If we want the on-chain story for fundraising, the
honest version is that our **calculations** are independently verifiable, which
is the rare property; a chain adds nothing to that and is easy to mistake for
the substance.

**C3 · Hinterland sync.** Not built. Rail/truck slot ETAs feed
`opsDurationHours` and the pre-arrival queue model.
*Architecture:* an inbound adapter per partner behind one normalised
`hinterland_slots` shape, consumed as an input to the risk engine's ops-duration
estimate. Natural fit for `delivery-worker` and the event bus.
*Value:* real but partner-gated; do not start before a design partner asks.

**C4 · Deprioritise: AI-to-AI negotiation.** Built, and built correctly. The
only defensible LLM addition is drafting the human-readable covering letter
around a number the deterministic engine chose.

---

## 3. Agent's own innovations — the X-factor

Three proposals. Each combines assets we *already own* in a way a competitor
without our engine structurally cannot copy.

### X1 · Portfolio Demurrage Value-at-Risk (with correlated weather)

**The insight.** Our pre-arrival engine prices one voyage. Every operator's
real question is about the **book**: *what is my demurrage exposure across all
open fixtures this quarter, and how bad is the bad case?*

The naive answer — simulate each voyage and add the P90s — is **wrong**, and
wrong in the direction that hurts. Two vessels calling at Rotterdam and
Antwerp in the same week are exposed to the *same North Sea depression*. Their
demurrage outcomes are correlated, so the portfolio's tail is **fatter** than
the sum of the individual tails. Anyone summing per-voyage percentiles is
systematically understating the exposure that actually breaks a quarter.

**Why only we can build it.** Because we sample **whole weather trajectories**
rather than per-hour marginals, correlation comes out for free: draw *one*
ensemble member index and apply the matching trajectory to every voyage in the
same weather system. Common random numbers across the portfolio is a three-line
change to `simulate.ts` — and it is only available to us because of the
trajectory-mixture decision made in Phase 5. A competitor with per-voyage point
estimates has no path to this at all.

**Architecture.** `src/lib/risk/portfolio.ts` (pure): takes N pre-arrival input
sets, groups voyages into weather-correlation clusters by great-circle distance
and ETA overlap, runs trials with a shared trajectory index per cluster, and
returns portfolio VaR / expected shortfall plus a per-voyage contribution
decomposition ("which fixture drives your tail"). Naturally a `risk-worker` job.

**Why it wins the room.** It reframes demurrage from an accounting nuisance into
a *risk position* — the language treasurers, credit committees and VCs already
speak. And the decomposition is directly actionable: it names the fixture to
re-nominate.

### X2 · Auto-priced parametric weather cover

**The insight.** `src/lib/insurance/` already ledgers parametric triggers when a
continuous weather delay exceeds a policy threshold. But the **premium** is
exogenous — somebody guesses it. Our Monte Carlo produces the exact payout
distribution for a given trigger, which is precisely what a fair premium is
computed from.

So: for any voyage, quote a parametric hedge — *"48h+ continuous weather delay
at this berth, USD 25k payout, premium USD 3,100"* — with the premium derived
from our own simulated payout distribution plus a stated loading.

**Why only we can build it.** An underwriter cannot accept a black-box price.
They can accept one where the seed, the inputs and the trajectories are stored
and the whole simulation replays to the cent — which is exactly what
`pre_arrival_risks` was designed to store. **The Phase 5 reproducibility work
is the thing that makes this insurable.** That is not a coincidence to explain
away; it is the moat compounding.

**Architecture.** `src/lib/insurance/pricing.ts` (pure): payout distribution
from the existing trial outcomes, expected loss, risk loading, and the quote.
Reuses `insurance_policies` / `insurance_triggers` for the lifecycle. The
honest constraint: **we are not an insurer.** Ship it as an origination and
pricing layer for a licensed capacity provider, with the quote clearly labelled
indicative until they bind it.

**Why it wins the room.** It turns a SaaS seat into a per-voyage transaction
with a completely different revenue multiple, and it is the natural buyer-side
answer to "so what do I do about a 72% probability?"

### X3 · Bilateral auto-reconciliation — the network effect

**The insight.** Today a claim is verifiable by *one* side. When both sides of a
charter run LayGrounded, the entire dispute reduces to a diff: both parties can
independently recompute from the same facts, so the only thing left to argue
about is *which facts*, not *what they imply*. We already have the pieces —
claim rooms, the charter-chain ripple (`parent_claim_id`), scoped grants, and
an engine both sides can run offline.

**The product.** A counterparty-consented "mutual recognition" handshake: two
tenants link their mirror claims, each side's confirmed events are exchanged
under an existing grant, and the system produces a **reconciliation statement**
— agreed events, disputed events, and the exact money each disagreement is
worth (which `sensitivity.ts` already computes). Settlement time collapses from
weeks of email to a signed diff.

**Why only we can build it.** It requires an engine both parties trust without
trusting each other — the offline verifier, already shipped and proven
byte-identical across two runtimes. Legacy vendors host a calculation and ask
you to believe it; two counterparties cannot both believe the same vendor's
assertion, which is precisely why demurrage is still settled by email.

**Why it wins the room.** This is the only item in this document with a genuine
**network effect**: each new tenant makes the product more valuable to their
counterparties, who are the exact sales targets. That is the defensibility
story a Series A actually underwrites — and unlike the others, it gets stronger
the more of the market adopts it.

*(Considered and rejected for now: a commodity-forward-curve overlay ranking
which vessel to prioritise by cargo carry cost. Genuinely novel, but the
economics only bite for a handful of cargoes, and it needs a paid market-data
licence for a narrow slice of value. Revisit when a trading-desk design partner
asks.)*

---

## 4. Phase 5 environment & API readiness

### 4.1 New in Phase 5

| Variable | Required? | Behaviour |
|---|---|---|
| `AIS_CONGESTION_PROVIDER` | optional | `datalastic` \| `mock`. **Unset ⇒ UNAVAILABLE, never mock.** The route refuses to simulate rather than invent a queue. |
| `DATALASTIC_API_KEY` | with `datalastic` | Live port congestion. **The mapping is written against Datalastic's documented shape but has never been exercised against the live endpoint** — treat first contact as unverified. |
| `ALLOW_MOCK_AIS_IN_PRODUCTION` | escape hatch | `1` permits mock when `NODE_ENV=production`. Without it, mock is refused outright. |

Weather needs **no key** — Open-Meteo ensemble (`gfs_seamless`, 30 members,
verified full 336h coverage) and the ERA5 archive are both open.

`.env.example` is now tracked (the `.env.*` ignore rule was catching it despite
`CLAUDE.md` telling new developers to copy it). It documents every variable.

### 4.2 API surface added in Phase 5

| Endpoint | Notes |
|---|---|
| `POST /api/risk/pre-arrival` | Runs and persists an assessment. Returns `decisionGrade` at the top level, plus seed, `inputsDigest`, distribution with per-statistic standard errors, provenance and caveats. 422 + actionable message when congestion is unmeasurable. |
| `GET /api/risk/pre-arrival` | Company-scoped list. |
| `GET /api/v1/claims/:id/verify` | **Format 1.1** — `bundle.published` now carries a whole `LaytimeResult`, so the verifier returns a real `matchesPublished` boolean. `comparableFields` is gone. |

**Not yet exposed on `/api/v1`.** Pre-arrival risk is session-authenticated
only. Promoting it to the public API is a small, high-value Phase 6 task — it
needs a `risk:read` scope and the dual-auth caller (**never** a `keys:*` scope;
see the handover).

### 4.3 Verified operational facts

- 5,000 trials ≈ **450ms** (90µs/trial), linear to 50k, flat memory. Wall-clock
  is dominated by weather fetches (1–5s) — **that is what to cache**, not the
  simulation.
- Whole-object verification confirmed through the sealed `.wasm` under
  `node:wasi`: GENCON 94 and ASBATANKVOY both verify, a tampered total is
  rejected by name, and the `.mjs` twin agrees byte-for-byte.
- Replay confirmed end-to-end against the live database across all three
  horizons: `inputsIntact=true, reproduced=true, diffs=0`.

### 4.4 Known gaps carried into Phase 6

1. **Datalastic unverified against the live API** (no key).
2. **No UI visual QA** on `/simulator/pre-arrival` — the chart was verified by
   geometry assertions, not by eye. Catches "renders nothing"; does not catch
   "looks wrong".
3. **Pre-arrival risk absent from `/api/v1`** (see 4.2).
4. **Cross-tenant matviews remain data-starved** — `port_congestion_stats` holds
   3 rows from 1 company; every k-anonymity floor suppresses. This is data
   maturity, not a code gap, and it gates B1 and the pricing oracle.
5. **`wasmtime` not installed locally**; CI is the only place the wasm runs
   under the runtime a third-party auditor would use.

---

## 5. Recommendation for Phase 6

**Start with Epic B3 — micro-movement SoF verification — and do X1 (Portfolio
VaR) alongside it.**

The reasoning:

- **B3 is the highest moat-per-hour item in the entire backlog.** Its first
  increment needs no new vendor, no partnership and no paid data — speed and
  heading-change are derivable from the AIS fixes we already fetch. (Draught is
  a second increment: `AisFix` carries position only today, so it needs an
  adapter change plus a provider check — see B3.) It slots into the existing
  `evidence_checks` verdict model, so it inherits the honesty discipline
  (`unavailable` ≠ "no delay") for free. And it strengthens the thing we already
  win on — objective fact — rather than opening a new front.
- **X1 is a three-line change to `simulate.ts` plus an aggregation module**,
  because the trajectory-mixture decision in Phase 5 already did the hard part.
  It is the highest-leverage unbuilt idea in this document and the one that most
  changes how the product is described in a pitch.
- **Both are pure modules with table-driven tests**, so they can be built and
  proven without any architectural change — which matters, because…

**Do the architecture in parallel, but only step 1.** Add `domain_events` and
the outbox writes now, while the system is small enough that retrofitting is
cheap. Do **not** extract workers yet: no current workload is failing, and an
extraction without an event log is strictly worse than the monolith.

**Explicitly defer:** C2 on-chain escrow (custody risk dwarfs the engineering),
B2 Free Pratique (no API exists for most jurisdictions), C3 hinterland (start
when a partner asks), and everything in Section 0 marked BUILT.

**One risk worth naming.** Gap 4 — data starvation — silently gates B1, the
pricing oracle, and the market-facing half of the story. No amount of
engineering fixes it; only tenants shipping real claims do. If the fundraising
narrative leans on cross-tenant intelligence, **seeding that corpus with design
partners is more urgent than any feature in this document.**
