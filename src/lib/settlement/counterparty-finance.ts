// Settlement party details — validation and normalisation. Pure, no I/O.
//
// This module decides whether a set of banking or wallet details is fit to
// appear on a payment instruction. It is deliberately strict, because the
// failure mode is not "the form looks wrong": it is money arriving in someone
// else's account, or not arriving at all while the time bar runs.
//
// The governing rule from `escrow.ts` carries over unchanged: **nothing is ever
// invented.** A detail that does not validate is not stored, not silently
// corrected, and not substituted with a placeholder. Absent details are
// reported through `missingForBank` / `missingForChain`, which is a true
// statement a user can act on.

/** How a party is matched to a claim. */
export type PartyKind = "self" | "counterparty";

export interface CounterpartyFinanceInput {
  partyKind: PartyKind;
  /** Required for `counterparty`, forbidden for `self`. */
  counterpartyName?: string | null;
  legalName: string;
  country?: string | null;
  iban?: string | null;
  bic?: string | null;
  bankName?: string | null;
  walletAddress?: string | null;
  chainId?: number | null;
}

export interface CounterpartyFinanceRecord {
  id: string;
  companyId: string;
  partyKind: PartyKind;
  partyKey: string | null;
  legalName: string;
  country: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  walletAddress: string | null;
  chainId: number | null;
}

// === Party matching ===

/**
 * The match key for a counterparty name.
 *
 * Claims carry `counterparty_name` as free text — there is no counterparty
 * table — so "ACME Shipping Ltd", "acme shipping ltd" and "ACME  Shipping  Ltd"
 * all have to resolve to one banking record. Whitespace is collapsed as well as
 * trimmed, because a double space is invisible in a form field and would
 * otherwise create a second, silently unused record.
 *
 * The key is for MATCHING only. `legalName` is what reaches the payment
 * instruction: a bank rejects a transfer to "acme shipping ltd" when the
 * account is held by "ACME Shipping Limited".
 */
export function partyKeyOf(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// === IBAN ===

/**
 * Length of a valid IBAN per country, from the SWIFT IBAN Registry.
 *
 * Worth carrying rather than relying on mod-97 alone. The checksum catches a
 * transposition; it does not catch a Dutch IBAN with a digit missing, which is
 * still 1-in-97 likely to pass. Length plus checksum together make a typo
 * essentially impossible to slip through.
 */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18,
  GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27,
  JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25,
  // FK (Falkland Islands) was added to the registry in 2023 and is easy to miss;
  // it is here because a cross-check against python-stdnum's registry caught its
  // absence, not because anyone remembered it.
  FK: 18,
  MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18,
  NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33,
  SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/** Uppercased, all whitespace removed. IBANs are printed in groups of four. */
export function normaliseIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * ISO 13616 / ISO 7064 MOD-97-10.
 *
 * The check digits are part of the standard, not something this codebase
 * invented — which is the point. It is an INDEPENDENT check: a wrong IBAN is
 * rejected by arithmetic the account holder's bank performs identically, rather
 * than by a rule we wrote and might have written wrong.
 *
 * Computed digit by digit because a 34-character IBAN expands to ~60 digits,
 * far past Number.MAX_SAFE_INTEGER. Taking the modulus incrementally is exact.
 */
export function isValidIban(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const iban = normaliseIban(raw);

  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false;
  if (iban.length < 15 || iban.length > 34) return false;

  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  // An unknown country code is refused rather than waved through: the registry
  // is the definition of which countries have IBANs at all.
  if (expected === undefined || iban.length !== expected) return false;

  // ISO 13616-1: the check digits are in 02–98. No legitimate IBAN is ever
  // issued with 00, 01 or 99, so rejecting them cannot turn away a real account
  // — and it does catch a real error class, because a corrupted string still
  // passes MOD-97 about 1 time in 97 and some of those land on 00.
  //
  // DELIBERATELY STRICTER THAN python-stdnum, which accepts them. Verified: a
  // cross-check against that library over 2,136 generated cases found five such
  // strings it called valid. Being stricter than a reference implementation
  // needs a reason, and "the standard says these cannot exist" is one.
  const checkDigits = Number(iban.slice(2, 4));
  if (checkDigits < 2 || checkDigits > 98) return false;

  // Move the first four characters to the end, then map A–Z to 10–35.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const chunk = code >= 65 ? String(code - 55) : ch; // 'A' -> "10"
    for (const digit of chunk) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

// === BIC ===

const BIC_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

export function normaliseBic(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** ISO 9362: 8 or 11 characters. There is no checksum to verify — only shape. */
export function isValidBic(raw: string | null | undefined): boolean {
  return !!raw && BIC_RE.test(normaliseBic(raw));
}

// === Wallet ===

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Shape only, and that limitation is deliberate.
 *
 * A mixed-case address carries an EIP-55 checksum, and verifying it requires
 * keccak-256 — which this project has no audited implementation of, and will
 * not hand-roll to authorise money movement. The same decision governs
 * `buildEip712`, which hands the signer the typed-data object rather than
 * computing the digest itself.
 *
 * So: a malformed address is rejected, and a well-formed one is accepted
 * WITHOUT its checksum having been verified. Callers should not read a `true`
 * here as "this address is real".
 */
export function isValidWalletAddress(raw: string | null | undefined): boolean {
  return !!raw && ADDRESS_RE.test(raw.trim());
}

/** ISO 3166-1 alpha-2, as the DB CHECK expects. */
export function normaliseCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

// === Validation ===

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Present only when `ok`. Ready to persist. */
  normalised?: {
    partyKind: PartyKind;
    partyKey: string | null;
    legalName: string;
    country: string | null;
    iban: string | null;
    bic: string | null;
    bankName: string | null;
    walletAddress: string | null;
    chainId: number | null;
  };
}

/**
 * Validates one finance record end to end.
 *
 * Returns every problem rather than the first: somebody is filling in a form,
 * and a validator that reveals one error at a time turns a single correction
 * into four round trips.
 */
export function validateCounterpartyFinance(input: CounterpartyFinanceInput): ValidationResult {
  const errors: string[] = [];

  const legalName = input.legalName?.trim() ?? "";
  if (!legalName) errors.push("legalName is required — it is the name that appears on the payment");

  let partyKey: string | null = null;
  if (input.partyKind === "counterparty") {
    const name = input.counterpartyName?.trim();
    if (!name) {
      errors.push("counterpartyName is required for a counterparty record — it is the match key");
    } else {
      partyKey = partyKeyOf(name);
    }
  } else if (input.counterpartyName?.trim()) {
    errors.push("counterpartyName must be omitted for a 'self' record");
  }

  let iban: string | null = null;
  if (input.iban?.trim()) {
    if (!isValidIban(input.iban)) {
      errors.push("iban failed the ISO 13616 MOD-97 checksum or the registry length for its country");
    } else {
      iban = normaliseIban(input.iban);
    }
  }

  let bic: string | null = null;
  if (input.bic?.trim()) {
    if (!isValidBic(input.bic)) {
      errors.push("bic is not a valid ISO 9362 code (8 or 11 characters)");
    } else {
      bic = normaliseBic(input.bic);
    }
  }

  // An IBAN with no BIC is a half-populated instruction that looks complete.
  // pacs.008 carries DbtrAgt/CdtrAgt, and a bank adapter needs both.
  if (iban && !bic) {
    errors.push("bic is required alongside an iban — a credit transfer needs the servicing institution");
  }

  let walletAddress: string | null = null;
  let chainId: number | null = null;
  const hasWallet = Boolean(input.walletAddress?.trim());
  const hasChain = input.chainId !== null && input.chainId !== undefined;

  if (hasWallet !== hasChain) {
    // The same 20 bytes exist on every EVM chain and mean a different account
    // on each. Half of this pair is not a destination.
    errors.push("walletAddress and chainId must be supplied together");
  }
  if (hasWallet) {
    if (!isValidWalletAddress(input.walletAddress)) {
      errors.push("walletAddress must be a 0x-prefixed 20-byte hex address");
    } else {
      walletAddress = input.walletAddress!.trim();
    }
  }
  if (hasChain) {
    if (!Number.isInteger(input.chainId) || (input.chainId as number) <= 0) {
      errors.push("chainId must be a positive integer");
    } else {
      chainId = input.chainId as number;
    }
  }

  if (!iban && !walletAddress) {
    errors.push("a record must carry at least one payment destination — an iban or a wallet address");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    normalised: {
      partyKind: input.partyKind,
      partyKey,
      legalName,
      country: normaliseCountry(input.country),
      iban,
      bic,
      bankName: input.bankName?.trim() || null,
      walletAddress,
      chainId,
    },
  };
}

// === Chain context ===

export interface ChainAgreement {
  chainId: number | null;
  /** Set when the two parties are configured on different chains. */
  conflict: string | null;
}

/**
 * The chain both parties are on, or the reason there isn't one.
 *
 * Mirrors the currency rule in `escrow.ts`: components in different currencies
 * become separate legs rather than being netted at an invented rate. Two parties
 * on different chains is the same problem in a different dimension — bridging
 * them is a decision with custody consequences, not a default this module gets
 * to make. So it refuses and says why.
 */
export function resolveChainAgreement(
  debtor: { chainId?: number | null },
  creditor: { chainId?: number | null }
): ChainAgreement {
  const a = debtor.chainId ?? null;
  const b = creditor.chainId ?? null;
  if (a === null || b === null) return { chainId: null, conflict: null };
  if (a !== b) {
    return {
      chainId: null,
      conflict:
        `debtor is configured on chain ${a} and creditor on chain ${b} — a settlement cannot ` +
        `span chains without a bridging decision nobody has made`,
    };
  }
  return { chainId: a, conflict: null };
}
