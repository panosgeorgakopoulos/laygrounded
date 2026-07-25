import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import {
  buildCarbonCostOfDelay,
  MARINE_FUELS,
  NOX_KG_PER_TONNE_FUEL,
  type MarineFuel,
  type EngineTier,
} from "@/lib/compliance/emissions";

// The "carbon cost of delay" (A7): the ESG footprint of a claim's demurrage
// delay — CO2 / NOx / SOx and the EU-ETS surrender cost — paired with the
// demurrage itself. An estimate for exposure/ESG awareness, not a verified MRV
// figure (which needs measured bunker data; see mrv.ts). Fuel grade and engine
// NOx tier are overridable via query so the desk can match the actual vessel.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const { data: calc } = await supabase
      .from("laytime_calculations")
      .select("used_hours, allowed_hours, demurrage_amount, currency")
      .eq("claim_id", claimId)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!calc) throw new Error("NO_CALCULATION");

    const delayHours = Math.max(0, (calc.used_hours ?? 0) - (calc.allowed_hours ?? 0));

    const fuelParam = req.nextUrl.searchParams.get("fuel");
    const tierParam = req.nextUrl.searchParams.get("engineTier");
    const fuel = (fuelParam && fuelParam in MARINE_FUELS ? fuelParam : undefined) as
      | MarineFuel
      | undefined;
    const engineTier = (tierParam && tierParam in NOX_KG_PER_TONNE_FUEL ? tierParam : undefined) as
      | EngineTier
      | undefined;

    const report = buildCarbonCostOfDelay({
      delayHours,
      fuel,
      engineTier,
      demurrageAmount: calc.demurrage_amount ?? undefined,
      currency: calc.currency ?? undefined,
    });

    return NextResponse.json({
      report,
      // Surface the option lists so the UI can offer the same fuels/tiers the
      // engine knows, without hardcoding them separately.
      fuels: Object.entries(MARINE_FUELS).map(([id, p]) => ({ id, label: p.label })),
      engineTiers: Object.keys(NOX_KG_PER_TONNE_FUEL),
    });
  } catch (e) {
    return apiError(e, "claims/carbon-cost/GET", { NO_CALCULATION: 409 });
  }
}
