import { describe, expect, test } from "bun:test";
import type { BreakdownRow, CalculationTotals, CpTerms } from "@/lib/laytime/types";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";
import {
  buildAuditDossier,
  buildMerkleLevels,
  canonicalJson,
  generateCryptographicSnapshot,
  merkleProof,
  prepareArrestPreFiling,
  sha256Hex,
  verifyMerkleProof,
  verifySnapshot,
  type ArrestPreFilingInput,
  type SnapshotLedger,
} from "./prosecution";

const TOTALS: CalculationTotals = {
  allowed_hours: 72,
  used_hours: 96,
  time_on_demurrage_hours: 24,
  time_saved_hours: 0,
  demurrage_amount: 25_000,
  despatch_amount: 0,
  currency: "USD",
};

const ROW: BreakdownRow = {
  start_time: "2026-06-01T00:00:00Z",
  end_time: "2026-06-01T06:00:00Z",
  duration_hours: 6,
  status: "laytime",
  counts: true,
  clause_ref: "GENCON94-6c",
  reasoning: "Laytime running.",
};

function makeLedger(over: Partial<SnapshotLedger> = {}): SnapshotLedger {
  return {
    cpTerms: DEFAULT_CP_TERMS as CpTerms,
    totals: TOTALS,
    breakdown: [ROW, { ...ROW, start_time: "2026-06-01T06:00:00Z", status: "demurrage" }],
    events: [
      { id: "e1", event_type: "NOR_TENDERED", occurred_at: "2026-05-31T08:00:00+02:00" },
      { id: "e2", event_type: "COMPLETED_DISCHARGE", occurred_at: "2026-06-02T10:00:00+02:00" },
    ],
    asOf: "2026-07-01T00:00:00Z",
    ...over,
  };
}

describe("canonicalJson", () => {
  test("key order does not change the serialization", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  test("undefined properties are dropped, null survives", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe("merkle tree", () => {
  const leaves = ["a", "b", "c", "d", "e"].map(sha256Hex);

  test("root is deterministic and sensitive to any leaf", () => {
    const root1 = buildMerkleLevels(leaves).at(-1)![0];
    const root2 = buildMerkleLevels(leaves).at(-1)![0];
    expect(root1).toBe(root2);
    const tampered = [...leaves];
    tampered[2] = sha256Hex("c-tampered");
    expect(buildMerkleLevels(tampered).at(-1)![0]).not.toBe(root1);
  });

  test("membership proofs verify for every leaf, including the odd promoted one", () => {
    const root = buildMerkleLevels(leaves).at(-1)![0];
    for (let i = 0; i < leaves.length; i++) {
      const proof = merkleProof(leaves, i);
      expect(verifyMerkleProof(leaves[i], proof, root)).toBe(true);
    }
    // A proof for the wrong leaf must fail.
    expect(verifyMerkleProof(leaves[0], merkleProof(leaves, 1), root)).toBe(false);
  });

  test("empty ledger is refused", () => {
    expect(() => buildMerkleLevels([])).toThrow("EMPTY_LEDGER");
  });
});

describe("generateCryptographicSnapshot", () => {
  test("byte-identical ledgers produce identical fingerprints", () => {
    const a = generateCryptographicSnapshot("claim-1", makeLedger());
    const b = generateCryptographicSnapshot("claim-1", makeLedger());
    expect(a.merkleRoot).toBe(b.merkleRoot);
    expect(a.leafCount).toBe(3 + 2 + 2); // header + cp_terms + totals + 2 events + 2 rows
    expect(verifySnapshot("claim-1", makeLedger(), a.merkleRoot)).toBe(true);
  });

  test("touching one breakdown hour changes the root", () => {
    const base = generateCryptographicSnapshot("claim-1", makeLedger());
    const tampered = makeLedger();
    tampered.breakdown[0] = { ...tampered.breakdown[0], duration_hours: 6.5 };
    expect(verifySnapshot("claim-1", tampered, base.merkleRoot)).toBe(false);
  });

  test("the same ledger under a different claim id is a different fingerprint", () => {
    const a = generateCryptographicSnapshot("claim-1", makeLedger());
    const b = generateCryptographicSnapshot("claim-2", makeLedger());
    expect(a.merkleRoot).not.toBe(b.merkleRoot);
  });

  test("dossier carries the fingerprint and the leaf inventory", () => {
    const snap = generateCryptographicSnapshot("claim-1", makeLedger());
    const dossier = buildAuditDossier(snap, { vessel: "MV TEST", voyageRef: "V42", port: "Santos" });
    expect(dossier).toContain(snap.merkleRoot.slice(0, 8));
    expect(dossier).toContain("| 0 | header |");
    expect(dossier).toContain("Verification procedure");
  });
});

describe("prepareArrestPreFiling", () => {
  const baseInput = (): ArrestPreFilingInput => ({
    claim: {
      id: "claim-1",
      vessel: "MV ALPHA",
      vesselImo: "9700001",
      port: "Santos",
      counterpartyName: "Acme Chartering",
      currency: "USD",
      demurrageAmount: 180_000,
      settledAt: null,
      completionAt: "2026-01-01T00:00:00Z",
      timeBarDays: 90,
      demandServedAt: "2026-02-01T00:00:00Z",
    },
    relatedClaims: [
      { vessel: "MV BETA", vesselImo: "9700002", counterpartyName: "Acme Chartering", status: "review" },
      { vessel: "MV BETA", vesselImo: "9700002", counterpartyName: "acme chartering", status: "done" },
      { vessel: "MV OTHER", vesselImo: "9700003", counterpartyName: "Someone Else", status: "done" },
    ],
    contradictedEvidenceCount: 0,
    asOf: "2026-07-01T00:00:00Z",
  });

  test("an aged unpaid quantified claim is eligible with deduplicated sister-ship leads", () => {
    const a = prepareArrestPreFiling(baseInput());
    expect(a.eligible).toBe(true);
    expect(a.blockers).toHaveLength(0);
    expect(a.unpaidDays).toBe(150);
    expect(a.candidateAssets).toHaveLength(2); // subject + MV BETA once
    expect(a.candidateAssets[1].type).toBe("sister_ship_lead");
    expect(a.badFaithIndicators.length).toBeGreaterThan(0);
    expect(a.humanReviewRequired).toBe(true);
    expect(a.draftParticulars).toContain("[COUNSEL:");
    expect(a.draftParticulars).toContain("NOT LEGAL ADVICE");
  });

  test("settled or unquantified claims are blocked", () => {
    const settled = baseInput();
    settled.claim.settledAt = "2026-06-01T00:00:00Z";
    expect(prepareArrestPreFiling(settled).eligible).toBe(false);

    const unquantified = baseInput();
    unquantified.claim.demurrageAmount = 0;
    const a = prepareArrestPreFiling(unquantified);
    expect(a.eligible).toBe(false);
    expect(a.blockers.some((b) => b.includes("quantum"))).toBe(true);
  });

  test("recently unpaid claims are below the escalation threshold", () => {
    const fresh = baseInput();
    fresh.claim.demandServedAt = "2026-06-15T00:00:00Z";
    const a = prepareArrestPreFiling(fresh);
    expect(a.eligible).toBe(false);
    expect(a.blockers.some((b) => b.includes("escalation threshold"))).toBe(true);
  });

  test("a lapsed presentation window with no demand raises a caution, and contradicted evidence is flagged", () => {
    const input = baseInput();
    input.claim.demandServedAt = null; // anchor falls back to completion: 181 unpaid days
    input.contradictedEvidenceCount = 2;
    const a = prepareArrestPreFiling(input);
    expect(a.eligible).toBe(true);
    expect(a.cautions.some((c) => c.includes("presentation window"))).toBe(true);
    expect(a.cautions.some((c) => c.includes("contradicted"))).toBe(true);
    expect(a.badFaithIndicators).toHaveLength(0); // no served demand → no ignored-demand indicator
  });
});
