# Outbound webhooks (hinterland supply-chain sync)

Notifies a tenant's logistics partners when a vessel delay is large enough that trucks and trains booked against the original window should be re-planned. The marine delay is knowable days before the hinterland one; telling the partner early is the product.

**There is one webhook registry, `api_webhooks`** — the table the Audit Trail API already used `(id, company_id, url, secret, event_types, status, config)`. A second `webhook_subscriptions` table was deliberately **not** created: it would give one customer two places to register endpoints, two secrets to rotate, and a split delivery ledger. New event types need no migration (`event_types` is a `text[]` with no CHECK). SSRF is guarded at registration by `assertPublicWebhookUrl` in `/api/v1/webhooks`, and `redirect: "error"` on delivery stops a 3xx bouncing a signed payload to an internal address.

## `signing.ts` — two schemes, on purpose

| Header | Scheme |
|---|---|
| `x-laygrounded-signature` | **v1**: `sha256=<hmac(body)>` — what every existing integration verifies today |
| `x-laygrounded-signature-v2` | **v2**: `t=<unix>,v1=<hmac("<t>.<body>")>` — timestamped, replay-resistant |

v1 carries no timestamp, so a captured delivery replays forever against a consumer that only checks the signature. v2 fixes that, and the timestamp is signed **into** the string rather than merely sent alongside — a header the signature does not cover can simply be rewritten by whoever replays the body. The `.` separator is load-bearing: without it `t=1` + body `"23X"` and `t=123` + body `"X"` sign identically.

Both headers ship on every delivery. **Do not remove v1 unilaterally** — that is a breaking change to someone else's production system and belongs in a deprecation window. `verifySignatureV2` is exported so our tests and any partner documentation describe one implementation; it reports *why* verification failed (`stale` vs `mismatch` sends an integrator to completely different places), and checks staleness **before** the HMAC compare so a correctly-signed replay reads as stale.

## `hinterland.ts` — the decision, kept pure

Two refusals matter more than the threshold:

1. **Never fire on a statistic we do not have.** The trigger is the **P90** of waiting + stoppage hours. Where `p90_waiting_hours` is NULL (assessments predating the column) the answer is `statistic_unavailable`, never the mean — a mean wait of 10h routinely hides a P90 of 40h, so substituting it would understate exactly the tail the notification exists to warn about.
2. **Never fire on a forecast we would not trust.** `decisionGrade` is already false when any input was mock or synthetic. Re-planning a rail slot on synthetic congestion is worse than not calling.

Threshold defaults to 24h, overridable per subscription via `config.hinterland_delay_threshold_hours`. `thresholdFor()` rejects `0`, negatives and non-numerics back to the default: a misconfigured `0` would page the partner on every voyage and train them to ignore us, which is the expensive failure.

Payloads state `basis: "forecast" | "observed"` and carry an `interpretation` sentence. A partner committing assets must not read a P90 as "the vessel is late".

`hinterland.stoppage` is derived from **non-counting breakdown rows**, not from `EXCEPTED_PERIOD_START` events. An event in the timeline is a *claim* about an interruption; a non-counting breakdown row is the engine's *verdict* on it under the charterparty. Only the second has moved money.

## `delivery.ts` — retries, which did not exist before

The previous path set `attempts: 1` and never tried again: a partner whose endpoint blipped for ten seconds simply never learned. Now the same shape as `sync_jobs` — enqueue, optimistic CAS claim, jittered backoff, dead-letter at `MAX_DELIVERY_ATTEMPTS` (6).

Failures are **classified before retry**: 5xx / 408 / 429 / network are retriable; every other 4xx dead-letters immediately, because retrying an unchanged body against a deterministic rejection just burns attempts and delays the dead letter a human needs to see. Idempotency is the existing `UNIQUE (webhook_id, idempotency_key)`.

## Multi-consumer outbox — read this before adding a third consumer

`domain_events.processed_at` is a **single flag**. It supported exactly one consumer, and adding the hinterland one alongside `erp-dispatch` would have meant whichever swept first marked the event processed and the other never saw it — ERP pushes stopping silently, with no error anywhere.

`domain_event_consumptions (event_id, consumer, processed_at, attempts, last_error)` is the fix, read through the `unprocessed_domain_events(consumer, limit, after)` RPC (an anti-join PostgREST cannot express; `SECURITY DEFINER`, EXECUTE revoked from `public, anon, authenticated` **by name**).

- Use `readUnprocessedFor` / `markProcessedBy` / `markFailedBy`, never the single-flag originals.
- Add the consumer's name to `CONSUMERS` in `outbox.ts`. **The names are persisted and are effectively schema** — renaming one resets its cursor and replays the whole log through it.
- `domain_events.processed_at` is still stamped as an "at least one consumer handled this" audit signal. It is no longer the gate; nothing should start reading it as one again.
- Each consumer retries and dead-letters independently, so a poisoned handler cannot starve another. `webhook-dispatch.test.ts` pins this.
