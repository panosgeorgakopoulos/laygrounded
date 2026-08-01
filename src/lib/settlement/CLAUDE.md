# Settlement

Two layers. `clearinghouse.ts` decides whether a claim may settle and ledgers the money movement (`settlements`, cleared via `banking.ts`). `escrow.ts` generates the **instruction** a payment rail acts on — EIP-712 typed data for an on-chain escrow, and an ISO 20022 `pacs.008` draft for a bank. Generation is separate from execution on purpose: a payload can be reviewed, and `ready: false` is a normal outcome rather than an error.

## `escrow.ts` — four rules that decide what goes in the number

Each exists because the alternative moves money nobody agreed to move.

1. **Only undisputed, agreed claims settle.** `agreedAt` must be set and `openDisputes` must be zero. A blocked payload is still returned, with `blockers` explaining why — throwing would leave the UI nothing to show.
2. **A terminal shortfall is not a deduction without a basis.** Unchanged from Phase 6: a stipulated rate *derives* the laytime allowance and is not a warranty of terminal performance, so deducting the shortfall would double-count the rate and reverse the parties' risk allocation. Mirrors `attribution.ts`'s `DeductionBasis` gate exactly. Without one the shortfall is a **memo** and the payable is untouched.
3. **Carbon settles only when the allocation is determined.** `undetermined` means the tenant's side or the charterparty position has not been established. It is not zero, and it is not a receivable.
4. **Currencies are never netted.** ETS liability is EUR while a demurrage claim is routinely USD; inventing an FX rate to produce one tidy figure would move real money on a fabricated number. Components in different currencies become **separate legs**, which is exactly what pacs.008 models with multiple credit-transfer transactions. A mixed-currency group omits `CtrlSum` rather than adding EUR to USD.

**Sign convention:** every component is signed from the **owner's perspective**, the same one `diff.ts` uses. Demurrage is positive (earned by the owner); despatch is negative (paid by them). A positive despatch would make the charterer the debtor on a sum the owner owes — the payment running backwards. Party roles are fixed by the fixture, not by the tenant's perspective: demurrage runs charterer → owner regardless of who runs the software. Only the tenant-facing `direction` (`collect`/`pay`) flips.

A **trader** tenant blocks: they are routinely charterer on one fixture and disponent owner on the next, and guessing reintroduces the inference `tenant_role` removed.

## EIP-712 — what we deliberately do not do

`buildEip712` produces the typed-data object a wallet signs with `eth_signTypedData_v4`. **We do not compute the keccak-256 digest.** That would need keccak, which this project has no audited implementation of, and hand-rolling one to authorise money movement is a bad trade against handing the signer the structured object it already knows how to hash.

`digestOf()` is SHA-256 over `canonicalJson`. It pins **our** document for audit and idempotency. It is **not** the EIP-712 signing hash and the two must never be confused.

`encodeType` is exported because that is where implementations quietly diverge: no spaces, referenced structs appended in **alphabetical** order after the primary type. A mismatch produces a signature the contract rejects with no useful error, so it is pinned by a test.

Amounts cross to both rails as **strings**: minor units for the chain (a uint256 does not fit in a JS number), fixed-2dp for the bank (money through a JS number is how 0.1 + 0.2 reaches a payment instruction). `toMinorUnits` knows the ISO 4217 zero-decimal set — scaling JPY by 100 would inflate the payment a hundredfold.

## Agreement and the outbox

`claims.status` has no `agreed` value; agreement was previously implicit in `evaluateEligibility()`, which is derived state a trigger cannot compute. `claims.agreed_at` is the real transition:

```
POST /api/claims/:id/agree  ──▶ claims.agreed_at NULL→NOT NULL
                                       │ (trigger, same tx)
                                       ▼
                            domain_events 'claim.settlement_ready'
                                       │ (settlement-dispatch.ts)
                                       ▼
                              settlement_payloads
```

- The route is gated on the **same** eligibility test the clearinghouse uses. Agreement is the moment numbers stop being negotiable; it must not be a flag a user can set over an open dispute.
- `agreed_calculation_id` is pinned at agreement. A later recompute makes the current calculation diverge, and `escrow-server.ts` blocks the payload rather than settling numbers nobody signed off.
- The trigger has a `WHEN (OLD.agreed_at IS NULL AND NEW.agreed_at IS NOT NULL)` clause. Without it every later edit to an agreed claim would re-emit, and a downstream processor would see repeated instructions to move money. Verified live: a re-stamp and an unrelated edit produced no second event.
- `.is("agreed_at", null)` on the update decides the race — two concurrent agreements, one transition, one event.

## Terminal and carbon are caller-supplied, not loaded

**Neither is persisted anywhere.** `clause_flags` is keyed on `event_id` and holds only clause_ref/severity/note; the ETS addendum is generated as a PDF and `drafts` has no `ets_addendum` kind and no metadata column. So `escrow-server.ts` does **not** recompute them: the ETS figure depends on a live EUA price, and a mock price reaching a payment instruction is exactly what the provenance discipline exists to prevent. Both are optional arguments passed once a human has reviewed them; absent, they are excluded and `memos` says so.

## Party details — `counterparty_finance`

Bank and wallet details **are** loaded, and the distinction from terminal and carbon is the point. Those two are *derived figures* whose value depends on a live price or an unreviewed computation. An IBAN is a *stored fact* somebody typed in and validated. Loading a stored fact is not the same as inventing a derived one.

Where a detail is absent it stays absent — reported in `missingForBank` / `missingForChain` and emitted as `null` in the pacs.008. A placeholder would look complete and either fail at the bank or pay the wrong account.

- **`party_kind = 'self'`** is the tenant's own account (they are a party to their own settlements); **`'counterparty'`** is a trading partner, matched to `claims.counterparty_name` through `party_key = lower(trim(name))` with internal whitespace collapsed. There is no counterparties table — the claim carries free text — so the normalised key is the join.
- **`legal_name` is not the match key.** It is the account holder as the bank knows them: a transfer to "acme shipping ltd" against an account held by "ACME Shipping Limited" is rejected, or returned weeks later.
- **IBANs are checked with ISO 13616 MOD-97-10 plus the registry length**, cross-tested against `python-stdnum` over 1,190 generated cases (`scripts/settlement/build-iban-fixtures.py`). That cross-check is what found FK missing from the length table and five corrupted strings passing MOD-97 with check digits `00` — hence the 02–98 range check, where we are deliberately stricter than stdnum. A self-written IBAN test agrees with a self-written IBAN mistake.
- **A wallet requires a `chain_id`**, enforced by a DB CHECK: the same 20 bytes exist on every EVM chain and mean a different account on each. **EIP-55 checksums are not verified** — that needs keccak-256, the same reason `buildEip712` hands the signer the typed data rather than the digest. `isValidWalletAddress` returning `true` means well-formed, not real.
- **Two parties on different chains is a blocker, not a dropped chain leg.** Same reasoning as the currency rule: bridging is a custody decision nobody made.
- The chain context is only assembled when both parties agree on a chain **and** `SETTLEMENT_VERIFYING_CONTRACT` is configured. Without the contract there is no EIP-712 domain, and `missingForChain` says so rather than emitting a payload with a zero address in it.

Records go through `/api/settlement/counterparty-finance` on the **cookie client under RLS** — unlike `settlement_payloads`, which is generated and must never be user-editable, these are user data: somebody has to type the IBAN in.
