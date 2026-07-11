import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { seedScenarios } from "@/lib/seed-data";
import { seedScenario } from "@/lib/seed-claims";
import { apiError } from "@/lib/api-errors";

export async function POST() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    // Idempotency: never seed a company that already has claims, so repeated
    // calls (double-click, retry) can't accumulate duplicate demo data.
    const { count } = await supabase
      .from("claims")
      .select("id", { count: "exact", head: true })
      .eq("company_id", auth.companyId);

    if (count && count > 0) {
      return NextResponse.json({ seeded: 0, alreadySeeded: true, claimIds: [] });
    }

    const created: string[] = [];

    for (const scenario of seedScenarios) {
      const claimId = await seedScenario(supabase, {
        companyId: auth.companyId,
        userId: auth.userId,
        scenario,
      });
      if (claimId) created.push(claimId);
    }

    return NextResponse.json({ seeded: created.length, claimIds: created });
  } catch (e) {
    return apiError(e, "seed/POST");
  }
}
