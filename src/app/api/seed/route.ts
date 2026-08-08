import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireCapability } from "@/lib/server-auth";
import { seedScenarios } from "@/lib/seed-data";
import { seedScenario } from "@/lib/seed-claims";
import { apiError } from "@/lib/api-errors";

// Demo scenarios for an empty workspace.
//
// GATED ON `claim.write`, added in Phase 16 after the RBAC E2E suite went
// looking for it. This route WRITES CLAIMS and was behind `requireAuth()`
// alone, so a viewer — the role whose entire definition is "changes nothing" —
// could put three claims into the tenant. The idempotency guard below limited
// the blast radius to a company with no claims yet, which is why it was never
// noticed, but "only works on a new tenant" is not an authorisation control.
//
// It is a collection route with no claim to own, so the check goes first, the
// same as `POST /api/claims`.
export async function POST() {
  try {
    const auth = await requireCapability("claim.write");
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
