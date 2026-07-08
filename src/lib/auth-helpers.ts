import { createServiceRoleClient } from "@/lib/supabase/server";

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

export async function ensureDemoUser() {
  const supabase = createServiceRoleClient();
  const email = "demo@laygrounded.io";
  const password = "demo1234";

  let { data: usersData } = await supabase.auth.admin.listUsers();
  let user = usersData?.users.find((u) => u.email === email);

  if (!user) {
    const { data: newUser, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: "Demo Captain" }
    });
    if (error || !newUser.user) throw new Error("Could not create demo user");
    user = newUser.user;
  }

  await bootstrapUserCompany(user.id, user.email!, "LayGrounded Demo Fleet");
  return user;
}
