// Trade-finance grants — the database half: issue, list, revoke, and redeem.
//
// The redemption path is the security-critical one. Its shape is deliberate:
//
//   resolve by TOKEN HASH  ->  read the claim id FROM THE GRANT  ->  check the
//   caller's asserted claim id matches  ->  ledger the attempt  ->  load
//
// The claim is never selected by anything the caller supplies. A bank that
// presents a valid token together with a different claim id gets a 404 and an
// entry in the access ledger, because that is a traversal attempt and the
// tenant is entitled to see it.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateGrant,
  generateFinanceToken,
  hashFinanceToken,
  looksLikeFinanceToken,
  resolveExpiry,
  type GrantPurpose,
  type GrantRefusal,
} from "./grants";

export interface FinanceGrant {
  id: string;
  claimId: string;
  institutionLabel: string;
  purpose: GrantPurpose;
  tokenPrefix: string;
  expiresAt: string;
  maxAccessCount: number | null;
  accessCount: number;
  lastAccessedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
}

function serialize(r: Record<string, unknown>): FinanceGrant {
  return {
    id: r.id as string,
    claimId: r.claim_id as string,
    institutionLabel: r.institution_label as string,
    purpose: r.purpose as GrantPurpose,
    tokenPrefix: (r.token_prefix as string) ?? "",
    expiresAt: r.expires_at as string,
    maxAccessCount: (r.max_access_count as number | null) ?? null,
    accessCount: (r.access_count as number) ?? 0,
    lastAccessedAt: (r.last_accessed_at as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
    revokeReason: (r.revoke_reason as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export interface IssueGrantInput {
  claimId: string;
  companyId: string;
  institutionLabel: string;
  purpose: GrantPurpose;
  expiryDays?: number;
  maxAccessCount?: number | null;
  createdBy?: string | null;
}

/**
 * Issues a grant. The plaintext token is returned exactly once — only its hash
 * is stored, so it cannot be recovered afterwards, only replaced.
 */
export async function issueGrant(
  db: SupabaseClient,
  input: IssueGrantInput,
  now: Date = new Date()
): Promise<{ grant: FinanceGrant; token: string }> {
  const token = generateFinanceToken();
  const { data, error } = await db
    .from("finance_grants")
    .insert({
      claim_id: input.claimId,
      company_id: input.companyId,
      institution_label: input.institutionLabel,
      purpose: input.purpose,
      token_hash: hashFinanceToken(token),
      // Enough to identify the row in a UI, far too little to guess from.
      token_prefix: token.slice(0, 12),
      expires_at: resolveExpiry(now, input.expiryDays).toISOString(),
      max_access_count: input.maxAccessCount ?? null,
      created_by: input.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`GRANT_CREATE_FAILED: ${error?.message}`);
  return { grant: serialize(data), token };
}

export async function listGrants(
  db: SupabaseClient,
  claimId: string
): Promise<FinanceGrant[]> {
  const { data, error } = await db
    .from("finance_grants")
    .select("*")
    .eq("claim_id", claimId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`GRANT_QUERY_FAILED: ${error.message}`);
  return (data ?? []).map(serialize);
}

/**
 * Revokes a grant.
 *
 * Idempotent and scoped to the company: revoking twice is not an error (a
 * tenant pulling access twice should not see a failure), and a grant id from
 * another tenant simply is not found.
 */
export async function revokeGrant(
  db: SupabaseClient,
  grantId: string,
  companyId: string,
  opts: { revokedBy?: string | null; reason?: string } = {}
): Promise<boolean> {
  const { data, error } = await db
    .from("finance_grants")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: opts.revokedBy ?? null,
      revoke_reason: opts.reason ?? null,
    })
    .eq("id", grantId)
    .eq("company_id", companyId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`GRANT_REVOKE_FAILED: ${error.message}`);
  return (data ?? []).length > 0;
}

export interface RedeemedGrant {
  grantId: string;
  claimId: string;
  companyId: string;
  institutionLabel: string;
  purpose: GrantPurpose;
  expiresAt: string;
  accessCount: number;
}

export type RedeemResult =
  | { ok: true; grant: RedeemedGrant }
  | { ok: false; reason: GrantRefusal | "unknown_token" };

/**
 * Redeems a presented token.
 *
 * Every outcome is ledgered except an unknown token, which has no grant row to
 * hang the record on — and recording arbitrary unknown strings would turn the
 * ledger into a place to write attacker-controlled data.
 *
 * The counter is incremented ONLY on an admitted read, so `max_access_count`
 * counts successful redemptions rather than attempts. A refused attempt must
 * not consume a bank's remaining reads: that would let anyone holding a stale
 * copy of the token burn a legitimate holder's access.
 */
export async function redeemGrant(
  db: SupabaseClient,
  token: string,
  assertedClaimId: string | undefined,
  meta: { userAgent?: string | null } = {},
  now: Date = new Date()
): Promise<RedeemResult> {
  if (!looksLikeFinanceToken(token)) return { ok: false, reason: "unknown_token" };

  const { data: row } = await db
    .from("finance_grants")
    .select(
      "id, claim_id, company_id, institution_label, purpose, expires_at, revoked_at, access_count, max_access_count"
    )
    .eq("token_hash", hashFinanceToken(token))
    .maybeSingle();

  if (!row) return { ok: false, reason: "unknown_token" };

  const decision = evaluateGrant(
    {
      claimId: row.claim_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      accessCount: row.access_count ?? 0,
      maxAccessCount: row.max_access_count ?? null,
    },
    now,
    assertedClaimId
  );

  const ledger = (admitted: boolean, reason?: GrantRefusal) =>
    db.from("finance_grant_accesses").insert({
      grant_id: row.id,
      admitted,
      refusal_reason: reason ?? null,
      // Recorded only when it is evidence: a matching id is not interesting,
      // a mismatched one is a traversal attempt.
      asserted_claim_id:
        reason === "claim_mismatch" && assertedClaimId ? assertedClaimId : null,
      user_agent: meta.userAgent ?? null,
    });

  if (!decision.admitted) {
    await ledger(false, decision.reason);
    return { ok: false, reason: decision.reason };
  }

  await ledger(true);
  // Best-effort metering; a failed counter must not deny a legitimate read.
  void db
    .from("finance_grants")
    .update({
      access_count: (row.access_count ?? 0) + 1,
      last_accessed_at: now.toISOString(),
    })
    .eq("id", row.id);

  return {
    ok: true,
    grant: {
      grantId: row.id,
      claimId: row.claim_id,
      companyId: row.company_id,
      institutionLabel: row.institution_label,
      purpose: row.purpose,
      expiresAt: row.expires_at,
      accessCount: (row.access_count ?? 0) + 1,
    },
  };
}

/** Redemption history for a grant, for the issuing tenant. */
export async function listGrantAccesses(
  db: SupabaseClient,
  grantId: string
): Promise<
  Array<{
    admitted: boolean;
    refusalReason: string | null;
    assertedClaimId: string | null;
    createdAt: string;
  }>
> {
  const { data } = await db
    .from("finance_grant_accesses")
    .select("admitted, refusal_reason, asserted_claim_id, created_at")
    .eq("grant_id", grantId)
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []).map((r) => ({
    admitted: r.admitted,
    refusalReason: r.refusal_reason,
    assertedClaimId: r.asserted_claim_id,
    createdAt: r.created_at,
  }));
}
