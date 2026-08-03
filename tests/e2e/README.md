# End-to-end suite

```bash
bun run test:e2e         # headless, starts its own dev server on :3100
bun run test:e2e:ui      # Playwright's watch UI
```

Playwright starts the app itself (`dev:e2e`), so no setup is needed. Locally it
reuses a server already listening on the port; in CI it always starts its own,
because a stale server from a previous job would test the wrong build.

## What this covers that `bun test` cannot

The unit suite covers pure logic thoroughly — 2,700+ tests. It cannot reach the
browser: native `confirm()`/`prompt()` dialogs, real navigation, and the moment
a component's assumption about an API's shape turns out to be wrong.

Three of the last four phases found defects only by looking at a rendered page —
a money field showing `undefined NaN`, a conformance root from the wrong engine
rule set, a map rendering nine times taller than its frame. Writing this suite
immediately found three more:

| Found | What it was |
|---|---|
| `Input` had no label association | No `htmlFor`/`id`, so screen readers announced every labelled field as unlabelled and clicking a label did not focus it |
| Two panels were not landmarks | `<section>` with no accessible name is not exposed as a region at all — a screen-reader user navigating by landmark skipped straight past them |
| **Grant revocation recorded no reason** | The UI sent `reason` in a JSON body; the route reads it from the query string. Revocation worked, so every server-side check passed — and every revocation was logged as an unexplained action |

The third is the one worth internalising. Nothing was broken, nothing errored,
and no unit test could have seen it: the button was wired to the wrong transport
and only an assertion about what appears on screen *afterwards* caught it.

## Why the suite does not clean up after itself

**There is no claim-deletion route, and this suite did not add one.** A claim is
evidence — it carries notarisation anchors, an audit ledger and possibly a
settlement instruction. Adding a destructive endpoint so a test could tidy up
would be a product decision made for a test's convenience, and that endpoint
would eventually be called by something other than a test.

Every artifact instead carries a per-run id (`E2E PATHFINDER <RUN>`), so
leftovers are identifiable and removable deliberately:

```sql
-- Remove E2E claims and everything that cascades from them.
delete from public.claims where vessel like 'E2E PATHFINDER %';
```

Run that when the demo tenant gets noisy. It is a manual step on purpose.

## Configuration

| Variable | Default | Why |
|---|---|---|
| `E2E_PORT` | `3100` | Keeps a developer's own `bun run dev` on :3000 from colliding with a run |
| `E2E_BASE_URL` | `http://localhost:$E2E_PORT` | Point at a deployed environment instead |
| `E2E_EMAIL` / `E2E_PASSWORD` | the seeded demo account | The suite signs in rather than creating a user, so a failure never leaves an auth record behind |
| `E2E_DISABLE_RATE_LIMIT` | set by the config | See below |

### The rate-limit exemption

The proxy applies a 100-request/minute per-IP anti-flood bucket to `/api`. One
browser walking the golden path loads a twelve-panel workspace four times over
and clears that ceiling well before the run finishes — the tests then failed on
a 429 that surfaced in the UI as **"Claim not found"**, which reads exactly like
a product bug and is not one.

`E2E_DISABLE_RATE_LIMIT=1` skips the bucket, and is honoured **only when
`NODE_ENV !== "production"`** — the same gate the synthetic AIS track uses. A
limiter any environment variable can switch off is not a limiter.

## Serial, one worker

The path mutates one shared demo tenant: it creates a claim, confirms an event,
raises a dispute, issues a grant. Parallel workers would race on that tenant and
produce failures that look like product bugs. E2E speed is not worth a suite
nobody trusts.
