// Invitations: the half that touches the database.
//
// The policy is in `invitations.ts` and is pure. This file is the I/O around
// it: minting a row, finding one by token, and the redemption transaction that
// turns an accepted offer into a `company_members` row.
//
// EVERY FUNCTION HERE TAKES A SERVICE-ROLE CLIENT, and the reason is structural
// rather than convenient. `company_invitations` has one RLS policy (SELECT for
// members) and no write policies at all, because the person accepting an
// invitation is BY DEFINITION not yet a member: there is no policy that could
// authorise their insert without also authorising a stranger's. The trust
// boundary is therefore the capability check in the route above, or — for
// redemption — the token itself.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "./roles";
import {
  decideRedemption,
  hashInvitationToken,
  invitationExpiry,
  invitationRole,
  looksLikeInvitationToken,
  mintInvitationToken,
  type InvitationRecord,
  type RedemptionProof,
  type RedemptionRefusal,
} from "./invitations";

/** An invitation as the team page sees it. Never carries the token. */
export interface InvitationSummary {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  invitedBy: string | null;
}

interface InvitationRow {
  id: string;
  company_id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at?: string;
  invited_by?: string | null;
}

function toRecord(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    email: row.email,
    role: invitationRole(row.role),
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Creates an invitation and returns the PLAINTEXT TOKEN ONCE.
 *
 * The token is never stored and never recoverable — only its SHA-256 hash goes
 * to the database, the same contract as a finance grant. A caller that discards
 * this return value has created an invitation nobody can redeem, and must
 * revoke it and issue another rather than trying to read it back.
 */
export async function createInvitation(
  db: SupabaseClient,
  params: { companyId: string; email: string; role: Role; invitedBy: string }
): Promise<{ invitation: InvitationSummary; token: string }> {
  const token = mintInvitationToken();
  const email = params.email.trim().toLowerCase();

  const { data, error } = await db
    .from("company_invitations")
    .insert({
      company_id: params.companyId,
      email,
      role: params.role,
      token_hash: hashInvitationToken(token),
      invited_by: params.invitedBy,
      expires_at: invitationExpiry().toISOString(),
    })
    .select("id, email, role, created_at, expires_at, invited_by")
    .single();

  if (error || !data) {
    // The partial unique index on (company_id, lower(email)) WHERE outstanding
    // is the intended way to learn this, rather than a read-then-write that can
    // lose a race between two admins inviting the same person.
    if (error?.code === "23505") throw new Error("INVITATION_ALREADY_OUTSTANDING");
    throw new Error(`FAILED_TO_CREATE_INVITATION: ${error?.message ?? "no row returned"}`);
  }

  return {
    token,
    invitation: {
      id: data.id,
      email: data.email,
      role: invitationRole(data.role),
      createdAt: data.created_at,
      expiresAt: data.expires_at,
      invitedBy: data.invited_by ?? null,
    },
  };
}

/**
 * Resolves a plaintext token to its stored row.
 *
 * Malformed tokens are rejected on shape before the query, so a scan for valid
 * tokens does not get a database round trip for free. Returns the record in
 * ANY state — expired, revoked, already accepted — because the caller needs to
 * tell those apart to say anything useful; `decideRedemption` makes the call.
 */
export async function findInvitationByToken(
  db: SupabaseClient,
  token: string
): Promise<InvitationRecord | null> {
  if (!looksLikeInvitationToken(token)) return null;

  const { data, error } = await db
    .from("company_invitations")
    .select("id, company_id, email, role, expires_at, accepted_at, revoked_at")
    .eq("token_hash", hashInvitationToken(token))
    .maybeSingle();

  if (error || !data) return null;
  return toRecord(data as InvitationRow);
}

/**
 * Resolves an invitation by its primary key.
 *
 * ONLY EVER REACHED WITH `RedemptionProof = "verified-email"`. An id is not a
 * secret — it is a uuid the team page shows to every member — so finding a row
 * this way authorises nothing on its own. The authorisation is entirely in
 * `decideRedemption`, which requires the caller's CONFIRMED address to match
 * the invitation's. Never call this on a path that treats the lookup itself as
 * proof of anything.
 */
export async function findInvitationById(
  db: SupabaseClient,
  invitationId: string
): Promise<InvitationRecord | null> {
  const { data, error } = await db
    .from("company_invitations")
    .select("id, company_id, email, role, expires_at, accepted_at, revoked_at")
    .eq("id", invitationId)
    .maybeSingle();

  if (error || !data) return null;
  return toRecord(data as InvitationRow);
}

/** The company an invitation is for, for the "join Acme Shipping" headline. */
export async function invitationCompanyName(
  db: SupabaseClient,
  companyId: string
): Promise<string | null> {
  const { data } = await db.from("companies").select("name").eq("id", companyId).maybeSingle();
  return data?.name ?? null;
}

export type RedemptionOutcome =
  | { ok: true; companyId: string; companyName: string; role: Role; invitationId: string }
  | { ok: false; reason: RedemptionRefusal | "REDEMPTION_FAILED" };

/**
 * Redeem a token: the one path by which somebody joins a company they did not
 * create.
 *
 * THE MEMBERSHIP IS WRITTEN BEFORE THE INVITATION IS MARKED ACCEPTED, and the
 * order is deliberate. Postgres has no transaction across two PostgREST calls,
 * so one of the two writes can be the last thing that happens. Membership-first
 * means a crash in between leaves a person who IS in the company holding an
 * invitation that still looks outstanding — visible, harmless, and fixed by the
 * `ALREADY_MEMBER` branch the moment they click again. The reverse order leaves
 * a burnt token and no membership: the user is locked out and the admin has to
 * issue a new invitation to a person who already clicked accept.
 *
 * The membership insert is also the real concurrency control. Two tabs racing
 * the same token both pass `decideRedemption`, and the second loses on the
 * `(user_id, company_id)` primary key rather than on anything this code checks.
 */
export async function redeemInvitation(
  db: SupabaseClient,
  params: {
    /**
     * How the caller reached this invitation. `token` is the emailed secret;
     * `invitationId` is the onboarding page, where the user was shown an
     * invitation addressed to them and has no token to present — see
     * `RedemptionProof` for why the two are not equivalent.
     */
    lookup: { token: string } | { invitationId: string };
    userId: string;
    email: string;
    emailVerified: boolean;
  }
): Promise<RedemptionOutcome> {
  const proof: RedemptionProof = "token" in params.lookup ? "token" : "verified-email";

  const invitation =
    "token" in params.lookup
      ? await findInvitationByToken(db, params.lookup.token)
      : await findInvitationById(db, params.lookup.invitationId);

  if (!invitation) return { ok: false, reason: "INVITATION_NOT_FOUND" };

  // A user belongs to exactly one company — `requireAuth()` assumes a single
  // `company_members` row — so this is read fresh rather than trusted from
  // invite time. An invitation lives a week; a person can join somewhere else
  // on day three, and admitting them anyway would give them two rows and break
  // their own sign-in on every future request.
  const { data: memberships, error: membershipErr } = await db
    .from("company_members")
    .select("company_id")
    .eq("user_id", params.userId);

  if (membershipErr) {
    console.error("[redeemInvitation] membership lookup failed:", membershipErr);
    return { ok: false, reason: "REDEMPTION_FAILED" };
  }

  const decision = decideRedemption(
    invitation,
    {
      email: params.email,
      currentCompanyId: memberships?.[0]?.company_id ?? null,
      emailVerified: params.emailVerified,
    },
    proof
  );

  if (!decision.ok) return { ok: false, reason: decision.reason };

  const { error: insertErr } = await db.from("company_members").insert({
    company_id: decision.companyId,
    user_id: params.userId,
    role: decision.role,
  });

  if (insertErr) {
    // 23505: they are already a member — a double click, or two tabs. The
    // invitation is still marked accepted below, because it HAS been.
    if (insertErr.code !== "23505") {
      console.error("[redeemInvitation] membership insert failed:", insertErr);
      return { ok: false, reason: "REDEMPTION_FAILED" };
    }
  }

  // Guarded on `accepted_at is null` so a redelivery cannot rewrite who
  // accepted or when. The membership is already in place either way, so a
  // no-op here is not a failure and must not be reported as one.
  const { error: acceptErr } = await db
    .from("company_invitations")
    .update({ accepted_at: new Date().toISOString(), accepted_by: params.userId })
    .eq("id", invitation.id)
    .is("accepted_at", null);

  if (acceptErr) {
    // The membership exists, so the user is in. Losing the acceptance stamp is
    // an audit gap worth logging loudly, not a reason to refuse someone who has
    // already been admitted.
    console.error("[redeemInvitation] failed to mark invitation accepted:", acceptErr);
  }

  const companyName = (await invitationCompanyName(db, decision.companyId)) ?? "";

  return {
    ok: true,
    companyId: decision.companyId,
    companyName,
    role: decision.role,
    invitationId: invitation.id,
  };
}

/** Outstanding invitations for a company — what the team page lists as pending. */
export async function listOutstandingInvitations(
  db: SupabaseClient,
  companyId: string
): Promise<InvitationSummary[]> {
  const { data, error } = await db
    .from("company_invitations")
    .select("id, email, role, created_at, expires_at, invited_by")
    .eq("company_id", companyId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  // Expiry is filtered in code rather than with a `gt("expires_at", now)`
  // clause so the team page can show "expired" as a state an admin can see and
  // re-send, instead of an invitation that silently vanishes from the list.
  return data.map((row) => ({
    id: row.id,
    email: row.email,
    role: invitationRole(row.role),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    invitedBy: row.invited_by ?? null,
  }));
}

/**
 * Invitations waiting for this email address, across every company.
 *
 * Powers the onboarding page: somebody who signs up after being invited should
 * be offered the tenant they were invited to, not asked to create a new one.
 * Scoped by email only — it is the signed-in user's own address, established
 * from their session and never taken from a query parameter.
 */
export async function pendingInvitationsForEmail(
  db: SupabaseClient,
  email: string
): Promise<Array<InvitationSummary & { companyId: string; companyName: string }>> {
  const { data, error } = await db
    .from("company_invitations")
    .select("id, company_id, email, role, created_at, expires_at, invited_by, companies ( name )")
    .ilike("email", email.trim())
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error || !data) return [];

  return data.map((row) => {
    const companies = row.companies as unknown;
    const name = Array.isArray(companies)
      ? (companies[0] as { name?: string } | undefined)?.name
      : (companies as { name?: string } | null)?.name;
    return {
      id: row.id,
      companyId: row.company_id,
      companyName: name ?? "",
      email: row.email,
      role: invitationRole(row.role),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      invitedBy: row.invited_by ?? null,
    };
  });
}

/**
 * Withdraw an outstanding invitation.
 *
 * Scoped to the caller's company AND to the not-yet-terminal state, so an admin
 * cannot revoke another tenant's invitation and cannot retroactively "revoke"
 * one that was already accepted — that person is a member now, and removing
 * them is `DELETE /api/settings/members`, a different act with a different
 * audit meaning.
 */
export async function revokeInvitation(
  db: SupabaseClient,
  params: { invitationId: string; companyId: string; revokedBy: string }
): Promise<{ ok: boolean; email?: string }> {
  const { data, error } = await db
    .from("company_invitations")
    .update({ revoked_at: new Date().toISOString(), revoked_by: params.revokedBy })
    .eq("id", params.invitationId)
    .eq("company_id", params.companyId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("email");

  if (error) {
    console.error("[revokeInvitation] failed:", error);
    return { ok: false };
  }
  // `.select()` so a no-op is distinguishable from a success. An UPDATE that
  // matched nothing is not an error in PostgREST, and reporting "invitation
  // withdrawn" for a row that was never touched is exactly the class of bug the
  // members DELETE route had before Phase 14.
  if (!data || data.length === 0) return { ok: false };

  return { ok: true, email: data[0].email };
}
