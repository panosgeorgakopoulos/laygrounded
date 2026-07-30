// Trade-finance grants — zero-trust, claim-scoped access for banks and auditors.
//
// A bank financing one demurrage claim needs to satisfy itself that the claim
// is real and correctly computed. The obvious answer — give them an API key —
// is the wrong one twice over: it exposes the tenant's whole book to a third
// party with no account and no notice, and it asks the bank to trust OUR
// arithmetic, which is exactly what a credit committee will not do.
//
// So a grant is:
//
//   * scoped to ONE claim, chosen by the tenant at issue time;
//   * a bearer token stored only as a SHA-256 hash, revocable at any moment;
//   * time-boxed, and optionally use-boxed (a factoring decision is usually
//     made once);
//   * redeemable for a bundle the bank verifies OFFLINE with the WASM engine,
//     rather than for our assertion that the numbers are right.
//
// The pure half lives here — token shape and the admissibility policy — so the
// rules that decide whether a bank may read a claim are testable without a
// database.

import { randomBytes } from "crypto";
import { sha256Hex } from "@/lib/legal/prosecution";

/**
 * Distinct prefix from API keys (`lga_`).
 *
 * Not cosmetic: an operator pasting a credential into the wrong field should
 * fail immediately and obviously, and a grant token must never be mistaken for
 * — or usable as — a tenant-wide key. The shape check below is what stops a
 * grant reaching the API-key authenticator at all.
 */
export const FINANCE_TOKEN_PREFIX = "lgf_";
const TOKEN_BYTES = 32; // 256 bits

export const DEFAULT_GRANT_EXPIRY_DAYS = 14;
export const MAX_GRANT_EXPIRY_DAYS = 90;

/** What the grant is for. Recorded so an audit can say why access was given. */
export const GRANT_PURPOSES = ["factoring", "audit", "due_diligence"] as const;
export type GrantPurpose = (typeof GRANT_PURPOSES)[number];

export function isGrantPurpose(s: string): s is GrantPurpose {
  return (GRANT_PURPOSES as readonly string[]).includes(s);
}

export function generateFinanceToken(): string {
  return FINANCE_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashFinanceToken(token: string): string {
  return sha256Hex(token);
}

/**
 * Cheap shape check before any database lookup.
 *
 * Also the boundary that keeps the two credential systems apart: an `lga_` API
 * key fails this, and an `lgf_` grant fails the API key's own check, so neither
 * can be presented where the other is expected.
 */
export function looksLikeFinanceToken(token: string): boolean {
  if (!token.startsWith(FINANCE_TOKEN_PREFIX)) return false;
  const body = token.slice(FINANCE_TOKEN_PREFIX.length);
  return body.length >= 32 && body.length <= 128 && /^[A-Za-z0-9_-]+$/.test(body);
}

// === Admissibility ===

/** The stored grant, as far as the policy is concerned. */
export interface GrantRecord {
  claimId: string;
  expiresAt: string;
  revokedAt: string | null;
  accessCount: number;
  /** Null means unlimited reads until expiry. */
  maxAccessCount: number | null;
}

export type GrantRefusal =
  | "revoked"
  | "expired"
  | "exhausted"
  | "claim_mismatch";

export type GrantDecision =
  | { admitted: true }
  | { admitted: false; reason: GrantRefusal };

/**
 * Whether a resolved grant may be redeemed right now.
 *
 * `assertedClaimId` is the claim id the CALLER put in the URL. It is checked
 * for equality against the grant's own claim, never used to select anything.
 * That distinction is the whole traversal defence: the claim always comes from
 * the token, and a mismatched path id is a refusal rather than a lookup.
 *
 * Pure, and `now` is injected — a policy that reads the clock cannot be tested
 * at its boundaries, and every boundary here is a security boundary.
 */
export function evaluateGrant(
  grant: GrantRecord,
  now: Date,
  assertedClaimId?: string
): GrantDecision {
  // Revocation outranks everything: a tenant pulling access must take effect
  // immediately, whatever the expiry or remaining uses say.
  if (grant.revokedAt) return { admitted: false, reason: "revoked" };

  if (new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return { admitted: false, reason: "expired" };
  }

  if (grant.maxAccessCount !== null && grant.accessCount >= grant.maxAccessCount) {
    return { admitted: false, reason: "exhausted" };
  }

  if (assertedClaimId !== undefined && assertedClaimId !== grant.claimId) {
    return { admitted: false, reason: "claim_mismatch" };
  }

  return { admitted: true };
}

/**
 * Clamps a requested lifetime.
 *
 * A grant that outlives the financing decision is a credential nobody
 * remembers issuing, so there is a hard ceiling as well as a default.
 */
export function resolveExpiry(now: Date, requestedDays?: number): Date {
  const days = Math.min(
    Math.max(requestedDays ?? DEFAULT_GRANT_EXPIRY_DAYS, 1),
    MAX_GRANT_EXPIRY_DAYS
  );
  return new Date(now.getTime() + days * 86_400_000);
}
