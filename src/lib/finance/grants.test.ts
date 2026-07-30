import { describe, expect, test } from "bun:test";
import {
  evaluateGrant,
  generateFinanceToken,
  hashFinanceToken,
  looksLikeFinanceToken,
  resolveExpiry,
  isGrantPurpose,
  FINANCE_TOKEN_PREFIX,
  DEFAULT_GRANT_EXPIRY_DAYS,
  MAX_GRANT_EXPIRY_DAYS,
  type GrantRecord,
} from "./grants";
import { API_KEY_PREFIX, looksLikeApiKey } from "@/lib/api/keys";

const NOW = new Date("2026-03-01T00:00:00Z");

function grant(over: Partial<GrantRecord> = {}): GrantRecord {
  return {
    claimId: "claim-1",
    expiresAt: "2026-03-15T00:00:00Z",
    revokedAt: null,
    accessCount: 0,
    maxAccessCount: null,
    ...over,
  };
}

describe("token shape", () => {
  test("generated tokens carry the finance prefix and pass their own check", () => {
    const t = generateFinanceToken();
    expect(t.startsWith(FINANCE_TOKEN_PREFIX)).toBe(true);
    expect(looksLikeFinanceToken(t)).toBe(true);
  });

  test("tokens are unique across many generations", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateFinanceToken()));
    expect(seen.size).toBe(500);
  });

  test("hashing is stable and never returns the token", () => {
    const t = generateFinanceToken();
    const h = hashFinanceToken(t);
    expect(h).toBe(hashFinanceToken(t));
    expect(h).not.toContain(t.slice(FINANCE_TOKEN_PREFIX.length));
    expect(h).toHaveLength(64);
  });

  // The two credential systems must not be interchangeable. An API key opens
  // the whole tenant; a grant opens one claim. Either being accepted where the
  // other is expected would collapse that distinction.
  test("an API key is NOT a valid finance token", () => {
    expect(looksLikeFinanceToken(API_KEY_PREFIX + "a".repeat(32))).toBe(false);
  });

  test("a finance token is NOT a valid API key", () => {
    expect(looksLikeApiKey(generateFinanceToken())).toBe(false);
  });

  const junk = ["", "lgf_", "lgf_short", "not-a-token", "lgf_" + "a".repeat(200), "lgf_has spaces!!"];
  for (const t of junk) {
    test(`rejects malformed token ${JSON.stringify(t.slice(0, 20))}`, () => {
      expect(looksLikeFinanceToken(t)).toBe(false);
    });
  }
});

describe("evaluateGrant — admission", () => {
  test("a live grant inside its window is admitted", () => {
    expect(evaluateGrant(grant(), NOW)).toEqual({ admitted: true });
  });

  test("a revoked grant is refused", () => {
    const d = evaluateGrant(grant({ revokedAt: "2026-02-20T00:00:00Z" }), NOW);
    expect(d).toEqual({ admitted: false, reason: "revoked" });
  });

  test("an expired grant is refused", () => {
    const d = evaluateGrant(grant({ expiresAt: "2026-02-01T00:00:00Z" }), NOW);
    expect(d).toEqual({ admitted: false, reason: "expired" });
  });

  test("expiry is exclusive — the exact instant is already expired", () => {
    const d = evaluateGrant(grant({ expiresAt: NOW.toISOString() }), NOW);
    expect(d).toEqual({ admitted: false, reason: "expired" });
  });

  test("revocation outranks expiry, so a tenant pulling access always reads as revoked", () => {
    const d = evaluateGrant(
      grant({ revokedAt: "2026-02-20T00:00:00Z", expiresAt: "2026-02-01T00:00:00Z" }),
      NOW
    );
    expect(d).toEqual({ admitted: false, reason: "revoked" });
  });

  test("a use-limited grant is refused once exhausted", () => {
    expect(evaluateGrant(grant({ maxAccessCount: 3, accessCount: 2 }), NOW).admitted).toBe(true);
    expect(evaluateGrant(grant({ maxAccessCount: 3, accessCount: 3 }), NOW)).toEqual({
      admitted: false,
      reason: "exhausted",
    });
  });

  test("a null use limit never exhausts", () => {
    expect(evaluateGrant(grant({ maxAccessCount: null, accessCount: 9_999 }), NOW).admitted).toBe(
      true
    );
  });
});

describe("evaluateGrant — traversal defence", () => {
  // THE property this whole module exists to guarantee: a bank holding a valid
  // token for claim A must never read claim B.
  test("a matching asserted claim id is admitted", () => {
    expect(evaluateGrant(grant({ claimId: "claim-1" }), NOW, "claim-1").admitted).toBe(true);
  });

  test("a DIFFERENT asserted claim id is refused, however valid the token", () => {
    const d = evaluateGrant(grant({ claimId: "claim-1" }), NOW, "claim-2");
    expect(d).toEqual({ admitted: false, reason: "claim_mismatch" });
  });

  test("omitting the asserted id is allowed — the claim then comes only from the grant", () => {
    expect(evaluateGrant(grant({ claimId: "claim-1" }), NOW, undefined).admitted).toBe(true);
  });

  test("an empty asserted id is a mismatch, not a wildcard", () => {
    expect(evaluateGrant(grant({ claimId: "claim-1" }), NOW, "").admitted).toBe(false);
  });

  test("a revoked grant is refused even when the claim id matches", () => {
    const d = evaluateGrant(grant({ revokedAt: "2026-02-01T00:00:00Z" }), NOW, "claim-1");
    expect(d).toEqual({ admitted: false, reason: "revoked" });
  });

  test("refusal ordering is stable: revoked, expired, exhausted, then mismatch", () => {
    // A grant failing several ways reports the most fundamental reason, so an
    // operator reading the ledger sees "revoked", not "wrong claim".
    const d = evaluateGrant(
      grant({
        revokedAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-02-02T00:00:00Z",
        maxAccessCount: 1,
        accessCount: 5,
      }),
      NOW,
      "other-claim"
    );
    expect(d).toEqual({ admitted: false, reason: "revoked" });
  });
});

describe("resolveExpiry", () => {
  test("defaults to the standard window", () => {
    const e = resolveExpiry(NOW);
    expect(e.getTime() - NOW.getTime()).toBe(DEFAULT_GRANT_EXPIRY_DAYS * 86_400_000);
  });

  test("honours a requested window", () => {
    expect(resolveExpiry(NOW, 7).getTime() - NOW.getTime()).toBe(7 * 86_400_000);
  });

  test("clamps to the ceiling — a grant must not outlive the decision it serves", () => {
    expect(resolveExpiry(NOW, 3650).getTime() - NOW.getTime()).toBe(
      MAX_GRANT_EXPIRY_DAYS * 86_400_000
    );
  });

  test("clamps a zero or negative request up to one day", () => {
    for (const d of [0, -5]) {
      expect(resolveExpiry(NOW, d).getTime() - NOW.getTime()).toBe(86_400_000);
    }
  });
});

describe("purposes", () => {
  test("recognises the supported purposes", () => {
    for (const p of ["factoring", "audit", "due_diligence"]) expect(isGrantPurpose(p)).toBe(true);
  });

  test("rejects anything else", () => {
    for (const p of ["admin", "", "FACTORING", "write"]) expect(isGrantPurpose(p)).toBe(false);
  });
});
