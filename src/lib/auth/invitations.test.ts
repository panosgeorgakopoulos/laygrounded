// The redemption policy, exhaustively.
//
// `decideRedemption` is the gate a stranger walks through to get inside a
// tenant, so every refusal it can return is asserted here — including the
// ORDERING between refusals, which is the part that has no compile-time
// protection and which changes what a real person is told to do next.

import { describe, expect, test } from "bun:test";
import {
  INVITATION_TOKEN_PREFIX,
  INVITATION_TTL_DAYS,
  decideRedemption,
  hashInvitationToken,
  invitationAcceptUrl,
  invitationExpiry,
  invitationRole,
  invitationState,
  looksLikeInvitationToken,
  mintInvitationToken,
  sameEmail,
  type InvitationRecord,
} from "./invitations";

const NOW = new Date("2026-08-08T12:00:00Z");
const IN_A_WEEK = new Date("2026-08-15T12:00:00Z").toISOString();
const LAST_WEEK = new Date("2026-08-01T12:00:00Z").toISOString();

function invitation(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    email: "ops@fleet.com",
    role: "operator",
    expiresAt: IN_A_WEEK,
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("token shape", () => {
  test("mints a prefixed, 43-character base64url token", () => {
    const token = mintInvitationToken();
    expect(token.startsWith(INVITATION_TOKEN_PREFIX)).toBe(true);
    expect(looksLikeInvitationToken(token)).toBe(true);
  });

  test("two mints never collide", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintInvitationToken()));
    expect(seen.size).toBe(500);
  });

  test("rejects tokens of the wrong shape without touching a database", () => {
    expect(looksLikeInvitationToken("")).toBe(false);
    expect(looksLikeInvitationToken("lgi_")).toBe(false);
    // A finance grant token must not be accepted here: the prefixes exist so
    // that pasting the wrong credential fails obviously.
    expect(looksLikeInvitationToken("lgf_" + "a".repeat(43))).toBe(false);
    // Right length, wrong alphabet (base64 padding / non-url characters).
    expect(looksLikeInvitationToken(INVITATION_TOKEN_PREFIX + "+".repeat(43))).toBe(false);
    expect(looksLikeInvitationToken(INVITATION_TOKEN_PREFIX + "a".repeat(42))).toBe(false);
    expect(looksLikeInvitationToken(INVITATION_TOKEN_PREFIX + "a".repeat(44))).toBe(false);
  });

  test("hashing is deterministic, and the hash is not the token", () => {
    const token = mintInvitationToken();
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
    expect(hashInvitationToken(token)).not.toContain(token);
    expect(hashInvitationToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("expiry", () => {
  test("is TTL days out", () => {
    const expiry = invitationExpiry(NOW);
    expect(expiry.getTime() - NOW.getTime()).toBe(INVITATION_TTL_DAYS * 86_400_000);
  });

  test("an invitation expires at its boundary, not after it", () => {
    const at = invitation({ expiresAt: NOW.toISOString() });
    expect(invitationState(at, NOW)).toBe("expired");
    expect(invitationState(at, new Date(NOW.getTime() - 1))).toBe("valid");
  });
});

describe("invitationState precedence", () => {
  test("valid when nothing has happened to it", () => {
    expect(invitationState(invitation(), NOW)).toBe("valid");
  });

  // THE ORDERING TEST. An invitation accepted on Monday is still "accepted" a
  // month later, when its original expiry has long passed. Reporting that as
  // "expired" would tell a member their invitation had timed out and send them
  // to ask for a new one, when what they actually need is to sign in.
  test("accepted outranks expired", () => {
    expect(
      invitationState(invitation({ acceptedAt: LAST_WEEK, expiresAt: LAST_WEEK }), NOW)
    ).toBe("accepted");
  });

  test("accepted outranks revoked", () => {
    expect(invitationState(invitation({ acceptedAt: LAST_WEEK, revokedAt: LAST_WEEK }), NOW)).toBe(
      "accepted"
    );
  });

  test("revoked outranks expired", () => {
    expect(invitationState(invitation({ revokedAt: LAST_WEEK, expiresAt: LAST_WEEK }), NOW)).toBe(
      "revoked"
    );
  });
});

describe("sameEmail", () => {
  test("folds case and surrounding whitespace", () => {
    expect(sameEmail("Ops@Fleet.com", "ops@fleet.com ")).toBe(true);
    expect(sameEmail("  ops@fleet.com", "OPS@FLEET.COM")).toBe(true);
  });

  test("is not fooled by a prefix or a near miss", () => {
    expect(sameEmail("ops@fleet.com", "ops@fleet.co")).toBe(false);
    expect(sameEmail("ops@fleet.com", "ops@fleet.com.evil.com")).toBe(false);
    expect(sameEmail("ops@fleet.com", "0ps@fleet.com")).toBe(false);
  });

  test("a missing address never matches — including against another missing one", () => {
    expect(sameEmail(null, null)).toBe(false);
    expect(sameEmail(undefined, "ops@fleet.com")).toBe(false);
    expect(sameEmail("ops@fleet.com", "")).toBe(false);
  });
});

describe("decideRedemption", () => {
  const invitee = { email: "ops@fleet.com", currentCompanyId: null, emailVerified: true };

  test("admits the invitee with the pre-assigned role", () => {
    const decision = decideRedemption(invitation({ role: "finance_manager" }), invitee, "token", NOW);
    expect(decision).toEqual({
      ok: true,
      companyId: "22222222-2222-4222-8222-222222222222",
      role: "finance_manager",
    });
  });

  test("admits regardless of the case the invitee's provider reports", () => {
    const decision = decideRedemption(
      invitation({ email: "Ops@Fleet.com" }),
      { email: "ops@fleet.com", currentCompanyId: null, emailVerified: true },
      "token",
      NOW
    );
    expect(decision.ok).toBe(true);
  });

  test("refuses an expired invitation", () => {
    const decision = decideRedemption(invitation({ expiresAt: LAST_WEEK }), invitee, "token", NOW);
    expect(decision).toEqual({ ok: false, reason: "INVITATION_EXPIRED" });
  });

  test("refuses a revoked invitation", () => {
    const decision = decideRedemption(invitation({ revokedAt: LAST_WEEK }), invitee, "token", NOW);
    expect(decision).toEqual({ ok: false, reason: "INVITATION_REVOKED" });
  });

  test("refuses a second redemption of the same token", () => {
    const decision = decideRedemption(invitation({ acceptedAt: LAST_WEEK }), invitee, "token", NOW);
    expect(decision).toEqual({ ok: false, reason: "INVITATION_ALREADY_ACCEPTED" });
  });

  // THE SECURITY-CRITICAL CASE. The invitation is an offer to a person, not a
  // bearer ticket: a link forwarded into a group chat, or lifted from a mailbox,
  // must not admit whoever clicks it. A tenant here holds bank details and
  // settlement instructions.
  test("refuses somebody else holding the link", () => {
    const decision = decideRedemption(
      invitation(),
      { email: "stranger@elsewhere.com", currentCompanyId: null, emailVerified: true },
      "token",
      NOW
    );
    expect(decision).toEqual({ ok: false, reason: "INVITATION_EMAIL_MISMATCH" });
  });

  test("refuses an invitee who has since joined another company", () => {
    const decision = decideRedemption(
      invitation(),
      { email: "ops@fleet.com", currentCompanyId: "99999999-9999-4999-8999-999999999999", emailVerified: true },
      "token",
      NOW
    );
    expect(decision).toEqual({ ok: false, reason: "USER_ALREADY_IN_ANOTHER_COMPANY" });
  });

  test("reports a double-click as ALREADY_MEMBER, not as a foreign company", () => {
    const inv = invitation();
    const decision = decideRedemption(
      inv,
      { email: "ops@fleet.com", currentCompanyId: inv.companyId, emailVerified: true },
      "token",
      NOW
    );
    expect(decision).toEqual({ ok: false, reason: "ALREADY_MEMBER" });
  });

  // ── Precedence between refusals ──────────────────────────────────────────
  //
  // These pin the ORDER, which is invisible to the type system and changes the
  // advice a real person is given.

  test("state is decided before identity", () => {
    // Both wrong: expired AND the wrong person. "Expired" is the honest answer
    // and does not confirm to a stranger that they hold a real address's token.
    const decision = decideRedemption(
      invitation({ expiresAt: LAST_WEEK }),
      { email: "stranger@elsewhere.com", currentCompanyId: null, emailVerified: true },
      "token",
      NOW
    );
    expect(decision).toEqual({ ok: false, reason: "INVITATION_EXPIRED" });
  });

  // ── The tokenless path ───────────────────────────────────────────────────
  //
  // The onboarding page lists invitations addressed to the signed-in user and
  // lets them accept without a token, because an address that already has an
  // account can never be sent one (`inviteUserByEmail` refuses a registered
  // address). That convenience is paid for with a confirmed email requirement:
  // without it, registering as somebody else's address on a deployment that
  // does not enforce confirmation would hand over whatever was waiting for them.

  test("admits a tokenless claim when the address is confirmed", () => {
    const decision = decideRedemption(
      invitation(),
      { email: "ops@fleet.com", currentCompanyId: null, emailVerified: true },
      "verified-email",
      NOW
    );
    expect(decision.ok).toBe(true);
  });

  test("refuses a tokenless claim on an unconfirmed address", () => {
    const decision = decideRedemption(
      invitation(),
      { email: "ops@fleet.com", currentCompanyId: null, emailVerified: false },
      "verified-email",
      NOW
    );
    expect(decision).toEqual({ ok: false, reason: "EMAIL_NOT_VERIFIED" });
  });

  // Holding the emailed token IS proof the message arrived, so the token path
  // does not additionally require confirmation. If it did, an invited user on a
  // deployment without mandatory confirmation could not accept the invitation
  // they had demonstrably just received.
  test("an unconfirmed address is admitted when a token is presented", () => {
    const decision = decideRedemption(
      invitation(),
      { email: "ops@fleet.com", currentCompanyId: null, emailVerified: false },
      "token",
      NOW
    );
    expect(decision.ok).toBe(true);
  });

  test("a tokenless claim on somebody else's invitation fails on identity, not on verification", () => {
    // Ordering again: the stranger is refused for being the wrong person, which
    // does not tell them whether the address they guessed has an invitation.
    const decision = decideRedemption(
      invitation(),
      { email: "stranger@elsewhere.com", currentCompanyId: null, emailVerified: false },
      "verified-email",
      NOW
    );
    expect(decision).toEqual({ ok: false, reason: "INVITATION_EMAIL_MISMATCH" });
  });

  test("identity is decided before membership", () => {
    // A stranger who already belongs somewhere must be told the link is not
    // theirs — never that their own company is the obstacle, which would leak
    // that the signed-in account has a tenant at all.
    const decision = decideRedemption(
      invitation(),
      { email: "stranger@elsewhere.com", currentCompanyId: "99999999-9999-4999-8999-999999999999", emailVerified: true },
      "token",
      NOW
    );
    expect(decision).toEqual({ ok: false, reason: "INVITATION_EMAIL_MISMATCH" });
  });
});

describe("invitationRole", () => {
  test("passes through every real role", () => {
    for (const role of ["viewer", "operator", "finance_manager", "admin"] as const) {
      expect(invitationRole(role)).toBe(role);
    }
  });

  test("fails closed to viewer, matching roleOf", () => {
    expect(invitationRole(null)).toBe("viewer");
    expect(invitationRole(undefined)).toBe("viewer");
    expect(invitationRole("superadmin")).toBe("viewer");
    // `member` is the legacy company_members value. It was never a valid
    // invitation role — invitations postdate the rename — so unlike `roleOf`
    // there is nothing to map and it fails closed like anything else.
    expect(invitationRole("member")).toBe("viewer");
  });
});

describe("invitationAcceptUrl", () => {
  test("builds a link against the configured origin", () => {
    expect(invitationAcceptUrl("https://app.laygrounded.com", "lgi_abc")).toBe(
      "https://app.laygrounded.com/invite/accept?token=lgi_abc"
    );
  });

  test("tolerates a trailing slash on the origin", () => {
    expect(invitationAcceptUrl("https://app.laygrounded.com/", "lgi_abc")).toBe(
      "https://app.laygrounded.com/invite/accept?token=lgi_abc"
    );
  });

  test("encodes the token so a stray character cannot split the query", () => {
    expect(invitationAcceptUrl("https://x.test", "a&b=c")).toBe(
      "https://x.test/invite/accept?token=a%26b%3Dc"
    );
  });
});
