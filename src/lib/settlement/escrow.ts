// Settlement payload generation — pure, deterministic, no I/O.
//
// Turns an AGREED claim into something a payment rail can act on: an EIP-712
// typed-data object for an on-chain escrow, and an ISO 20022 pacs.008 draft for
// a bank. Both describe the same money, derived once.
//
// FOUR RULES THAT DECIDE WHAT GOES IN THE NUMBER. Each exists because the
// alternative moves money that nobody agreed to move.
//
//  1. **Only undisputed components settle.** Anything a counterparty has open
//     is reported as a memo and excluded from the payable. Escrow is for the
//     part both sides already agree on; the rest is what negotiation is for.
//
//  2. **A terminal shortfall is NOT a deduction unless a basis says so.** This
//     is the Phase 6 decision, unchanged: a stipulated rate *derives* the
//     laytime allowance, it is not a warranty of terminal performance, and
//     deducting the shortfall would double-count the rate and reverse the
//     parties' risk allocation. `attribution.ts` gates deductions behind an
//     explicit `DeductionBasis`; so does this module. Without one the shortfall
//     is a priced negotiating position, and it settles nothing.
//
//  3. **Carbon settles only when the allocation is determined.** `undetermined`
//     means we have not established which side of the cargo the tenant is on,
//     or have not read the charterparty. It is not zero, and it is not a
//     receivable.
//
//  4. **Currencies are never netted without an agreed FX rate.** ETS liability
//     is denominated in EUR while a demurrage claim is routinely USD. Inventing
//     a rate to produce one tidy figure would move real money on a number
//     nobody agreed. Components in different currencies become SEPARATE
//     settlement legs — which is exactly what pacs.008 models with multiple
//     credit-transfer transactions.
//
// Determinism: no clock, no randomness, no floating-point arithmetic on money
// (decimal.js throughout, as everywhere else in this codebase). Every timestamp
// is an input. The same inputs always produce byte-identical output, which is
// what makes the digest meaningful.

import Decimal from "decimal.js";
import { canonicalJson } from "@/lib/legal/prosecution";

// === Inputs ===

export type SettlementDirection = "collect" | "pay";

export interface SettlementParty {
  /** Legal name as it should appear on the payment instruction. */
  name: string;
  /** IBAN or other account identifier. Absent is a real state. */
  accountId?: string | null;
  /** BIC of the account-servicing institution. */
  bic?: string | null;
  country?: string | null;
  /** Ethereum address, when this settlement has an on-chain leg. */
  walletAddress?: string | null;
}

export interface AgreedCalculation {
  calculationId: string;
  demurrageAmount: number;
  despatchAmount: number;
  currency: string;
  computedAt: string;
}

/**
 * A terminal-performance shortfall.
 *
 * `deductionBasis` is the gate. It mirrors `attribution.ts` exactly: without a
 * stated `owner_fault` or `cp_clause` basis, the shortfall is not deductible
 * and must not reduce the settled amount.
 */
export interface TerminalShortfall {
  shortfallValue: number;
  currency: string;
  deductionBasis: { kind: "owner_fault" | "cp_clause"; reference: string } | null;
}

/** EU-ETS carbon liability, already allocated by `ets-addendum.ts`. */
export interface CarbonLiability {
  amountEur: number;
  /** `receivable` and `payable` settle; `none` and `undetermined` do not. */
  direction: "receivable" | "payable" | "none" | "undetermined";
  basis: string;
}

export interface EscrowInput {
  claim: {
    id: string;
    reference: string;
    vessel: string;
    voyageRef: string | null;
    port: string;
  };
  calculation: AgreedCalculation;
  /** Set when the claim was agreed; the payload is refused without it. */
  agreedAt: string | null;
  /** Counterparty proposals still open. Any open item blocks settlement. */
  openDisputes: number;
  terminal?: TerminalShortfall | null;
  carbon?: CarbonLiability | null;
  /** Who pays and who is paid, once direction is known. */
  owner: SettlementParty;
  charterer: SettlementParty;
  /** The tenant's side, deciding which party is debtor. */
  tenantRole: "owner" | "charterer" | "trader" | null;
  /** On-chain context. Omit for a bank-only settlement. */
  chain?: { chainId: number; verifyingContract: string; tokenAddress?: string | null } | null;
  /** Deterministic issuance stamp — an input, never `new Date()`. */
  issuedAt: string;
}

// === Outputs ===

export interface SettlementComponent {
  key: string;
  label: string;
  /** Signed as it affects the payable: positive increases, negative reduces. */
  amount: number;
  currency: string;
  /** False when the component is reported but excluded from the payable. */
  settles: boolean;
  /** Why it is excluded, when it is. */
  exclusionReason: string | null;
  basis: string;
}

export interface SettlementLeg {
  currency: string;
  amount: number;
  /** Minor units (cents) as an integer string — what a chain and a ledger want. */
  amountMinorUnits: string;
  direction: SettlementDirection;
  debtor: SettlementParty;
  creditor: SettlementParty;
  components: string[];
}

export interface Eip712TypedData {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

export interface Pacs008Draft {
  GrpHdr: {
    MsgId: string;
    CreDtTm: string;
    NbOfTxs: string;
    CtrlSum: string;
    SttlmInf: { SttlmMtd: string };
  };
  CdtTrfTxInf: Array<Record<string, unknown>>;
}

export interface SettlementPayload {
  claimId: string;
  calculationId: string;
  /** Deterministic: same inputs, same id. */
  settlementRef: string;
  issuedAt: string;
  components: SettlementComponent[];
  legs: SettlementLeg[];
  eip712: Eip712TypedData | null;
  iso20022: Pacs008Draft | null;
  /** SHA-256 over the canonical payload. See `digestOf`. */
  ready: boolean;
  blockers: string[];
  /** Fields a rail requires that we do not have. Never invented. */
  missingForBank: string[];
  missingForChain: string[];
  memos: string[];
}

const dec = (n: number) => new Decimal(n);
const money = (d: Decimal) => {
  const n = d.toDecimalPlaces(2).toNumber();
  return n === 0 ? 0 : n;
};

// ISO 20022 length limits. Truncation is deterministic (leading characters
// kept) rather than a hash, so a human reading a bank statement can still
// recognise the reference.
const MAX_MSG_ID = 35;
const MAX_END_TO_END_ID = 35;

/**
 * Builds the settlement payload for an agreed claim.
 *
 * Always returns a payload. `ready` says whether it may be acted on, and
 * `blockers` says why not — a caller that needs to explain the refusal to a
 * user gets the reasons rather than an exception.
 */
export function buildSettlementPayload(input: EscrowInput): SettlementPayload {
  const blockers: string[] = [];
  const memos: string[] = [];

  if (!input.agreedAt) {
    blockers.push("claim is not agreed — settlement payloads are only generated after agreement");
  }
  if (input.openDisputes > 0) {
    blockers.push(
      `${input.openDisputes} counterparty proposal(s) still open — only undisputed amounts settle`
    );
  }

  const components = buildComponents(input, memos);
  const settling = components.filter((c) => c.settles);

  // Direction comes from the principal (the laytime component), not from the
  // net: a despatch owed by the owner does not become a demurrage receivable
  // because a carbon line happened to be larger.
  const principal = components.find((c) => c.key === "demurrage" || c.key === "despatch");
  if (!principal) blockers.push("no demurrage or despatch amount — nothing to settle");

  const legs = buildLegs(input, settling, blockers);
  if (legs.length === 0 && blockers.length === 0) {
    blockers.push("every settleable component nets to zero");
  }

  const missingForBank = missingBankFields(legs);
  const missingForChain = missingChainFields(input, legs);

  const settlementRef = deriveSettlementRef(input);
  const ready = blockers.length === 0;

  return {
    claimId: input.claim.id,
    calculationId: input.calculation.calculationId,
    settlementRef,
    issuedAt: input.issuedAt,
    components,
    legs,
    eip712:
      input.chain && legs.length > 0 && missingForChain.length === 0
        ? buildEip712(input, legs[0], settlementRef)
        : null,
    iso20022: legs.length > 0 ? buildPacs008(input, legs, settlementRef) : null,
    ready,
    blockers,
    missingForBank,
    missingForChain,
    memos,
  };
}

// === Components ===

function buildComponents(input: EscrowInput, memos: string[]): SettlementComponent[] {
  const out: SettlementComponent[] = [];
  const { demurrageAmount, despatchAmount, currency } = input.calculation;

  if (demurrageAmount > 0) {
    out.push({
      key: "demurrage",
      label: "Demurrage",
      amount: money(dec(demurrageAmount)),
      currency,
      settles: true,
      exclusionReason: null,
      basis: `Laytime calculation ${input.calculation.calculationId}`,
    });
  } else if (despatchAmount > 0) {
    out.push({
      key: "despatch",
      label: "Despatch",
      // NEGATIVE, because every component in this ledger is signed from the
      // OWNER's perspective — the same perspective `diff.ts` uses for the money
      // delta. Demurrage is earned by the owner; despatch is paid by them. A
      // positive despatch here would make the charterer the debtor on a sum the
      // owner owes, which is the payment running backwards.
      amount: money(dec(despatchAmount).neg()),
      currency,
      settles: true,
      exclusionReason: null,
      basis: `Laytime calculation ${input.calculation.calculationId}`,
    });
  }

  // --- Terminal shortfall: gated behind an explicit basis (rule 2) ---
  if (input.terminal && input.terminal.shortfallValue > 0) {
    const deductible = input.terminal.deductionBasis !== null;
    if (deductible) {
      out.push({
        key: "terminal_deduction",
        label: "Terminal underperformance deduction",
        // Reduces the payable.
        amount: money(dec(input.terminal.shortfallValue).neg()),
        currency: input.terminal.currency,
        settles: true,
        exclusionReason: null,
        basis: `${input.terminal.deductionBasis!.kind}: ${input.terminal.deductionBasis!.reference}`,
      });
    } else {
      out.push({
        key: "terminal_shortfall_memo",
        label: "Terminal underperformance (not deducted)",
        amount: money(dec(input.terminal.shortfallValue)),
        currency: input.terminal.currency,
        settles: false,
        exclusionReason:
          "no deduction basis stated — a stipulated rate derives the laytime allowance and is " +
          "not a warranty of terminal performance, so the shortfall is a negotiating position",
        basis: "Terminal rate attribution",
      });
      memos.push(
        "A terminal underperformance figure exists but does not reduce this settlement. " +
          "Record an owner_fault or cp_clause basis if it is genuinely deductible."
      );
    }
  }

  // --- Carbon: only when allocation is determined (rule 3) ---
  if (input.carbon && input.carbon.amountEur > 0) {
    const determined =
      input.carbon.direction === "receivable" || input.carbon.direction === "payable";
    out.push({
      key: "ets_carbon",
      label: "EU-ETS carbon liability",
      amount: money(
        input.carbon.direction === "payable"
          ? dec(input.carbon.amountEur).neg()
          : dec(input.carbon.amountEur)
      ),
      currency: "EUR",
      settles: determined,
      exclusionReason: determined
        ? null
        : input.carbon.direction === "undetermined"
          ? "ETS liability allocation is undetermined — the charterparty position or the " +
            "tenant's role on this fixture has not been established"
          : "no ETS liability arises for this call",
      basis: input.carbon.basis,
    });
    if (!determined) {
      memos.push(
        "EU-ETS carbon cost is excluded from settlement because its allocation is not determined."
      );
    }
  }

  return out;
}

// === Legs (one per currency — rule 4) ===

function buildLegs(
  input: EscrowInput,
  settling: SettlementComponent[],
  blockers: string[]
): SettlementLeg[] {
  const byCurrency = new Map<string, SettlementComponent[]>();
  for (const c of settling) {
    byCurrency.set(c.currency, [...(byCurrency.get(c.currency) ?? []), c]);
  }

  const legs: SettlementLeg[] = [];
  for (const [currency, comps] of [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const total = comps.reduce((acc, c) => acc.plus(dec(c.amount)), new Decimal(0));
    const amount = money(total.abs());
    if (amount === 0) continue;

    // A leg whose components net negative has flipped direction: the party who
    // would have collected now pays. Stated explicitly rather than encoded in a
    // sign, which is this codebase's convention for money that changes hands.
    const collects = total.greaterThanOrEqualTo(0);
    const direction = resolveDirection(input, collects);
    const { debtor, creditor } = resolveParties(input, direction, collects);

    legs.push({
      currency,
      amount,
      amountMinorUnits: toMinorUnits(amount, currency),
      direction,
      debtor,
      creditor,
      components: comps.map((c) => c.key),
    });
  }

  if (input.tenantRole === "trader" && legs.length > 0) {
    blockers.push(
      "tenant role is 'trader' — the paying and receiving side cannot be determined without " +
        "establishing which side of this fixture the tenant is on"
    );
  }
  if (input.tenantRole === null && legs.length > 0) {
    blockers.push("tenant role is not recorded — cannot determine debtor and creditor");
  }

  return legs;
}

/** `collect` = money flows to the tenant. */
function resolveDirection(input: EscrowInput, collects: boolean): SettlementDirection {
  // Demurrage is owed BY the charterer TO the owner. An owner collecting is the
  // ordinary case; a charterer in the same position is paying.
  const tenantIsOwner = input.tenantRole === "owner";
  const tenantCollects = tenantIsOwner ? collects : !collects;
  return tenantCollects ? "collect" : "pay";
}

function resolveParties(
  input: EscrowInput,
  _direction: SettlementDirection,
  collects: boolean
): { debtor: SettlementParty; creditor: SettlementParty } {
  // Party roles are fixed by the fixture, not by the tenant's perspective:
  // demurrage runs charterer → owner regardless of who is running the software.
  return collects
    ? { debtor: input.charterer, creditor: input.owner }
    : { debtor: input.owner, creditor: input.charterer };
}

/**
 * Minor units as an integer string.
 *
 * Zero-decimal currencies (JPY, KRW) genuinely have no minor unit; multiplying
 * them by 100 would inflate a payment a hundredfold. The list is the ISO 4217
 * zero-decimal set.
 */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "XOF", "XAF", "XPF"]);

export function toMinorUnits(amount: number, currency: string): string {
  const exponent = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  return dec(amount).times(Decimal.pow(10, exponent)).toDecimalPlaces(0).toFixed(0);
}

// === Missing-field reporting (never invented) ===

function missingBankFields(legs: SettlementLeg[]): string[] {
  const missing = new Set<string>();
  for (const leg of legs) {
    if (!leg.debtor.name) missing.add("debtor.name");
    if (!leg.debtor.accountId) missing.add("debtor.accountId");
    if (!leg.debtor.bic) missing.add("debtor.bic");
    if (!leg.creditor.name) missing.add("creditor.name");
    if (!leg.creditor.accountId) missing.add("creditor.accountId");
    if (!leg.creditor.bic) missing.add("creditor.bic");
  }
  return [...missing].sort();
}

function missingChainFields(input: EscrowInput, legs: SettlementLeg[]): string[] {
  const missing = new Set<string>();
  if (!input.chain) return [];
  if (!input.chain.verifyingContract) missing.add("chain.verifyingContract");
  if (!Number.isInteger(input.chain.chainId) || input.chain.chainId <= 0) {
    missing.add("chain.chainId");
  }
  for (const leg of legs) {
    if (!isAddress(leg.debtor.walletAddress)) missing.add("debtor.walletAddress");
    if (!isAddress(leg.creditor.walletAddress)) missing.add("creditor.walletAddress");
  }
  return [...missing].sort();
}

export function isAddress(value: string | null | undefined): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

// === EIP-712 ===

const SETTLEMENT_TYPES: Eip712TypedData["types"] = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  Settlement: [
    { name: "settlementRef", type: "string" },
    { name: "claimRef", type: "string" },
    { name: "calculationId", type: "string" },
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "currency", type: "string" },
    { name: "issuedAt", type: "uint256" },
  ],
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * The typed-data object a wallet signs with `eth_signTypedData_v4`.
 *
 * WE DELIBERATELY DO NOT COMPUTE THE KECCAK-256 DIGEST. Producing the 32-byte
 * hash requires keccak, which this project has no audited implementation of,
 * and hand-rolling one to authorise money movement is a bad trade against
 * simply handing the signer the structured object it already knows how to hash.
 * The signer (wallet, HSM, or the escrow contract itself) derives the digest.
 *
 * `digestOf()` below is a SHA-256 over our canonical JSON. It pins OUR payload
 * for audit and idempotency; it is NOT the EIP-712 signing hash, and the two
 * must never be confused.
 */
function buildEip712(
  input: EscrowInput,
  leg: SettlementLeg,
  settlementRef: string
): Eip712TypedData {
  return {
    types: SETTLEMENT_TYPES,
    primaryType: "Settlement",
    domain: {
      name: "LayGrounded Settlement",
      version: "1",
      chainId: input.chain!.chainId,
      verifyingContract: input.chain!.verifyingContract,
    },
    message: {
      settlementRef,
      claimRef: input.claim.reference,
      calculationId: input.calculation.calculationId,
      payer: leg.debtor.walletAddress ?? ZERO_ADDRESS,
      payee: leg.creditor.walletAddress ?? ZERO_ADDRESS,
      token: input.chain!.tokenAddress ?? ZERO_ADDRESS,
      // Minor units as a decimal string: a uint256 does not fit in a JS number,
      // and JSON.stringify would render a BigInt-sized value as a float.
      amount: leg.amountMinorUnits,
      currency: leg.currency,
      issuedAt: String(Math.floor(new Date(input.issuedAt).getTime() / 1000)),
    },
  };
}

/**
 * The canonical EIP-712 type string.
 *
 * Exported because this is where implementations quietly diverge: no spaces,
 * referenced structs appended in ALPHABETICAL order after the primary type. A
 * mismatch here produces a signature the contract rejects, with no useful error.
 */
export function encodeType(
  primaryType: string,
  types: Eip712TypedData["types"]
): string {
  const referenced = new Set<string>();
  const visit = (name: string) => {
    for (const field of types[name] ?? []) {
      const base = field.type.replace(/\[\d*\]$/, "");
      if (types[base] && base !== primaryType && !referenced.has(base)) {
        referenced.add(base);
        visit(base);
      }
    }
  };
  visit(primaryType);

  const render = (name: string) =>
    `${name}(${(types[name] ?? []).map((f) => `${f.type} ${f.name}`).join(",")})`;

  return [primaryType, ...[...referenced].sort()].map(render).join("");
}

// === ISO 20022 pacs.008 ===

/**
 * A `FIToFICstmrCdtTrf` draft.
 *
 * A DRAFT, not a message: it carries no BIC routing envelope and is not
 * schema-validated against the vendor's pacs.008.001.xx variant. It is the
 * business content, shaped so a bank adapter maps it field-for-field.
 *
 * Amounts are strings with a fixed decimal count. ISO 20022 amounts are decimal
 * types, and rendering money through a JS number is how a 0.1 + 0.2 lands on a
 * payment instruction.
 */
function buildPacs008(
  input: EscrowInput,
  legs: SettlementLeg[],
  settlementRef: string
): Pacs008Draft {
  const ctrlSum = legs.reduce((acc, l) => acc.plus(dec(l.amount)), new Decimal(0));

  return {
    GrpHdr: {
      MsgId: truncate(`LG-${settlementRef}`, MAX_MSG_ID),
      CreDtTm: input.issuedAt,
      NbOfTxs: String(legs.length),
      // Only meaningful when every leg shares a currency; ISO 20022 defines
      // CtrlSum as a plain sum, so a mixed-currency group deliberately omits it
      // rather than adding EUR to USD.
      CtrlSum: allSameCurrency(legs) ? ctrlSum.toFixed(2) : "",
      SttlmInf: { SttlmMtd: "INDA" },
    },
    CdtTrfTxInf: legs.map((leg, i) => ({
      PmtId: {
        InstrId: truncate(`${settlementRef}-${i + 1}`, MAX_END_TO_END_ID),
        EndToEndId: truncate(`${input.claim.reference}-${leg.currency}`, MAX_END_TO_END_ID),
      },
      IntrBkSttlmAmt: { Ccy: leg.currency, value: dec(leg.amount).toFixed(2) },
      ChrgBr: "SHAR",
      Dbtr: { Nm: leg.debtor.name, CtryOfRes: leg.debtor.country ?? null },
      DbtrAcct: { Id: { IBAN: leg.debtor.accountId ?? null } },
      DbtrAgt: { FinInstnId: { BICFI: leg.debtor.bic ?? null } },
      Cdtr: { Nm: leg.creditor.name, CtryOfRes: leg.creditor.country ?? null },
      CdtrAcct: { Id: { IBAN: leg.creditor.accountId ?? null } },
      CdtrAgt: { FinInstnId: { BICFI: leg.creditor.bic ?? null } },
      RmtInf: {
        Ustrd: [
          truncate(
            `Laytime settlement ${input.claim.reference} ${input.claim.vessel} ${input.claim.port}`,
            140
          ),
          truncate(`Components: ${leg.components.join(", ")}`, 140),
        ],
      },
    })),
  };
}

function allSameCurrency(legs: SettlementLeg[]): boolean {
  return new Set(legs.map((l) => l.currency)).size <= 1;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

// === Identity and digest ===

/**
 * A stable reference for this settlement.
 *
 * Derived from claim + calculation, so re-running the same agreed calculation
 * produces the same reference and a downstream processor dedupes naturally.
 * A recalculation changes `calculationId`, which is a genuinely different
 * settlement and must not collide with the previous one.
 */
export function deriveSettlementRef(input: EscrowInput): string {
  const claimPart = input.claim.id.replace(/-/g, "").slice(0, 12);
  const calcPart = input.calculation.calculationId.replace(/-/g, "").slice(0, 8);
  return `${claimPart}-${calcPart}`.toUpperCase();
}

/**
 * SHA-256 over the canonical payload.
 *
 * NOT the EIP-712 signing hash — see `buildEip712`. This pins our document for
 * audit and idempotency. `canonicalJson` is the same serializer the verifier
 * uses, so key order cannot change the digest (Postgres jsonb does not preserve
 * it) and `undefined` is skipped while `null` is serialized.
 *
 * Async because it uses WebCrypto, which is available in both the Node and Edge
 * runtimes; `node:crypto` is not.
 */
export async function digestOf(payload: SettlementPayload): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
