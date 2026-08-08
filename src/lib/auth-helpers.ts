import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

export async function bootstrapUserCompany(
  userId: string,
  userEmail: string,
  companyName?: string
): Promise<{ companyId: string; companyName: string }> {
  const supabase = createServiceRoleClient();
  
  const { data: existing } = await supabase
    .from("company_members")
    .select("company_id, companies(name)")
    .eq("user_id", userId)
    .single();

  if (existing) {
    const cName = Array.isArray(existing.companies)
      ? existing.companies[0]?.name
      : (existing.companies as any)?.name;
    return { companyId: existing.company_id, companyName: cName };
  }

  const name = companyName?.trim() || `${userEmail.split("@")[0]}'s Fleet`;
  
  const { data: company, error: cErr } = await supabase
    .from("companies")
    .insert({ name })
    .select("id, name")
    .single();

  if (cErr || !company) throw new Error("Failed to create company: " + cErr?.message);

  const { error: mErr } = await supabase
    .from("company_members")
    .insert({
      company_id: company.id,
      user_id: userId,
      role: "admin",
    });

  if (mErr) throw new Error("Failed to assign company admin: " + mErr?.message);

  return { companyId: company.id, companyName: company.name };
}

/**
 * Demo accounts at each non-admin role, so the RBAC boundaries can be exercised
 * as a person rather than only asserted in tests.
 *
 * The demo tenant's only account was an admin, which meant every capability
 * check passed and the interesting half of Phase 14 — the refusals — could not
 * be seen in a browser at all. `operator` is the boundary the model exists for
 * (does the laytime work, touches none of the money); `viewer` is the other
 * end, and the one that proves `claim.write` actually binds.
 *
 * NO ADMIN HERE, deliberately. `demo2@laygrounded.com` already holds that role,
 * and a second known-password admin is a second key to the whole tenant for no
 * additional test coverage.
 */
export const RBAC_TEST_USERS = [
  { email: "operator@laygrounded.com", role: "operator", displayName: "Demo Operator" },
  { email: "viewer@laygrounded.com", role: "viewer", displayName: "Demo Viewer" },
] as const;

/** Shared with `ensureDemoUser`; these are demo credentials, not secrets. */
const DEMO_PASSWORD = "demo1234";

/**
 * Creates (or repairs) the role test accounts inside an EXISTING company.
 *
 * Deliberately does not call `bootstrapUserCompany`: that creates a company
 * when the user has no membership, which is exactly the wrong outcome here —
 * the accounts are only useful inside the demo tenant, sharing its claims. A
 * seeded "operator" sitting alone in a company of their own would pass every
 * ownership check and test nothing.
 *
 * Idempotent: re-running resets the password and re-asserts the role, so an
 * account someone has since promoted by hand returns to its seeded state.
 */
export async function ensureRoleTestUsers(
  companyId: string
): Promise<Array<{ email: string; role: string; userId: string; created: boolean }>> {
  const supabase = createServiceRoleClient();
  const out: Array<{ email: string; role: string; userId: string; created: boolean }> = [];

  for (const spec of RBAC_TEST_USERS) {
    // The RPC rather than auth.admin.listUsers(): that call paginates at 50, so
    // a lookup by scanning page one silently starts missing users the moment a
    // tenant grows past it, and would then create a duplicate account.
    const { data: existingId, error: lookupErr } = await supabase.rpc("get_user_id_by_email", {
      email_addr: spec.email,
    });
    if (lookupErr) throw new Error(`RBAC_SEED_LOOKUP_FAILED: ${lookupErr.message}`);

    let userId = existingId as string | null;
    let created = false;

    if (userId) {
      await supabase.auth.admin.updateUserById(userId, { password: DEMO_PASSWORD });
    } else {
      const { data: newUser, error } = await supabase.auth.admin.createUser({
        email: spec.email,
        password: DEMO_PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: spec.displayName },
      });
      if (error || !newUser.user) {
        throw new Error(`RBAC_SEED_CREATE_FAILED: ${error?.message ?? "no user returned"}`);
      }
      userId = newUser.user.id;
      created = true;
    }

    // A user belongs to exactly one company (requireAuth assumes a single
    // membership row). Any membership elsewhere is removed first, or this
    // account would end up with two and break its own sign-in.
    await supabase.from("company_members").delete().eq("user_id", userId).neq("company_id", companyId);

    const { error: memberErr } = await supabase
      .from("company_members")
      .upsert(
        { company_id: companyId, user_id: userId, role: spec.role },
        { onConflict: "user_id,company_id" }
      );
    if (memberErr) throw new Error(`RBAC_SEED_MEMBERSHIP_FAILED: ${memberErr.message}`);

    out.push({ email: spec.email, role: spec.role, userId: userId!, created });
  }

  return out;
}

export async function ensureDemoUser() {
  const supabase = createServiceRoleClient();
  const email = "demo2@laygrounded.com";
  const password = "demo1234";

  let { data: usersData, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) throw new Error("LIST USERS ERR: " + JSON.stringify(listError));
  let user = usersData?.users.find((u) => u.email === email);

  if (!user) {
    const { data: newUser, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: "Demo Captain" }
    });
    if (error || !newUser.user) {
      console.error("CREATE USER ERR:", error);
      throw new Error("Could not create demo user: " + JSON.stringify(error));
    }
    user = newUser.user;
  } else {
    await supabase.auth.admin.updateUserById(user.id, { password });
  }

  await bootstrapUserCompany(user.id, user.email!, "LayGrounded Demo Fleet");
  return user;
}
