// Invitations: the pure half.
//
// Token shape, expiry policy and the redemption decision live here with no
// Supabase and no Next, so every refusal path can be tested exhaustively
// against a plain object. The DB work is in `invitations-server.ts`.
//
// WHY THE DECISION IS A PURE FUNCTION RATHER THAN A CHAIN OF `if`s IN THE
// ROUTE. Redemption is the one place in this product where a stranger hands us
// a credential and asks to be let into a tenant. There are six distinct ways
// that must fail and exactly one way it may succeed, and a route that resolves
// them inline tends to grow a seventh path that nobody enumerated. Returning a
// discriminated result means the test file IS the specification, and adding a
// state without deciding what it means does not compile.

import { randomBytes, timingSafeEqual } from "crypto";
import { sha256Hex } from "@/lib/legal/prosecution";
import { ROLES, type Role } from "./roles";

/**
 * How long an invitation stays redeemable.
 *
 * Seven days is long enough to survive a weekend and a holiday, short enough
 * that a link forwarded into a group chat a month ago is dead. There is no
 * "never expires" option: an invitation with no expiry is a standing key to a
 * tenant that nobody is tracking, and the whole point of the table is that
 * somebody can see what is outstanding.
 */
export const INVITATION_TTL_DAYS = 7;

/**
 * Distinguishes an invitation token from the other opaque strings in this app
 * at a glance — a finance grant token (`lgf_`), an API key and an invitation
 * are all base64url blobs otherwise, and a support ticket pasting the wrong one
 * should fail obviously rather than mysteriously.
 */
export const INVITATION_TOKEN_PREFIX = "lgi_";

/** 32 bytes. Same budget as the finance grant tokens; ~256 bits of entropy. */
const TOKEN_BYTES = 32;

export function mintInvitationToken(): string {
  return INVITATION_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return sha256Hex(token);
}

/**
 * Cheap shape check, run before the database is touched.
 *
 * A malformed token is refused without a query, so scanning for valid tokens
 * costs the attacker a round trip only for candidates that are at least the
 * right shape. This is a filter, not a security control — the security is the
 * 256-bit random and the hash lookup.
 */
export function looksLikeInvitationToken(token: string): boolean {
  if (!token.startsWith(INVITATION_TOKEN_PREFIX)) return false;
  const body = token.slice(INVITATION_TOKEN_PREFIX.length);
  // 32 bytes base64url-encodes to 43 characters with no padding.
  return /^[A-Za-z0-9_-]{43}$/.test(body);
}

/** The stored row, narrowed to what the decision actually reads. */
export interface InvitationRecord {
  id: string;
  companyId: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export type InvitationState = "valid" | "accepted" | "revoked" | "expired";

/**
 * Which of the four states a stored invitation is in.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. Accepted is checked first, then revoked,
 * then expired, because that is the order in which the states are *sticky*: an
 * invitation that was accepted on Monday is "accepted" forever, even after its
 * original expiry passes, and reporting it as "expired" would tell a returning
 * user their invitation had timed out when in fact they are already a member —
 * sending them to ask for a new one instead of to sign in.
 */
export function invitationState(
  invitation: Pick<InvitationRecord, "acceptedAt" | "revokedAt" | "expiresAt">,
  now: Date = new Date()
): InvitationState {
  if (invitation.acceptedAt) return "accepted";
  if (invitation.revokedAt) return "revoked";
  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) return "expired";
  return "valid";
}

export function invitationExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Email comparison for the binding check.
 *
 * Case-insensitive and trimmed on both sides, because addresses arrive typed by
 * an admin and echoed back by an identity provider, and neither is reliably
 * normalised. `timingSafeEqual` on the normalised forms: the comparison is
 * against an attacker-supplied session email, and while a timing oracle on an
 * address the attacker already knows is a stretch, the call is free.
 */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a.trim().toLowerCase(), "utf8");
  const right = Buffer.from(b.trim().toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Why a redemption was refused. Each is a distinct thing to tell the user, and
 * each maps to different advice — which is the reason they are not one error.
 */
export type RedemptionRefusal =
  /** No row for that hash. Also what a guessed or truncated token looks like. */
  | "INVITATION_NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_REVOKED"
  /** Already redeemed — by this user (so: just sign in) or by someone else. */
  | "INVITATION_ALREADY_ACCEPTED"
  /** Signed in as somebody other than the invitee. */
  | "INVITATION_EMAIL_MISMATCH"
  /** The invitee already belongs to a company; this app allows exactly one. */
  | "USER_ALREADY_IN_ANOTHER_COMPANY"
  /** Already in THIS company. Not an error worth alarming anyone about. */
  | "ALREADY_MEMBER"
  /** Claiming an invitation by id on an address the provider has not confirmed. */
  | "EMAIL_NOT_VERIFIED";

export type RedemptionDecision =
  | { ok: true; companyId: string; role: Role }
  | { ok: false; reason: RedemptionRefusal };

export interface RedemptionSubject {
  email: string;
  /** The company this user already belongs to, or null. */
  currentCompanyId: string | null;
  /**
   * Whether the identity provider has confirmed this user controls this
   * address. Read from Supabase's `email_confirmed_at`.
   */
  emailVerified: boolean;
}

/**
 * WHAT THE CALLER IS PRESENTING AS EVIDENCE THAT THIS INVITATION IS THEIRS.
 *
 * There are two ways to reach an invitation, and they are NOT equally strong:
 *
 * - **`"token"`** — they hold the 256-bit secret from the invitation email.
 *   Possession is itself proof the message reached them, so the email address
 *   need not be independently verified.
 *
 * - **`"verified-email"`** — they hold no token, and are claiming an invitation
 *   found by searching for their own address. This is the onboarding page, and
 *   it exists because an address that ALREADY has an account cannot be sent a
 *   Supabase invitation email at all (`inviteUserByEmail` refuses a registered
 *   address), so for those users there is no token in existence to click.
 *
 * The second path is strictly weaker and must not be treated as equivalent.
 * Without a token, the only thing tying the claimant to the invitation is the
 * address on their session — and if the deployment does not require email
 * confirmation, anybody can sign up as `cfo@target.com` and be handed whatever
 * was waiting for them. So this path additionally requires the provider to have
 * CONFIRMED the address. That is the difference between "they typed this
 * address" and "they can read mail sent to it", and it is the entire security
 * of the tokenless route.
 */
export type RedemptionProof = "token" | "verified-email";

/**
 * The whole redemption policy, as one total function.
 *
 * Every branch below is a refusal somebody could hit for an honest reason, and
 * the ordering is chosen so the message names the most useful cause:
 *
 *  1. **State before identity.** An expired invitation is expired regardless of
 *     who is holding it, and "this invitation has expired" is more actionable
 *     than "you are signed in as the wrong person" when both are true.
 *  2. **Identity before membership.** If the wrong person is signed in, their
 *     own membership is irrelevant and mentioning it leaks the shape of another
 *     tenant's roster.
 *  3. **ALREADY_MEMBER before USER_ALREADY_IN_ANOTHER_COMPANY**, because "you
 *     are already in this team" is a shrug and "you belong to another company"
 *     is a support ticket, and getting those the wrong way round sends someone
 *     to support over a link they simply clicked twice.
 *
 * The single-company rule is re-checked HERE rather than trusted from invite
 * time: an invitation lives for a week, and a person can perfectly well accept
 * a different company's offer on day three. Deciding admissibility when the
 * offer was made would let them end up with two `company_members` rows, which
 * breaks their own `requireAuth()` on every future request — the lockout the
 * guard in the members route exists to prevent.
 */
export function decideRedemption(
  invitation: InvitationRecord,
  subject: RedemptionSubject,
  proof: RedemptionProof = "token",
  now: Date = new Date()
): RedemptionDecision {
  const state = invitationState(invitation, now);
  if (state === "accepted") return { ok: false, reason: "INVITATION_ALREADY_ACCEPTED" };
  if (state === "revoked") return { ok: false, reason: "INVITATION_REVOKED" };
  if (state === "expired") return { ok: false, reason: "INVITATION_EXPIRED" };

  if (!sameEmail(invitation.email, subject.email)) {
    return { ok: false, reason: "INVITATION_EMAIL_MISMATCH" };
  }

  // The tokenless path pays for its convenience here. Checked AFTER the address
  // matches, so the message is about the reader's own unconfirmed address
  // rather than about an invitation that was never theirs.
  if (proof === "verified-email" && !subject.emailVerified) {
    return { ok: false, reason: "EMAIL_NOT_VERIFIED" };
  }

  if (subject.currentCompanyId === invitation.companyId) {
    return { ok: false, reason: "ALREADY_MEMBER" };
  }
  if (subject.currentCompanyId !== null) {
    return { ok: false, reason: "USER_ALREADY_IN_ANOTHER_COMPANY" };
  }

  return { ok: true, companyId: invitation.companyId, role: invitation.role };
}

/** Narrows a stored role string, failing closed the way `roleOf` does. */
export function invitationRole(raw: string | null | undefined): Role {
  return (ROLES as readonly string[]).includes(raw ?? "") ? (raw as Role) : "viewer";
}

/**
 * The link that goes in the email.
 *
 * Callers should prefer `NEXT_PUBLIC_APP_URL` over the request origin, for the
 * same reason `/api/v1/openapi.json` does: the request origin is derived from
 * the `Host` header, which is wrong behind a proxy that terminates on another
 * hostname — and this URL is emailed, so getting it wrong produces a dead link
 * in somebody's inbox rather than a visible error.
 *
 * Note this is a CORRECTNESS argument, not a security one. Only an admin of the
 * tenant can trigger an invitation, and the token is handed straight back to
 * them in the response, so a spoofed Host would leak them a credential they
 * already hold. Falling back to the request origin when the variable is unset
 * is therefore fine, and is what makes the flow work in local development.
 */
export function invitationAcceptUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/invite/accept?token=${encodeURIComponent(token)}`;
}
