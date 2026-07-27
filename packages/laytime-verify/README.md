# LayGrounded offline verifier

Re-run a laytime and demurrage calculation yourself, offline, without trusting
LayGrounded.

If you are an arbitrator, a P&I club, a charterer's counsel or a lender, the
question you actually have is *"do these figures follow from these facts?"* This
artifact answers it on your own machine. There is no network call, no account, no
configuration, and nothing that depends on LayGrounded still existing.

## Why the numbers are reproducible

Two design decisions, both deliberate:

- **The engine is pure.** It reads no clock, no database, no randomness. Given
  the same events and charterparty terms it returns the same result, always.
- **Timezones come from a pinned table, not from your computer.** Laytime
  exclusions turn on the port's local calendar, and runtimes disagree about
  timezone data — on one machine we measured Node exposing 418 zones and Bun 445.
  IANA also reissues *historical* offsets from time to time. So the offsets were
  read once, committed as data, and digested. A calculation cannot drift because
  a runtime shipped an update.

## Verify a claim

```
node laygrounded-verify.mjs < claim-bundle.json      # readable artifact
wasmtime laygrounded-verify.wasm < claim-bundle.json # no toolchain required
```

Output:

```json
{
  "verifierVersion": "1.0.0",
  "tzdataDigest": "e9ddffc8…",
  "recomputed": { "totals": { … }, "breakdown": [ … ] },
  "matchesPublished": false,
  "discrepancies": [
    { "field": "totals.demurrage_amount", "published": 58333.33, "recomputed": 53333.33 }
  ]
}
```

A failed verification names the figure and the amount. "Does not verify" on its
own is not useful to a tribunal.

## Check the verifier before you trust it

Its agreement on your claim only means something if it agrees on cases published
in advance. Run the conformance suite:

```
node laygrounded-verify.mjs < conformance.json
```

```json
{ "cases": 500, "passed": 500, "failed": 0, "root": "bc9f24fdab910a1b" }
```

Compare `root` against the value in `manifest.json`. The suite is 500 generated
voyages spanning weather exclusions, SHEX/SSHEX weekends, WIBON/WIPON shifting,
port strikes, all four ASBATANKVOY behaviours, and the error paths.

`root` fingerprints **what the artifact computes**, not whether it matched the
goldens — that is `failed`. The distinction matters: it is why two artifacts
sharing a root have genuinely computed the same thing, rather than having failed
in the same way.

## Two artifacts, one source

| | Size | For |
|---|---|---|
| `laygrounded-verify.mjs` | ~250 KB | Reading. Your expert can audit it; roughly 50 KB is logic and the rest is the timezone table. |
| `laygrounded-verify.wasm` | ~1.7 MB | Running. No Node, no npm, no install. |

Both are built from the same source, and CI refuses to publish unless they
produce an identical conformance root, executed in two different engines. A
1.7 MB WebAssembly blob is not auditable by reading — that is exactly why the
readable file ships beside it.

## Bundle format

```jsonc
{
  "claim":   { "vessel": "…", "voyageRef": "…", "port": "…" },  // optional
  "cpTerms": { "laytime_allowed_hours": 72, "days_basis": "SHEX", … },
  "events":  [ { "id": "…", "occurred_at": "2026-03-02T06:00:00Z",
                 "event_type": "NOR_TENDERED" }, … ],
  "published": { "totals": { … }, "breakdown": [ … ] }          // optional
}
```

Omit `published` to compute the figures rather than check them.

## Limits, stated plainly

- The pinned table covers **2000–2040**. Outside it the verifier refuses rather
  than guessing.
- An unrecognised timezone is an error, never a silent fall back to UTC. A
  plausible-looking wrong number in a legal document is the worst outcome.
- This verifies **arithmetic against asserted facts**. It cannot tell you the
  statement of facts is honest — for that, see the evidence verification and
  RFC-3161 notarisation in the claim pack.
- `root` uses a non-cryptographic digest for speed; it is an integrity check, not
  a signature. A bundle's authenticity rests on its RFC-3161 timestamp token,
  which you verify separately with `openssl ts -verify`.

Apache-2.0.
