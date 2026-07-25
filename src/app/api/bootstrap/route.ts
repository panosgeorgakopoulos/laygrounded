import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { bootstrapUserCompany } from "@/lib/auth-helpers";

// First-run company bootstrap, called by the sign-up form immediately after
// supabase.auth.signUp(). Creates the user's company + admin membership so
// requireAuth() (which resolves the tenant from company_members) succeeds on
// the very first authenticated request. Idempotent: a user who already has a
// company gets it back rather than a second one. Without this route the chosen
// company name was silently dropped and a new account landed on /claims with no
// company (NO_COMPANY).
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || !user.email) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { companyName?: unknown };
    const companyName = typeof body.companyName === "string" ? body.companyName : undefined;

    const result = await bootstrapUserCompany(user.id, user.email, companyName);
    return NextResponse.json({
      companyId: result.companyId,
      companyName: result.companyName,
    });
  } catch (e) {
    console.error("[api/bootstrap]", e);
    return NextResponse.json({ error: "BOOTSTRAP_FAILED" }, { status: 500 });
  }
}
