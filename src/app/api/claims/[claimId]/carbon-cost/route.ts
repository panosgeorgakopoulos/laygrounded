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
import { resolveEeaPort } from "@/lib/compliance/eea-ports";

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
      .select("id, company_id, port, ets_applicable")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const { data: calc } = await supabase
      .from("laytime_calculations")
      .select("used_hours, allowed_hours, demurrage_amount, currency, computed_at")
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

    // EU ETS scope. An explicit `ets_applicable` on the claim always wins; the
    // port-string resolver is the fallback and returns UNKNOWN rather than
    // guessing, which the estimator then presents as potential exposure.
    //
    // Before this was wired in, the EUA figure assumed a flat 100% coverage
    // regardless of geography — so every non-EEA delay was billed a liability
    // that does not exist. Two of the claims on file are Australian.
    const resolved = resolveEeaPort(claim.port);
    const eeaPort = claim.ets_applicable ?? resolved.eeaPort;
    const scopeBasis =
      claim.ets_applicable != null
        ? "Set explicitly on the claim."
        : resolved.reason;

    const report = buildCarbonCostOfDelay({
      delayHours,
      fuel,
      engineTier,
      eeaPort,
      // The year the calculation is about, not today — the phase-in factor is a
      // property of when the delay happened.
      year: new Date(calc.computed_at ?? Date.now()).getUTCFullYear(),
      demurrageAmount: calc.demurrage_amount ?? undefined,
      currency: calc.currency ?? undefined,
    });

    return NextResponse.json({
      report,
      etsScopeBasis: scopeBasis,
      port: claim.port,
      // Surface the option lists so the UI can offer the same fuels/tiers the
      // engine knows, without hardcoding them separately.
      fuels: Object.entries(MARINE_FUELS).map(([id, p]) => ({ id, label: p.label })),
      engineTiers: Object.keys(NOX_KG_PER_TONNE_FUEL),
    });
  } catch (e) {
    return apiError(e, "claims/carbon-cost/GET", { NO_CALCULATION: 409 });
  }
}
