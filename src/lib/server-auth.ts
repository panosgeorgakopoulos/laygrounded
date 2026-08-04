import { createClient } from "@/lib/supabase/server";
import { can, roleOf, type Capability, type Role } from "@/lib/auth/roles";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";

export interface AuthContext {
  userId: string;
  email: string;
  companyId: string;
  companyName: string;
  /**
   * The caller's role in their company. Always a valid Role: `roleOf()` fails
   * closed, so a row carrying an unrecognised value reads as `viewer` rather
   * than as whatever the string happened to be.
   */
  role: Role;
}

export async function requireAuth(): Promise<AuthContext> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user || !user.email) {
    throw new Error("UNAUTHORIZED");
  }

  const { data: membership, error: memError } = await supabase
    .from("company_members")
    .select(`
      company_id,
      role,
      companies ( name )
    `)
    .eq("user_id", user.id)
    .maybeSingle();

  if (memError || !membership) {
    throw new Error("NO_COMPANY");
  }

  const companyName = Array.isArray(membership.companies)
    ? membership.companies[0]?.name
    : (membership.companies as any)?.name;

  return {
    userId: user.id,
    email: user.email,
    companyId: membership.company_id,
    companyName: companyName || "",
    role: roleOf(membership.role),
  };
}

/**
 * `requireAuth()` plus a capability check. Throws `FORBIDDEN` (403 via
 * `apiError`) when the caller's role is too low.
 *
 * THIS IS THE PRIMARY ENFORCEMENT, not the RLS policies added alongside it.
 * Most routes in this app hold a service-role handle, which bypasses RLS
 * entirely — so a model enforced only in the database would be enforced on
 * roughly the routes that need it least. The policies in
 * `20260805000000_rbac_roles.sql` are the second layer, covering the
 * cookie-client paths, in the same defense-in-depth spirit as the existing
 * `claim.company_id === auth.companyId` checks.
 *
 * Pass `audit` to record the denial. Worth doing on anything that moves money
 * or hands out a credential: a refused attempt is the entry an investigation
 * actually wants, and it is the one nobody writes.
 */
export async function requireCapability(
  capability: Capability,
  audit?: { req: { headers: Headers }; resourceType?: string; resourceId?: string }
): Promise<AuthContext> {
  const auth = await requireAuth();
  await assertCapability(auth, capability, audit);
  return auth;
}

/**
 * The same check against a context the caller already has.
 *
 * Exists so a route that has resolved ownership (and therefore already paid for
 * `requireAuth`) can add the capability gate without a second round trip, and —
 * more importantly — can put the gate AFTER the ownership check, so a 403 never
 * doubles as confirmation that someone else's claim id is real.
 */
export async function assertCapability(
  auth: AuthContext,
  capability: Capability,
  audit?: { req: { headers: Headers }; resourceType?: string; resourceId?: string }
): Promise<void> {
  if (can(auth.role, capability)) return;

  if (audit) {
    // Never let an audit-write failure convert a 403 into a 500 — the denial is
    // the security-relevant outcome and it must stand on its own.
    try {
      await recordSecurityEvent({
        companyId: auth.companyId,
        action: "capability.denied",
        actorId: auth.userId,
        actorLabel: auth.email,
        resourceType: audit.resourceType,
        resourceId: audit.resourceId,
        outcome: "denied",
        metadata: { capability, role: auth.role },
        ...requestAttribution(audit.req),
      });
    } catch (e) {
      console.error("[assertCapability] failed to record denial", e);
    }
  }

  throw new Error("FORBIDDEN");
}
