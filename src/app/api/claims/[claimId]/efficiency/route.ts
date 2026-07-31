import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { computeAchievedRate } from "@/lib/efficiency/cargo-rate";
import { attributeInefficiency, deductionEvents } from "@/lib/efficiency/attribution";
import { marketRateForLane } from "@/lib/efficiency/market-server";
import { CpTermsSchema } from "@/lib/laytime/recompute-server";
import type { SofEventInput } from "@/lib/laytime/types";

// Terminal efficiency for one claim: what rate the berth achieved, against the
// charterparty's stipulated rate and — when the pooled data supports it — the
// market.
//
// THE DEDUCTION IS NOT AUTOMATIC. A rate shortfall is measured and priced, but
// converting it into deductible time requires a stated basis (owner's fault, or
// a CP clause), supplied by the caller. See ets attribution.ts for why: a
// stipulated rate derives the laytime allowance rather than warranting the
// terminal, so deducting the shortfall would double-count the rate and reverse
// the risk the parties allocated.

const BodySchema = z.object({
  basis: z.enum(["net", "gross"]).optional(),
  /** Overrides the rate read from cp_terms, when the CP says something else. */
  contractualTonnesPerDay: z.number().min(1).max(500_000).nullish(),
  /** Overrides a cargo description the parser cannot read. */
  cargoTonnes: z.number().min(1).max(1_000_000).nullish(),
  deductionBasis: z
    .object({
      kind: z.enum(["owner_fault", "cp_clause"]),
      reference: z.string().min(3).max(300),
      hours: z.number().min(0).max(2000).optional(),
    })
    .nullish(),
  includeMarket: z.boolean().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const body = parsed.data;
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, vessel, port, terminal_name, cargo, cp_terms")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const cp = CpTermsSchema.safeParse(claim.cp_terms);
    if (!cp.success) throw new Error("INVALID_CP_TERMS");

    const { data: events } = await supabase
      .from("sof_events")
      .select("id, occurred_at, event_type")
      .eq("claim_id", claimId)
      .in("status", ["accepted", "edited"])
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true });

    const sofInputs = (events ?? []) as unknown as SofEventInput[];

    // An explicit tonnage overrides the parse, so an unreadable cargo string is
    // a prompt rather than a dead end.
    const cargoText = body.cargoTonnes ? `${body.cargoTonnes} MT` : claim.cargo;
    const achieved = computeAchievedRate(cargoText, sofInputs, body.basis ?? "net");

    if (!achieved) {
      return NextResponse.json(
        {
          error: "RATE_UNAVAILABLE",
          message:
            "The achieved rate needs both a cargo quantity and a completed operations window. " +
            "Either the cargo description carries no readable tonnage, or the timeline has no " +
            "commencement/completion pair. Supply cargoTonnes to override the quantity.",
          cargo: claim.cargo,
        },
        { status: 422 }
      );
    }

    // The CP's own stipulated rate. Loading vs discharge is decided by which
    // operation the timeline actually recorded.
    const isDischarge = sofInputs.some(
      (e) => (e.event_type as string) === "COMMENCED_DISCHARGE"
    );
    const contractualTonnesPerDay =
      body.contractualTonnesPerDay ??
      (isDischarge ? cp.data.discharge_rate : cp.data.load_rate) ??
      null;

    // Market benchmark: cross-tenant, so service-role, and the floors inside
    // marketRateForLane are the whole protection.
    let marketTonnesPerDay: number | null = null;
    let marketSampleSize: number | undefined;
    let marketUnavailableReason: string | null = null;
    let marketScope: "terminal" | "port" | null = null;
    let marketLabel: string | null = null;
    let marketFellBackToPortReason: string | null = null;

    if (body.includeMarket !== false) {
      const service = createServiceRoleClient();
      const market = await marketRateForLane(service, {
        port: claim.port,
        terminal: claim.terminal_name,
        cargo: claim.cargo,
        excludeCompanyId: auth.companyId,
        basis: body.basis ?? "net",
      });
      marketTonnesPerDay = market.rate?.medianTonnesPerDay ?? null;
      marketSampleSize = market.rate?.sampleSize;
      marketUnavailableReason = market.unavailableReason;
      marketScope = market.rate?.scope ?? null;
      marketLabel = market.rate?.terminalLabel ?? market.rate?.portLabel ?? null;
      marketFellBackToPortReason = market.fellBackToPortReason;
    }

    const attribution = attributeInefficiency({
      achieved,
      contractualTonnesPerDay,
      marketTonnesPerDay,
      marketSampleSize,
      marketUnavailableReason,
      marketScope,
      marketLabel,
      marketFellBackToPortReason,
      demurrageRatePerDay: cp.data.demurrage_rate,
      currency: cp.data.currency,
      cpForm: cp.data.cp_form ?? "GENCON94",
      daysBasis: cp.data.days_basis,
      deductionBasis: body.deductionBasis ?? null,
    });

    // The events a caller would append to the timeline to apply the deduction.
    // Returned rather than written: appending to a claim's confirmed timeline
    // is a human decision, and machine-derived events land `suggested` anyway.
    const anchor = achieved.workingTime.from;

    return NextResponse.json({
      vessel: claim.vessel,
      port: claim.port,
      terminalName: claim.terminal_name,
      cargo: claim.cargo,
      operation: isDischarge ? "discharge" : "loading",
      attribution,
      proposedDeductionEvents: deductionEvents(attribution, anchor),
    });
  } catch (e) {
    return apiError(e, "claims/efficiency", {
      INVALID_CP_TERMS: 422,
      RATE_UNAVAILABLE: 422,
    });
  }
}
