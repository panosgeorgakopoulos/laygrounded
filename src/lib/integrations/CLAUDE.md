# ERP integrations (bi-directional sync)

An abstract `ErpAdapter` (`adapter.ts`) owns the resilient transport — timeouts, Retry-After-aware 429 handling, jittered backoff on 5xx/network, auth-failure fail-fast — plus shared HMAC-SHA256 webhook verification, the `live | mock` provenance decision, and declared `capabilities`; concrete adapters only map payloads. `sync.ts` is the engine: an at-least-once outbound queue (`sync_jobs`) claimed by optimistic CAS (pending→running), backoff to dead-letter after 6 attempts, and a live-jobs unique index so re-enqueueing the same logical push dedupes. Inbound: `/api/integrations/[id]/webhook` (public, HMAC-authenticated, service-role) dedupes on the `webhook_logs` unique key — duplicates return `skipped_duplicate` — and voyage events upsert claims on `(company_id, external_source, external_ref)` so concurrent deliveries can't fork a voyage into two claims. `/api/integrations/run-sync` drains the queue (cron via `CRON_SECRET` header, or authenticated manual trigger); `/api/claims/[claimId]/push` enqueues an invoice/ledger push keyed on the calculation snapshot. Integration `auth` (API token, webhook secret, SOAP username/password) never leaves the server; the webhook secret is returned exactly once at creation.

## Providers

`registry.ts` is the single source of truth (`PROVIDERS`, `PROVIDER_IDS`, `getAdapter`).

| Provider | Transport | Mapping written against |
|---|---|---|
| `VESON_IMOS` (`veson.ts`) | GraphQL reads, REST writes | documented IMOS Platform shapes |
| `DANAOS` (`danaos.ts`) | SOAP 1.1 / XML, WS-Security UsernameToken | **product-family conventions — unverified** |
| `FORTUNE` (`fortune.ts`) | JSON/REST, `modifiedSince` cursor | **product-family conventions — unverified** |
| `ULYSSES` (`ulysses.ts`) | JSON/REST, `{entityType, attributes}` envelope | **product-family conventions — unverified** |
| `MOCK_ERP` (`mock.ts`) | none | the in-process test double |

**Three of the four mappings have never met a live tenant.** Only Veson follows published documentation; Danaos, Fortune and Ulysses publish no open API spec, so those adapters follow the general shape of that product generation. `mappingVerifiedAgainstVendorDocs` carries this to the UI so the claim "we integrate with Danaos" cannot quietly become "we have tested against Danaos". Every path, operation name and collection key is overridable via `integrations.config`, so first contact with a real tenant should be a **configuration** change, not a code change.

**Adding a provider is three changes, and the third is invisible to `tsc`:** an adapter class + a `getAdapter` case, an entry in `PROVIDERS`, and a **migration widening `integrations_provider_check`**. Without the migration everything type-checks, every test passes, and the INSERT fails against the live database.

## Mock mode and provenance

`config.mode = "mock"` serves deterministic fixtures (`fixtures.ts`) instead of calling the ERP. Two rules:

- **Mock is never inferred.** An integration with no credentials is `live` and fails loudly. Falling back to fixtures would produce an integration that looks connected, invents voyages, and books invoices against ships that were never fixed — the same failure `AIS_CONGESTION_PROVIDER` was designed against.
- **Mock is refused in production** unless `ALLOW_MOCK_ERP_IN_PRODUCTION=1`, on reads *and* pushes. `MOCK_ERP` itself is exempt: it is self-labelling and a user chose it by name.

Fixtures are seeded with the existing `makeRng` (never `Math.random`) and **external refs mix the seed in**. That is load-bearing: refs are the upsert key and `external_source` is the provider, so without it two mock DANAOS integrations in one company emit identical refs and overwrite each other's claims every sweep. A test pins this.

## `xml.ts` — deliberately small, deliberately hostile-input-first

Written rather than imported because the only XML here is a handful of SOAP shapes we define. It **refuses** `<!DOCTYPE` and `<!ENTITY` outright (XXE, billion-laughs) and bounds input size and nesting depth. Undeclared entities are left literal, never resolved. Namespace prefixes are ignored when navigating (`soap:`/`soapenv:`/`env:` all match `Body`).

**Known transport limitation:** SOAP stacks return HTTP 500 for a Fault, which the shared transport treats as retriable — a permanent fault burns four attempts before failing. Faults returned with HTTP 200 are detected and thrown immediately.

## Job kinds and capabilities

`push_invoice`, `push_ledger`, `push_pnl`, `pull_voyages`, `pull_schedules`. Each maps to a declared capability; `supportsJobKind` / `assertSupportsJobKind` reject an impossible job **at enqueue** with `UNSUPPORTED_JOB_KIND` rather than dead-lettering it six attempts later. A capability is a statement about what *this adapter* can do, not about what the ERP supports — Veson declares `pullSchedules: false` because no mapping exists, not because IMOS lacks itineraries.

`pull_schedules` lands in `erp_vessel_schedules`, **not** in `claims`. A schedule is a plan; promoting an ETA to a claim would fill a customer's book with port calls that have not happened. It exists to feed the pre-arrival risk engine an ETA an operator currently types by hand.

`push_pnl` recomputes the sheet rather than reading the last `voyage_pnl_results` snapshot, and carries `warnings` and each line's `excluded` flag through to the ERP — an ERP that re-adds an excluded line silently disagrees with our own net result, and one that drops the warnings books a provisional figure as final. Line amounts keep `PnlLine`'s sign convention exactly; do not re-sign them.

## The outbox bridge

`src/lib/events/erp-dispatch.ts` is the **first consumer of `domain_events`** and the reason ERP work never blocks a request. Two queues, on purpose:

```
state change ──trigger──▶ domain_events ──dispatch──▶ sync_jobs ──▶ ERP
               (same tx)                 (erp-dispatch)  (delivery)
```

An event is marked processed once its jobs are **enqueued**, never once the ERP accepted them — delivery belongs to `sync_jobs`, and waiting would rebuild a distributed transaction by hand. Policy decisions pinned by tests in `erp-dispatch.test.ts`:

- Only `completed` / `demurrage` / `despatch` claims push. A recompute fires on every edit; pushing drafts would stream contradictory demurrage figures into a customer's ERP.
- `risk.assessed` produces **no** ERP traffic — a Monte Carlo exposure is a prediction, and an ERP books facts.
- `settlement.changed` pushes only on `cleared`.
- An unrecognised event type produces nothing, so adding an event type can never surprise a customer's system.
- The claim's `company_id` is re-checked against the event's: the worker is service-role, so nothing else stops a malformed payload naming another tenant's claim.
- Sync-job idempotency keys derive from the **event's** key, so a redelivered event cannot double-push.

Route: `POST /api/events/dispatch` (cron via `CRON_SECRET`, or authenticated manual trigger), which dispatches and then drains.
