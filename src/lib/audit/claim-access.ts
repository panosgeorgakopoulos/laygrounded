// Claim ownership guard with an audit side effect.
//
// Every claim-scoped route already checks claim.company_id === auth.companyId
// on top of RLS (the defence-in-depth pattern this codebase keeps). What was
// missing is that a REFUSED reach for a claim left no trace anywhere — and a
// burst of them is exactly the signal worth having: a stolen session probing
// claim ids, or an integration pointed at the wrong tenant.
//
// Note what the denial entry can and cannot say. RLS means the cookie client
// cannot see another company's claim at all, so "belongs to someone else" and
// "does not exist" are indistinguishable here without a service-role lookup on
// every miss. The entry therefore records the honest fact — this company asked
// for a claim it cannot see — and does not speculate about which.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, type AuthContext } from "@/lib/server-auth";
import { recordSecurityEvent } from "./security-log";

export interface OwnedClaim<T> {
  auth: AuthContext;
  supabase: SupabaseClient;
  claim: T;
}

/**
 * Resolves a claim the caller's company owns, or throws CLAIM_NOT_FOUND after
 * recording the refusal. `columns` must include company_id.
 */
export async function requireOwnedClaim<T extends { company_id: string }>(
  claimId: string,
  columns = "id, company_id",
  req?: { headers: Headers }
): Promise<OwnedClaim<T>> {
  const auth = await requireAuth();
  const supabase = await createClient();

  const { data: claim } = await supabase
    .from("claims")
    .select(columns)
    .eq("id", claimId)
    .maybeSingle();

  // PostgREST cannot infer a row type from a column list that is not a
  // literal, so the shape is asserted here; callers name it via T.
  const row = claim as unknown as T | null;

  if (!row || row.company_id !== auth.companyId) {
    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "claim.access_denied",
      actorType: "user",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "claim",
      resourceId: claimId,
      outcome: "denied",
      metadata: { reason: "claim not visible to this company" },
      ...(req ? attribution(req) : {}),
    });
    throw new Error("CLAIM_NOT_FOUND");
  }

  return { auth, supabase, claim: row };
}

function attribution(req: { headers: Headers }) {
  const ip =
    req.headers.get("x-real-ip")?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
  return { ip, userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null };
}
