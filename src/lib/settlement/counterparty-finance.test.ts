/// <reference types="bun-types" />
// Settlement party details.
//
// The IBAN section is checked against an INDEPENDENT implementation rather than
// against expectations written by whoever wrote the validator. Self-written
// tests agree with self-written mistakes, and an IBAN validator that agrees with
// itself is exactly the sort of thing that pays money into the wrong account.
//
// `__fixtures__/iban-stdnum.json` was generated from `python-stdnum`'s own IBAN
// registry (89 countries) and its ISO 13616 MOD-97-10 implementation, by
// `scripts/settlement/build-iban-fixtures.py`. It carries both the length table
// and 1,190 verdicts. Two things came out of that cross-check that no
// hand-written test would have found: the Falkland Islands were missing from our
// length table, and five corrupted strings passed MOD-97 with check digits `00`,
// which is why we now enforce the 02–98 range the standard specifies.

import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  isValidBic,
  isValidIban,
  isValidWalletAddress,
  normaliseIban,
  partyKeyOf,
  resolveChainAgreement,
  validateCounterpartyFinance,
} from "./counterparty-finance";

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "__fixtures__/iban-stdnum.json"), "utf8")
) as {
  lengths: Record<string, number>;
  nationalCheckCountries: string[];
  cases: Array<{ iban: string; expect: boolean }>;
};

describe("IBAN — cross-checked against python-stdnum", () => {
  it("agrees on every generated verdict", () => {
    const disagreements = FIXTURES.cases
      .filter((c) => isValidIban(c.iban) !== c.expect)
      .map((c) => `${c.iban}: ours=${isValidIban(c.iban)} stdnum=${c.expect}`);
    expect(disagreements).toEqual([]);
  });

  it("covers both outcomes — a validator that always said false would pass otherwise", () => {
    const valid = FIXTURES.cases.filter((c) => c.expect).length;
    expect(valid).toBeGreaterThan(400);
    expect(FIXTURES.cases.length - valid).toBeGreaterThan(400);
  });

  it("knows every country in the registry, and invents none", () => {
    const ours = new Set(
      fs
        .readFileSync(path.join(import.meta.dir, "counterparty-finance.ts"), "utf8")
        .split("const IBAN_LENGTHS: Record<string, number> = {")[1]
        .split("};")[0]
        .matchAll(/([A-Z]{2}):\s*(\d+)/g)
    );
    const mine = Object.fromEntries([...ours].map((m) => [m[1], Number(m[2])]));
    expect(mine).toEqual(FIXTURES.lengths);
  });

  it("normalises the printed grouping banks actually use", () => {
    expect(normaliseIban("gb33 bukb 2020 1555 5555 55")).toBe("GB33BUKB20201555555555");
    expect(isValidIban("gb33 bukb 2020 1555 5555 55")).toBe(true);
  });

  it("rejects check digits the standard says cannot exist", () => {
    // 02–98 per ISO 13616-1. Deliberately stricter than stdnum, which accepts
    // these when MOD-97 happens to land on 1.
    expect(isValidIban("GB00BUKB20201555555555")).toBe(false);
    expect(isValidIban("GB99BUKB20201555555555")).toBe(false);
  });

  it("rejects an unknown country code rather than waving it through", () => {
    expect(isValidIban("ZZ33BUKB20201555555555")).toBe(false);
  });

  it("documents where our scope ends", () => {
    // These four countries define an EXTRA national check over the BBAN that we
    // do not implement. Recorded rather than silently skipped: a reader needs to
    // know a valid-looking Belgian IBAN passes here on ISO grounds alone.
    expect(FIXTURES.nationalCheckCountries).toEqual(["BE", "ES", "ME", "NO"]);
  });
});

describe("BIC", () => {
  it("accepts 8 and 11 character codes", () => {
    expect(isValidBic("BUKBGB22")).toBe(true);
    expect(isValidBic("BUKBGB22XXX")).toBe(true);
    expect(isValidBic("deutdeff")).toBe(true); // normalised before testing
  });

  it("rejects the wrong shape", () => {
    expect(isValidBic("BUKBGB2")).toBe(false); // 7
    expect(isValidBic("BUKBGB22XX")).toBe(false); // 10
    expect(isValidBic("BUKB1B22")).toBe(false); // digit in the country position
  });
});

describe("wallet address", () => {
  it("accepts a well-formed address", () => {
    expect(isValidWalletAddress("0x" + "a".repeat(40))).toBe(true);
    expect(isValidWalletAddress("0x" + "A".repeat(40))).toBe(true);
  });

  it("rejects malformed ones", () => {
    expect(isValidWalletAddress("0x" + "a".repeat(39))).toBe(false);
    expect(isValidWalletAddress("a".repeat(42))).toBe(false);
    expect(isValidWalletAddress(null)).toBe(false);
  });

  it("does NOT verify the EIP-55 checksum, and must not claim to", () => {
    // A mixed-case address carries a checksum that needs keccak-256 to verify,
    // and this project deliberately has no keccak — the same decision that keeps
    // us from computing the EIP-712 digest. A caller must not read `true` as
    // "this address is real".
    const badChecksum = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
    expect(isValidWalletAddress(badChecksum)).toBe(true);
  });
});

describe("party matching", () => {
  it("collapses the variations a form produces", () => {
    expect(partyKeyOf("  ACME Shipping   Ltd ")).toBe("acme shipping ltd");
    expect(partyKeyOf("acme shipping ltd")).toBe(partyKeyOf("ACME  SHIPPING  LTD"));
  });
});

describe("record validation", () => {
  const base = {
    partyKind: "self" as const,
    legalName: "Probe Shipping Ltd",
    iban: "GB33BUKB20201555555555",
    bic: "BUKBGB22",
  };

  it("accepts a complete bank record", () => {
    const r = validateCounterpartyFinance(base);
    expect(r.ok).toBe(true);
    expect(r.normalised?.iban).toBe("GB33BUKB20201555555555");
    expect(r.normalised?.partyKey).toBe(null);
  });

  it("requires a BIC alongside an IBAN", () => {
    const r = validateCounterpartyFinance({ ...base, bic: null });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("bic is required"))).toBe(true);
  });

  it("requires a destination of some kind", () => {
    const r = validateCounterpartyFinance({ partyKind: "self", legalName: "X" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("at least one payment destination"))).toBe(true);
  });

  it("refuses a wallet without a chain — the same bytes mean a different account per chain", () => {
    const r = validateCounterpartyFinance({
      partyKind: "self",
      legalName: "X",
      walletAddress: "0x" + "a".repeat(40),
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("must be supplied together"))).toBe(true);
  });

  it("requires a counterparty name as the match key, and forbids one on 'self'", () => {
    expect(validateCounterpartyFinance({ ...base, partyKind: "counterparty" }).ok).toBe(false);
    expect(
      validateCounterpartyFinance({ ...base, partyKind: "counterparty", counterpartyName: "ACME Ltd" })
        .normalised?.partyKey
    ).toBe("acme ltd");
    expect(
      validateCounterpartyFinance({ ...base, counterpartyName: "ACME Ltd" }).ok
    ).toBe(false);
  });

  it("reports every problem at once, not the first", () => {
    const r = validateCounterpartyFinance({
      partyKind: "counterparty",
      legalName: "",
      iban: "NOPE",
      bic: "!!",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("chain agreement", () => {
  it("agrees when both parties are on one chain", () => {
    expect(resolveChainAgreement({ chainId: 1 }, { chainId: 1 })).toEqual({
      chainId: 1,
      conflict: null,
    });
  });

  it("is silent, not conflicted, when either side has no chain configured", () => {
    expect(resolveChainAgreement({ chainId: 1 }, {})).toEqual({ chainId: null, conflict: null });
    expect(resolveChainAgreement({}, {})).toEqual({ chainId: null, conflict: null });
  });

  it("refuses to span chains rather than picking one", () => {
    const r = resolveChainAgreement({ chainId: 1 }, { chainId: 137 });
    expect(r.chainId).toBe(null);
    expect(r.conflict).toContain("cannot span chains");
  });
});
