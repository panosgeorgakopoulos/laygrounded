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
node laygrounded-verify.mjs < conformance.json      # engine rule set 1
node laygrounded-verify.mjs < conformance-v2.json   # engine rule set 2
```

```json
{ "cases": 500, "passed": 500, "failed": 0, "root": "bc9f24fdab910a1b" }
{ "cases": 500, "passed": 500, "failed": 0, "root": "261e3468d2246f30" }
```

Compare each `root` against `manifest.json`. Each suite is 500 generated voyages
spanning weather exclusions, SHEX/SSHEX weekends, WIBON/WIPON shifting, port
strikes, all four ASBATANKVOY behaviours, and the error paths.

## Two rule sets, and why the old one is still here

A charterparty calculation is evidence. Once a figure has been served,
notarised or agreed, it has to keep reproducing — including in 2035, and
including when we later find a mistake in how it was produced. So the engine
does not replace rules, it versions them.

| Rule set | Root | What it is |
|---|---|---|
| 1 | `bc9f24fdab910a1b` | The rules as published through 2026-07. **Frozen.** |
| 2 | `261e3468d2246f30` | One correction: an agreed excepted period is deducted under GENCON 94 + SHINC. |

The defect in rule set 1: under GENCON 94 with a **SHINC** days basis, an
`EXCEPTED_PERIOD` the parties agreed — a strike, an agreed suspension — was
absorbed by the "Sundays and holidays included" rule and never deducted. SHINC
deletes the *weekend* exception; it says nothing about exceptions the parties
agreed on that voyage (Cl. 7(c)). Every other form and basis deducted correctly,
and rule set 2 changes that branch alone.

**A bundle says which rules produced it**, on `cpTerms.engine_version`. Absent
means 1 — which is why every bundle issued before this existed still verifies
without modification. The verifier does not guess and does not upgrade: handed a
rule-set-1 bundle it applies rule set 1, and reproduces the figure on the
document even where that figure is now known to be understated.

Replaying rule set 1's 500 cases under rule set 2 changes **none** of them: the
published suite never exercised the defective combination. The 44 cases that do
exercise it are in `conformance-v2.json`, where they deduct under Cl. 7(c) and
would not have been expressible at all under rule set 1.

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
produce an identical conformance root **for every rule set**, executed in two
different engines (wasmtime for the wasm, Node for the JS). An artifact that
agreed on rule set 1 and diverged on 2 would verify a legacy claim and quietly
misjudge a current one — the worse failure, because the number it produced would
still look authoritative. A 1.7 MB WebAssembly blob is not auditable by
reading — that is exactly why the readable file ships beside it.

### What the published hashes do and do not prove

`laygrounded-verify.mjs` is **reproducible**: build it from the same source and
you get the same bytes, so its SHA-256 is something you can check yourself.

`laygrounded-verify.wasm` is **not**. Javy emits different bytes for
byte-identical input — we verified this, two builds of the same file differ
inside the embedded QuickJS section — so the published wasm hash confirms you
received the artifact we published, and nothing more. It is a
distribution-integrity check, not a build attestation.

The claim that *is* reproducible is each `conformance.root`. It is behavioural:
run either artifact against `conformance.json` and you should get
`bc9f24fdab910a1b`, and against `conformance-v2.json`, `261e3468d2246f30`. Those
are the numbers to rely on, and they are why the roots exist at all.

## Bundle format

```jsonc
{
  "claim":   { "vessel": "…", "voyageRef": "…", "port": "…" },  // optional
  "cpTerms": { "laytime_allowed_hours": 72, "days_basis": "SHEX",
               "engine_version": 2, … },   // omit for rule set 1
  "events":  [ { "id": "…", "occurred_at": "2026-03-02T06:00:00Z",
                 "event_type": "NOR_TENDERED" }, … ],
  "published": { "totals": { … }, "breakdown": [ … ] }          // optional
}
```

Omit `published` to compute the figures rather than check them.

### Notarised bundles carry their derivation

A claim pack exported from LayGrounded also carries a `derivation` record inside
its notarised Merkle snapshot, committing to three things a bare
inputs-and-outputs proof left unstated:

| Leaf | Commits to |
|---|---|
| `engine` | Which engine computed it, by behavioural fingerprint |
| `tzdata` | The timezone transitions **for this claim's port**, carried in the bundle |
| `ordering` | The exact event order used, and the rule that produced it |

The timezone leaf is the one worth understanding. Same-instant events and
weekend boundaries both depend on the port's local calendar, so the transitions
travel *with the claim* rather than being read from your machine. A counterparty
can dispute the table on the record; a re-run in 2035 uses the rules that applied
in 2026; and none of it depends on your computer's ICU. It costs under a
kilobyte.

Tampering with any of the three changes the Merkle root, which breaks the
RFC-3161 timestamp — so the derivation is as tamper-evident as the figures.

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
