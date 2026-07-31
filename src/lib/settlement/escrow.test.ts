// Settlement payload generation.
//
// Every test here guards money leaving an account. The four rules in
// `escrow.ts` — undisputed only, no deduction without a basis, no carbon
// without a determined allocation, no netting across currencies — each get a
// block, because each one exists to stop a payment nobody agreed to.

import { describe, expect, test } from "bun:test";
import {
  buildSettlementPayload,
  deriveSettlementRef,
  digestOf,
  encodeType,
  isAddress,
  toMinorUnits,
  type EscrowInput,
} from "./escrow";

const ISSUED_AT = "2026-08-01T12:00:00.000Z";
const CLAIM_ID = "44444444-4444-4444-4444-444444444444";
const CALC_ID = "99999999-8888-7777-6666-555555555555";

function input(over: Partial<EscrowInput> = {}): EscrowInput {
  return {
    claim: {
      id: CLAIM_ID,
      reference: "VOY-4201",
      vessel: "AEGEAN TRADER",
      voyageRef: "4201/2026",
      port: "Rotterdam",
    },
    calculation: {
      calculationId: CALC_ID,
      demurrageAmount: 125_000,
      despatchAmount: 0,
      currency: "USD",
      computedAt: "2026-07-30T00:00:00.000Z",
    },
    agreedAt: "2026-07-31T09:00:00.000Z",
    openDisputes: 0,
    terminal: null,
    carbon: null,
    owner: { name: "Hellenic Owners S.A.", accountId: "GR16..", bic: "ETHNGRAA", country: "GR" },
    charterer: { name: "Adriatic Commodities BV", accountId: "NL91..", bic: "ABNANL2A", country: "NL" },
    tenantRole: "owner",
    chain: null,
    issuedAt: ISSUED_AT,
    ...over,
  };
}

describe("rule 1 — only undisputed, agreed claims settle", () => {
  test("an agreed, undisputed claim is ready", () => {
    const p = buildSettlementPayload(input());
    expect(p.ready).toBe(true);
    expect(p.blockers).toEqual([]);
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0].amount).toBe(125_000);
  });

  test("an unagreed claim is blocked", () => {
    const p = buildSettlementPayload(input({ agreedAt: null }));
    expect(p.ready).toBe(false);
    expect(p.blockers.join(" ")).toContain("not agreed");
  });

  test("an open proposal blocks, and says how many", () => {
    const p = buildSettlementPayload(input({ openDisputes: 3 }));
    expect(p.ready).toBe(false);
    expect(p.blockers.join(" ")).toContain("3 counterparty proposal");
  });

  test("a payload is still returned when blocked, so the UI can explain", () => {
    // Throwing would leave a caller with nothing to show the user.
    const p = buildSettlementPayload(input({ agreedAt: null, openDisputes: 1 }));
    expect(p.blockers).toHaveLength(2);
    expect(p.components.length).toBeGreaterThan(0);
    expect(p.settlementRef).toBeTruthy();
  });

  test("a zero calculation has nothing to settle", () => {
    const p = buildSettlementPayload(
      input({ calculation: { ...input().calculation, demurrageAmount: 0, despatchAmount: 0 } })
    );
    expect(p.ready).toBe(false);
    expect(p.blockers.join(" ")).toContain("nothing to settle");
  });
});

describe("rule 2 — a terminal shortfall is not a deduction without a basis", () => {
  const shortfall = { shortfallValue: 20_000, currency: "USD" };

  test("without a basis it is a memo, and the payable is untouched", () => {
    // The Phase 6 decision: a stipulated rate derives the laytime allowance and
    // is not a warranty of terminal performance. Deducting it would
    // double-count the rate and reverse the parties' risk allocation.
    const p = buildSettlementPayload(input({ terminal: { ...shortfall, deductionBasis: null } }));

    expect(p.legs[0].amount).toBe(125_000); // NOT 105,000
    const memo = p.components.find((c) => c.key === "terminal_shortfall_memo")!;
    expect(memo.settles).toBe(false);
    expect(memo.exclusionReason).toContain("not a warranty");
    expect(p.memos.join(" ")).toContain("does not reduce this settlement");
  });

  test("with a cp_clause basis it reduces the payable", () => {
    const p = buildSettlementPayload(
      input({
        terminal: {
          ...shortfall,
          deductionBasis: { kind: "cp_clause", reference: "Clause 12(b)" },
        },
      })
    );
    expect(p.legs[0].amount).toBe(105_000);
    const line = p.components.find((c) => c.key === "terminal_deduction")!;
    expect(line.settles).toBe(true);
    expect(line.amount).toBe(-20_000);
    expect(line.basis).toContain("Clause 12(b)");
  });

  test("with an owner_fault basis it also reduces", () => {
    const p = buildSettlementPayload(
      input({
        terminal: {
          ...shortfall,
          deductionBasis: { kind: "owner_fault", reference: "crane breakdown log" },
        },
      })
    );
    expect(p.legs[0].amount).toBe(105_000);
  });

  test("a deduction larger than the claim flips who pays", () => {
    // Stated as a direction rather than a negative amount, per this codebase's
    // convention for money that changes hands.
    const p = buildSettlementPayload(
      input({
        terminal: {
          shortfallValue: 200_000,
          currency: "USD",
          deductionBasis: { kind: "cp_clause", reference: "Clause 12(b)" },
        },
      })
    );
    expect(p.legs[0].amount).toBe(75_000);
    expect(p.legs[0].direction).toBe("pay");
    expect(p.legs[0].debtor.name).toBe("Hellenic Owners S.A.");
  });
});

describe("rule 3 — carbon settles only when the allocation is determined", () => {
  test("a receivable allocation is included", () => {
    const p = buildSettlementPayload(
      input({ carbon: { amountEur: 5_000, direction: "receivable", basis: "BIMCO ETS clause" } })
    );
    const eur = p.legs.find((l) => l.currency === "EUR")!;
    expect(eur.amount).toBe(5_000);
  });

  test("an undetermined allocation is excluded and explained", () => {
    // Undetermined is not zero. It means we have not established which side of
    // the cargo the tenant is on, or have not read the charterparty.
    const p = buildSettlementPayload(
      input({ carbon: { amountEur: 5_000, direction: "undetermined", basis: "no clause read" } })
    );
    expect(p.legs.some((l) => l.currency === "EUR")).toBe(false);
    const line = p.components.find((c) => c.key === "ets_carbon")!;
    expect(line.settles).toBe(false);
    expect(line.exclusionReason).toContain("undetermined");
    expect(p.memos.join(" ")).toContain("allocation is not determined");
  });

  test("a 'none' allocation is excluded", () => {
    const p = buildSettlementPayload(
      input({ carbon: { amountEur: 5_000, direction: "none", basis: "outside EU scope" } })
    );
    expect(p.legs.some((l) => l.currency === "EUR")).toBe(false);
  });

  test("a payable allocation runs the other way", () => {
    const p = buildSettlementPayload(
      input({
        tenantRole: "charterer",
        carbon: { amountEur: 5_000, direction: "payable", basis: "BIMCO ETS clause" },
      })
    );
    const eur = p.legs.find((l) => l.currency === "EUR")!;
    expect(eur.amount).toBe(5_000);
    expect(eur.debtor.name).toBe("Hellenic Owners S.A.");
  });
});

describe("rule 4 — currencies are never netted", () => {
  test("EUR carbon and USD demurrage become separate legs", () => {
    // Netting would need an FX rate nobody agreed. Inventing one moves real
    // money on a fabricated number.
    const p = buildSettlementPayload(
      input({ carbon: { amountEur: 5_000, direction: "receivable", basis: "clause" } })
    );

    expect(p.legs).toHaveLength(2);
    expect(p.legs.map((l) => l.currency)).toEqual(["EUR", "USD"]); // sorted, deterministic
    expect(p.legs.find((l) => l.currency === "USD")!.amount).toBe(125_000);
    expect(p.legs.find((l) => l.currency === "EUR")!.amount).toBe(5_000);
  });

  test("a mixed-currency pacs.008 omits CtrlSum rather than summing across currencies", () => {
    const p = buildSettlementPayload(
      input({ carbon: { amountEur: 5_000, direction: "receivable", basis: "clause" } })
    );
    expect(p.iso20022!.GrpHdr.CtrlSum).toBe("");
    expect(p.iso20022!.GrpHdr.NbOfTxs).toBe("2");
  });

  test("a single-currency group does carry CtrlSum", () => {
    const p = buildSettlementPayload(input());
    expect(p.iso20022!.GrpHdr.CtrlSum).toBe("125000.00");
  });

  test("same-currency components DO net within their leg", () => {
    const p = buildSettlementPayload(
      input({
        terminal: {
          shortfallValue: 25_000,
          currency: "USD",
          deductionBasis: { kind: "cp_clause", reference: "C12" },
        },
      })
    );
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0].amount).toBe(100_000);
  });
});

describe("debtor and creditor", () => {
  test("demurrage runs charterer → owner", () => {
    const p = buildSettlementPayload(input());
    expect(p.legs[0].debtor.name).toBe("Adriatic Commodities BV");
    expect(p.legs[0].creditor.name).toBe("Hellenic Owners S.A.");
  });

  test("party roles do not change with the tenant's perspective", () => {
    // Demurrage runs charterer → owner regardless of who runs the software.
    const asCharterer = buildSettlementPayload(input({ tenantRole: "charterer" }));
    expect(asCharterer.legs[0].debtor.name).toBe("Adriatic Commodities BV");
    expect(asCharterer.legs[0].creditor.name).toBe("Hellenic Owners S.A.");
    // Only the tenant-facing direction flips.
    expect(asCharterer.legs[0].direction).toBe("pay");
    expect(buildSettlementPayload(input()).legs[0].direction).toBe("collect");
  });

  test("despatch runs owner → charterer", () => {
    const p = buildSettlementPayload(
      input({
        calculation: { ...input().calculation, demurrageAmount: 0, despatchAmount: 30_000 },
      })
    );
    expect(p.legs[0].debtor.name).toBe("Hellenic Owners S.A.");
    expect(p.components[0].key).toBe("despatch");
  });

  test("a trader tenant blocks — the paying side cannot be determined", () => {
    // A trader is routinely charterer on one fixture and disponent owner on the
    // next. Guessing reintroduces exactly the inference tenant_role removed.
    const p = buildSettlementPayload(input({ tenantRole: "trader" }));
    expect(p.ready).toBe(false);
    expect(p.blockers.join(" ")).toContain("trader");
  });

  test("an unrecorded tenant role blocks", () => {
    const p = buildSettlementPayload(input({ tenantRole: null }));
    expect(p.ready).toBe(false);
    expect(p.blockers.join(" ")).toContain("not recorded");
  });
});

describe("missing rail fields are reported, never invented", () => {
  test("absent IBAN/BIC are listed for the bank rail", () => {
    const p = buildSettlementPayload(
      input({ charterer: { name: "Adriatic Commodities BV", accountId: null, bic: null } })
    );
    expect(p.missingForBank).toEqual(["debtor.accountId", "debtor.bic"]);
    // The pacs.008 is still produced, with nulls where the data is absent —
    // a placeholder IBAN would look complete and pay the wrong account.
    expect(p.iso20022!.CdtTrfTxInf[0]).toMatchObject({
      DbtrAcct: { Id: { IBAN: null } },
    });
  });

  test("no EIP-712 without wallet addresses", () => {
    const p = buildSettlementPayload(
      input({ chain: { chainId: 1, verifyingContract: "0x" + "a".repeat(40) } })
    );
    expect(p.eip712).toBeNull();
    expect(p.missingForChain).toContain("debtor.walletAddress");
  });

  test("no chain context means no chain leg and no complaint", () => {
    const p = buildSettlementPayload(input());
    expect(p.eip712).toBeNull();
    expect(p.missingForChain).toEqual([]);
  });
});

describe("EIP-712", () => {
  const withChain = input({
    chain: {
      chainId: 1,
      verifyingContract: "0x" + "a".repeat(40),
      tokenAddress: "0x" + "b".repeat(40),
    },
    owner: { ...input().owner, walletAddress: "0x" + "1".repeat(40) },
    charterer: { ...input().charterer, walletAddress: "0x" + "2".repeat(40) },
  });

  test("produces a signable typed-data object", () => {
    const p = buildSettlementPayload(withChain);
    expect(p.eip712).not.toBeNull();
    expect(p.eip712!.primaryType).toBe("Settlement");
    expect(p.eip712!.domain).toMatchObject({ chainId: 1, name: "LayGrounded Settlement" });
    expect(p.eip712!.message.payer).toBe("0x" + "2".repeat(40)); // charterer pays
    expect(p.eip712!.message.payee).toBe("0x" + "1".repeat(40));
  });

  test("amount is minor units as a STRING, not a float", () => {
    // A uint256 does not fit in a JS number, and JSON.stringify would render a
    // large value in exponential form.
    const p = buildSettlementPayload(withChain);
    expect(p.eip712!.message.amount).toBe("12500000");
    expect(typeof p.eip712!.message.amount).toBe("string");
  });

  test("encodeType is canonical: no spaces, referenced structs sorted", () => {
    // Where implementations quietly diverge. A mismatch produces a signature
    // the contract rejects with no useful error.
    const types = {
      Settlement: [
        { name: "amount", type: "uint256" },
        { name: "payee", type: "Party" },
        { name: "asset", type: "Asset" },
      ],
      Party: [{ name: "wallet", type: "address" }],
      Asset: [{ name: "token", type: "address" }],
    };
    expect(encodeType("Settlement", types)).toBe(
      "Settlement(uint256 amount,Party payee,Asset asset)Asset(address token)Party(address wallet)"
    );
  });

  test("encodeType follows nested references and ignores array suffixes", () => {
    const types = {
      Root: [{ name: "legs", type: "Leg[]" }],
      Leg: [{ name: "party", type: "Party" }],
      Party: [{ name: "wallet", type: "address" }],
    };
    expect(encodeType("Root", types)).toBe(
      "Root(Leg[] legs)Leg(Party party)Party(address wallet)"
    );
  });

  test("the real Settlement type encodes stably", () => {
    const p = buildSettlementPayload(withChain);
    expect(encodeType("Settlement", p.eip712!.types)).toBe(
      "Settlement(string settlementRef,string claimRef,string calculationId,address payer,address payee,address token,uint256 amount,string currency,uint256 issuedAt)"
    );
  });
});

describe("ISO 20022 pacs.008", () => {
  test("carries the business content a bank adapter maps", () => {
    const p = buildSettlementPayload(input());
    const tx = p.iso20022!.CdtTrfTxInf[0] as Record<string, any>;
    expect(tx.IntrBkSttlmAmt).toEqual({ Ccy: "USD", value: "125000.00" });
    expect(tx.Dbtr.Nm).toBe("Adriatic Commodities BV");
    expect(tx.CdtrAgt.FinInstnId.BICFI).toBe("ETHNGRAA");
    expect(tx.ChrgBr).toBe("SHAR");
  });

  test("amounts are fixed-2dp STRINGS", () => {
    // Rendering money through a JS number is how 0.1 + 0.2 lands on a payment.
    const p = buildSettlementPayload(
      input({ calculation: { ...input().calculation, demurrageAmount: 1234.5 } })
    );
    const tx = p.iso20022!.CdtTrfTxInf[0] as Record<string, any>;
    expect(tx.IntrBkSttlmAmt.value).toBe("1234.50");
  });

  test("MsgId and EndToEndId respect the 35-character limit", () => {
    // A real ISO 20022 constraint; an over-length id is rejected by the scheme.
    const p = buildSettlementPayload(
      input({ claim: { ...input().claim, reference: "X".repeat(80) } })
    );
    expect(p.iso20022!.GrpHdr.MsgId.length).toBeLessThanOrEqual(35);
    const tx = p.iso20022!.CdtTrfTxInf[0] as Record<string, any>;
    expect(tx.PmtId.EndToEndId.length).toBeLessThanOrEqual(35);
  });
});

describe("minor units", () => {
  test("two-decimal currencies scale by 100", () => {
    expect(toMinorUnits(125_000, "USD")).toBe("12500000");
    expect(toMinorUnits(1234.56, "EUR")).toBe("123456");
  });

  test("zero-decimal currencies are NOT scaled", () => {
    // Multiplying JPY by 100 would inflate the payment a hundredfold.
    expect(toMinorUnits(125_000, "JPY")).toBe("125000");
    expect(toMinorUnits(50_000, "KRW")).toBe("50000");
  });

  test("rounds half-up at the minor unit, with no float drift", () => {
    expect(toMinorUnits(0.1 + 0.2, "USD")).toBe("30");
    expect(toMinorUnits(1234.567, "USD")).toBe("123457");
  });
});

describe("determinism", () => {
  test("the same inputs produce byte-identical payloads", async () => {
    const a = buildSettlementPayload(input());
    const b = buildSettlementPayload(input());
    expect(a).toEqual(b);
    expect(await digestOf(a)).toBe(await digestOf(b));
  });

  test("the settlement ref is stable and derived, not random", () => {
    expect(deriveSettlementRef(input())).toBe(deriveSettlementRef(input()));
    expect(deriveSettlementRef(input())).toBe("444444444444-99999999");
  });

  test("a recompute yields a different ref — a different settlement", () => {
    const other = input({
      calculation: { ...input().calculation, calculationId: "11111111-2222-3333-4444-555555555555" },
    });
    expect(deriveSettlementRef(other)).not.toBe(deriveSettlementRef(input()));
  });

  test("any material change moves the digest", async () => {
    const base = await digestOf(buildSettlementPayload(input()));
    const changed = await digestOf(
      buildSettlementPayload(
        input({ calculation: { ...input().calculation, demurrageAmount: 125_000.01 } })
      )
    );
    expect(changed).not.toBe(base);
  });

  test("the digest is a 64-character SHA-256 hex string", async () => {
    expect(await digestOf(buildSettlementPayload(input()))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("address validation", () => {
  test("accepts a well-formed address and rejects the rest", () => {
    expect(isAddress("0x" + "a".repeat(40))).toBe(true);
    expect(isAddress("0x" + "A".repeat(40))).toBe(true);
    expect(isAddress("0x" + "a".repeat(39))).toBe(false);
    expect(isAddress("0x" + "g".repeat(40))).toBe(false);
    expect(isAddress("a".repeat(40))).toBe(false);
    expect(isAddress(null)).toBe(false);
    expect(isAddress(undefined)).toBe(false);
  });
});
