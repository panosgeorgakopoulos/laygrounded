// Risk & compliance scan: enriches a claim with sanctions screening
// (vessel + counterparty) and an EU ETS carbon-cost estimate for the port
// delay. Replace-on-rerun snapshot, same model as evidence verification.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { screenEntity } from "./sanctions";
import { computeEtsEstimate, EtsEstimate } from "./ets";

export interface ComplianceCheckRow {
  id: string;
  claim_id: string;
  subject_type: "vessel" | "counterparty";
  subject: string;
  verdict: "clear" | "possible_match" | "match" | "unavailable";
  risk_score: number | null;
  matches: unknown[];
  source: string;
  checked_at: string;
}

export interface ComplianceScanResult {
  checks: ComplianceCheckRow[];
  ets: (EtsEstimate & { applicable: boolean | null }) | null;
}

export async function runComplianceScan(
  claimId: string,
  client?: SupabaseClient
): Promise<ComplianceScanResult> {
  const supabase = client ?? (await createClient());

  const { data: claim } = await supabase
    .from("claims")
    .select("id, vessel, vessel_imo, counterparty_name, ets_applicable")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) throw new Error("CLAIM_NOT_FOUND");

  // --- Sanctions screening ---
  const pending: Array<{
    subject_type: "vessel" | "counterparty";
    subject: string;
    promise: ReturnType<typeof screenEntity>;
  }> = [];

  if (claim.vessel) {
    pending.push({
      subject_type: "vessel",
      subject: claim.vessel,
      promise: screenEntity(claim.vessel, "Vessel", {
        imoNumber: claim.vessel_imo ?? undefined,
      }),
    });
  }
  if (claim.counterparty_name) {
    pending.push({
      subject_type: "counterparty",
      subject: claim.counterparty_name,
      promise: screenEntity(claim.counterparty_name, "Company"),
    });
  }

  const rows = await Promise.all(
    pending.map(async (p) => {
      const r = await p.promise;
      return {
        claim_id: claimId,
        subject_type: p.subject_type,
        subject: p.subject,
        verdict: r.verdict,
        risk_score: r.riskScore,
        matches: r.matches.length > 0 ? r.matches : [{ summary: r.summary }],
        source: r.source,
      };
    })
  );

  const { error: delErr } = await supabase
    .from("compliance_checks")
    .delete()
    .eq("claim_id", claimId);
  if (delErr) throw new Error(`PERSIST_FAILED: ${delErr.message}`);

  let checks: ComplianceCheckRow[] = [];
  if (rows.length > 0) {
    const { data: inserted, error: insErr } = await supabase
      .from("compliance_checks")
      .insert(rows)
      .select("*");
    if (insErr) throw new Error(`PERSIST_FAILED: ${insErr.message}`);
    checks = (inserted ?? []) as ComplianceCheckRow[];
  }

  // --- EU ETS estimate for the delay ---
  const { data: calc } = await supabase
    .from("laytime_calculations")
    .select("used_hours, allowed_hours")
    .eq("claim_id", claimId)
    .maybeSingle();

  let ets: ComplianceScanResult["ets"] = null;
  const delayHours = calc ? Math.max(0, calc.used_hours - calc.allowed_hours) : 0;

  if (delayHours > 0) {
    const estimate = computeEtsEstimate({ delayHours });
    const { error: etsErr } = await supabase.from("ets_estimates").upsert(
      {
        claim_id: claimId,
        delay_hours: estimate.delayHours,
        fuel_tonnes_per_day: estimate.fuelTonnesPerDay,
        co2_per_tonne_fuel: estimate.co2PerTonneFuel,
        eua_price_eur: estimate.euaPriceEur,
        coverage_pct: estimate.coveragePct,
        co2_tonnes: estimate.co2Tonnes,
        estimated_cost_eur: estimate.estimatedCostEur,
        inputs: {
          // Estimate provenance: which assumptions were defaults vs claim data.
          applicable: claim.ets_applicable,
          basis: "at-berth auxiliary consumption during hours on demurrage",
        },
        computed_at: new Date().toISOString(),
      },
      { onConflict: "claim_id" }
    );
    if (etsErr) throw new Error(`PERSIST_FAILED: ${etsErr.message}`);
    ets = { ...estimate, applicable: claim.ets_applicable };
  } else {
    // No delay → no exposure; clear any stale estimate.
    await supabase.from("ets_estimates").delete().eq("claim_id", claimId);
  }

  return { checks, ets };
}
