import { NextResponse } from "next/server";
import { ensureDemoUser } from "@/lib/auth-helpers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { seedScenarios } from "@/lib/seed-data";
import { seedScenario } from "@/lib/seed-claims";
import { apiError } from "@/lib/api-errors";

export async function POST(req: Request) {
  const expectedSecret = process.env.INIT_DEMO_SECRET;
  if (!expectedSecret || req.headers.get("x-init-secret") !== expectedSecret) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  try {
    const supabase = createServiceRoleClient();
    const user = await ensureDemoUser();
    const { data: membership } = await supabase
      .from("company_members")
      .select("company_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json({ ok: false, reason: "no membership" });
    }

    const { count } = await supabase
      .from("claims")
      .select("id", { count: "exact" })
      .eq("company_id", membership.company_id);

    if (count && count > 0) {
      return NextResponse.json({ ok: true, alreadySeeded: true, demoEmail: user.email });
    }

    let seeded = 0;
    for (const scenario of seedScenarios) {
      const claimId = await seedScenario(supabase, {
        companyId: membership.company_id,
        userId: user.id,
        scenario,
      });
      if (claimId) seeded += 1;
    }
    return NextResponse.json({
      ok: true,
      seeded,
      demoEmail: user.email,
    });
  } catch (e) {
    return apiError(e, "init-demo/POST");
  }
}
