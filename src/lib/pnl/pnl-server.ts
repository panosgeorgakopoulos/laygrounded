// Database bridge for the voyage P&L. All I/O here; the arithmetic is in
// `voyage-pnl.ts` and stays pure.
//
// The one piece of real integration logic in this file is the laytime bridge:
// for each claim linked to a voyage, the LATEST `laytime_calculations` row
// becomes a demurrage/despatch line. A linked claim with no calculation is
// carried through as `claimsAwaitingCalculation` rather than dropped, so the
// result says the sheet is incomplete instead of quietly reading as zero.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  computeVoyagePnl,
  type LaytimeOutcome,
  type VoyagePnlInput,
  type VoyagePnlResult,
} from "@/lib/pnl/voyage-pnl";

// === Validation ===
// Terms and costs are user-supplied JSON, so they are validated at the boundary
// exactly as `cp_terms` is by `CpTermsSchema`. A P&L whose terms fail this can
// never reach the calculator.

const MoneyItemSchema = z.object({
  label: z.string().min(1).max(200),
  amount: z.number().finite(),
  currency: z.string().length(3),
});

const BunkerLiftSchema = z.object({
  grade: z.string().min(1).max(20),
  tonnes: z.number().finite().min(0),
  pricePerTonne: z.number().finite().min(0),
  currency: z.string().length(3),
});

/** Fuel on board settled at delivery/redelivery. Same shape, different meaning. */
const BunkerSettlementSchema = BunkerLiftSchema;

export const PnlTermsSchema = z.object({
  freight: z
    .object({
      basis: z.enum(["per_mt", "lumpsum"]),
      ratePerMt: z.number().finite().min(0).optional(),
      lumpsum: z.number().finite().min(0).optional(),
      quantityMt: z.number().finite().min(0).optional(),
      deadfreightMt: z.number().finite().min(0).optional(),
    })
    .optional(),
  commissions: z.object({
    addressPct: z.number().finite().min(0).max(100),
    brokeragePct: z.number().finite().min(0).max(100),
    // No default: whether commission bites on demurrage varies by charterparty,
    // and a default here would silently pick a side for every fixture.
    onDemurrage: z.boolean(),
  }),
  timeCharter: z
    .object({
      hireRatePerDay: z.number().finite().min(0),
      offHire: z
        .array(
          z.object({
            from: z.string().datetime({ offset: true }),
            to: z.string().datetime({ offset: true }),
            reason: z.string().max(200).default(""),
          })
        )
        .default([]),
      ilohc: z.number().finite().min(0).optional(),
      cvePerMonth: z.number().finite().min(0).optional(),
      // Quantities are non-negative; the DIRECTION is carried by which field
      // this is, not by the sign. A negative BOD would otherwise silently mean
      // "the owner paid the charterer for fuel at delivery", which is not a
      // thing, and would flip a line on the sheet with no indication why.
      bunkersOnDelivery: BunkerSettlementSchema.optional(),
      bunkersOnRedelivery: BunkerSettlementSchema.optional(),
    })
    .optional(),
});

export const PnlCostsSchema = z.object({
  bunkers: z.array(BunkerLiftSchema).default([]),
  portCosts: z.array(MoneyItemSchema).default([]),
  otherCosts: z.array(MoneyItemSchema).default([]),
});

export type PnlTerms = z.infer<typeof PnlTermsSchema>;
export type PnlCosts = z.infer<typeof PnlCostsSchema>;

export interface VoyagePnlRow {
  id: string;
  company_id: string;
  vessel: string;
  voyage_ref: string;
  charter_type: "voyage" | "time";
  perspective: "owner" | "charterer";
  currency: string;
  terms: unknown;
  costs: unknown;
  voyage_start: string | null;
  voyage_end: string | null;
  status: "estimate" | "actual" | "closed";
  notes: string | null;
}

export interface LoadedPnl {
  pnl: VoyagePnlRow;
  claimIds: string[];
  result: VoyagePnlResult;
}

/**
 * Demurrage and despatch for each linked claim, from the engine's own output.
 *
 * Returns the claims that HAVE a calculation and, separately, those that do
 * not. The split is the whole point: a claim awaiting calculation must surface
 * as an explicit gap on the sheet, never as an absent line indistinguishable
 * from a zero-demurrage voyage.
 */
async function loadLaytimeOutcomes(
  claimIds: string[],
  supabase: SupabaseClient
): Promise<{ outcomes: LaytimeOutcome[]; awaiting: string[] }> {
  if (claimIds.length === 0) return { outcomes: [], awaiting: [] };

  const { data, error } = await supabase
    .from("laytime_calculations")
    .select("id, claim_id, demurrage_amount, despatch_amount, currency, computed_at")
    .in("claim_id", claimIds)
    .order("computed_at", { ascending: false });
  if (error) throw new Error(`LAYTIME_READ_FAILED: ${error.message}`);

  const latest = new Map<string, LaytimeOutcome>();
  for (const row of data ?? []) {
    // Ordered newest-first, so the first sighting of a claim is its latest.
    if (latest.has(row.claim_id)) continue;
    latest.set(row.claim_id, {
      claimId: row.claim_id,
      calculationId: row.id,
      demurrage: row.demurrage_amount ?? 0,
      despatch: row.despatch_amount ?? 0,
      currency: row.currency ?? "USD",
    });
  }

  return {
    outcomes: [...latest.values()],
    awaiting: claimIds.filter((id) => !latest.has(id)),
  };
}

/** Assembles the calculator input from a stored P&L and computes it. */
export async function computeStoredPnl(
  pnlId: string,
  supabase: SupabaseClient
): Promise<LoadedPnl> {
  const { data: pnl, error } = await supabase
    .from("voyage_pnl")
    .select("*")
    .eq("id", pnlId)
    .maybeSingle();
  if (error || !pnl) throw new Error("PNL_NOT_FOUND");

  const { data: links } = await supabase
    .from("voyage_pnl_claims")
    .select("claim_id")
    .eq("pnl_id", pnlId);
  const claimIds = (links ?? []).map((l) => l.claim_id as string);

  const terms = PnlTermsSchema.safeParse(pnl.terms);
  if (!terms.success) throw new Error("INVALID_PNL_TERMS");
  const costs = PnlCostsSchema.safeParse(pnl.costs ?? {});
  if (!costs.success) throw new Error("INVALID_PNL_COSTS");

  const { outcomes, awaiting } = await loadLaytimeOutcomes(claimIds, supabase);

  const input: VoyagePnlInput = {
    charterType: pnl.charter_type,
    perspective: pnl.perspective,
    currency: pnl.currency,
    voyageStart: pnl.voyage_start,
    voyageEnd: pnl.voyage_end,
    freight: terms.data.freight,
    commissions: terms.data.commissions,
    timeCharter: terms.data.timeCharter,
    bunkers: costs.data.bunkers,
    portCosts: costs.data.portCosts,
    otherCosts: costs.data.otherCosts,
    laytime: outcomes,
    claimsAwaitingCalculation: awaiting,
  };

  return { pnl: pnl as VoyagePnlRow, claimIds, result: computeVoyagePnl(input) };
}

/**
 * Computes and snapshots.
 *
 * A new row per computation rather than an update, so the history of what the
 * sheet said survives an input changing — the same reason `laytime_calculations`
 * keeps its own history.
 */
export async function recomputeAndStorePnl(
  pnlId: string,
  supabase: SupabaseClient
): Promise<LoadedPnl> {
  const loaded = await computeStoredPnl(pnlId, supabase);
  const r = loaded.result;

  const { error } = await supabase.from("voyage_pnl_results").insert({
    pnl_id: pnlId,
    lines: r.lines,
    gross_revenue: r.grossRevenue,
    revenue_deductions: r.revenueDeductions,
    voyage_expenses: r.voyageExpenses,
    transfers: r.transfers,
    net_result: r.netResult,
    tce_per_day: r.tcePerDay,
    voyage_days: r.voyageDays,
    currency: r.currency,
    warnings: r.warnings,
  });
  if (error) throw new Error(`PNL_RESULT_PERSIST_FAILED: ${error.message}`);

  return loaded;
}

/**
 * Links claims to a voyage, rejecting any that belong to another company.
 *
 * Checked here rather than left to RLS: `voyage_pnl_claims` is gated on the
 * P&L's company, not the claim's, so RLS alone would happily let a voyage
 * reference a claim the caller cannot read — and its demurrage would then
 * appear on their sheet.
 */
export async function linkClaims(
  pnlId: string,
  companyId: string,
  claimIds: string[],
  supabase: SupabaseClient
): Promise<{ linked: string[]; rejected: string[] }> {
  if (claimIds.length === 0) return { linked: [], rejected: [] };

  const { data: owned, error } = await supabase
    .from("claims")
    .select("id")
    .eq("company_id", companyId)
    .in("id", claimIds);
  if (error) throw new Error(`CLAIM_LOOKUP_FAILED: ${error.message}`);

  const ownedIds = new Set((owned ?? []).map((c) => c.id as string));
  const linked = claimIds.filter((id) => ownedIds.has(id));
  const rejected = claimIds.filter((id) => !ownedIds.has(id));

  if (linked.length > 0) {
    const { error: insErr } = await supabase
      .from("voyage_pnl_claims")
      .upsert(
        linked.map((claim_id) => ({ pnl_id: pnlId, claim_id })),
        { onConflict: "pnl_id,claim_id", ignoreDuplicates: true }
      );
    if (insErr) throw new Error(`CLAIM_LINK_FAILED: ${insErr.message}`);
  }

  return { linked, rejected };
}
