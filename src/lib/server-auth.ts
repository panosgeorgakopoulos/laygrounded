import { createClient } from "@/lib/supabase/server";

export interface AuthContext {
  userId: string;
  email: string;
  companyId: string;
  companyName: string;
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
  };
}
