// Clause P&L: what did each charterparty concession actually cost, across the
// whole book of claims?
//
// Because the engine is deterministic and pure, every clause question is just
// a counterfactual run: same events, one term changed. The deltas below are
// framed from the owner's perspective (net = demurrage receivable − despatch
// payable), so a negative clause effect means the clause moved money away
// from the owner.

import { Decimal } from "decimal.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import { CpTerms, SofEventInput } from "@/lib/laytime/types";

export interface ClauseEffect {
  key: string;
  label: string;
  // actual net − counterfactual net, in the claim's currency.
  deltaNet: number;
}

export interface ClaimPnl {
  claimId: string;
  vessel: string;
  voyageRef: string;
  port: string;
  cpForm: string;
  daysBasis: string;
  norVariant: string;
  currency: string;
  demurrage: number;
  despatch: number;
  net: number;
  settledAmount: number | null;
  clauseEffects: ClauseEffect[];
}

export interface ClauseAggregate {
  key: string;
  label: string;
  totalDelta: number;
  claimCount: number;
  currency: string;
}

export interface ClausePnlReport {
  claims: ClaimPnl[];
  // Aggregated per clause-effect key and currency.
  aggregates: ClauseAggregate[];
  totalsByCurrency: Array<{
    currency: string;
    demurrage: number;
    despatch: number;
    net: number;
    settled: number;
    settledClaimCount: number;
    // settled ÷ demurrage across claims that both claim demurrage and have a
    // recorded settlement; null when nothing has settled yet.
    recoveryRate: number | null;
  }>;
  skippedClaims: number;
}

function net(events: SofEventInput[], cpTerms: CpTerms): Decimal | null {
  try {
    const r = recomputeLaytime(events, cpTerms);
    return new Decimal(r.totals.demurrage_amount).minus(r.totals.despatch_amount);
  } catch {
    return null;
  }
}

function withoutPairedEvents(
  events: SofEventInput[],
  startType: string,
  endType: string
): SofEventInput[] {
  return events.filter((e) => e.event_type !== startType && e.event_type !== endType);
}

// Computes per-clause effects for a single claim. Exported for tests.
export function computeClaimClauseEffects(
  events: SofEventInput[],
  cpTerms: CpTerms
): ClauseEffect[] | null {
  const actual = net(events, cpTerms);
  if (actual === null) return null;

  const effects: ClauseEffect[] = [];
  const isAsba = (cpTerms.cp_form ?? "GENCON94") === "ASBATANKVOY";

  // Days basis: what the SHEX-family exception costs vs straight SHINC.
  // Meaningless under Asbatankvoy (running hours regardless).
  if (!isAsba && cpTerms.days_basis !== "SHINC") {
    const cf = net(events, { ...cpTerms, days_basis: "SHINC" });
    if (cf !== null) {
      effects.push({
        key: "days_basis",
        label: `${cpTerms.days_basis} vs SHINC`,
        deltaNet: actual.minus(cf).toDecimalPlaces(2).toNumber(),
      });
    }
  }

  // Turn time: the free hours conceded after NOR.
  if (cpTerms.turn_time_hours > 0) {
    const cf = net(events, { ...cpTerms, turn_time_hours: 0 });
    if (cf !== null) {
      effects.push({
        key: "turn_time",
        label: `Turn time ${cpTerms.turn_time_hours}h vs none`,
        deltaNet: actual.minus(cf).toDecimalPlaces(2).toNumber(),
      });
    }
  }

  // Weather: what the logged weather interruptions did to the outcome.
  if (events.some((e) => e.event_type === "WEATHER_DELAY")) {
    const cf = net(withoutPairedEvents(events, "WEATHER_DELAY", "WEATHER_DELAY_END"), cpTerms);
    if (cf !== null) {
      effects.push({
        key: "weather",
        label: "Weather interruptions",
        deltaNet: actual.minus(cf).toDecimalPlaces(2).toNumber(),
      });
    }
  }

  // Shifting: cost/benefit of the berthing-delay treatment.
  if (events.some((e) => e.event_type === "SHIFTING")) {
    const cf = net(withoutPairedEvents(events, "SHIFTING", "SHIFTING_END"), cpTerms);
    if (cf !== null) {
      effects.push({
        key: "shifting",
        label: "Shifting / berthing delays",
        deltaNet: actual.minus(cf).toDecimalPlaces(2).toNumber(),
      });
    }
  }

  return effects;
}

// Loads every claim of a company and builds the clause P&L report.
export async function buildClausePnlReport(
  companyId: string,
  supabase: SupabaseClient
): Promise<ClausePnlReport> {
  const { data: claims } = await supabase
    .from("claims")
    .select("id, vessel, voyage_ref, port, cp_form, cp_terms, settled_amount")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  const claimRows = claims || [];
  const claimIds = claimRows.map((c) => c.id);

  const eventsByClaim = new Map<string, SofEventInput[]>();
  if (claimIds.length > 0) {
    const { data: events } = await supabase
      .from("sof_events")
      .select("id, claim_id, occurred_at, event_type")
      .in("claim_id", claimIds)
      .in("status", ["accepted", "edited"])
      .order("occurred_at", { ascending: true });
    for (const e of events || []) {
      const list = eventsByClaim.get(e.claim_id) ?? [];
      list.push({ id: e.id, occurred_at: e.occurred_at, event_type: e.event_type });
      eventsByClaim.set(e.claim_id, list);
    }
  }

  const report: ClausePnlReport = {
    claims: [],
    aggregates: [],
    totalsByCurrency: [],
    skippedClaims: 0,
  };

  const aggMap = new Map<string, ClauseAggregate>();
  const totalsMap = new Map<
    string,
    { demurrage: Decimal; despatch: Decimal; settled: Decimal; settledDemurrage: Decimal; settledClaimCount: number }
  >();

  for (const claim of claimRows) {
    const cpTerms = claim.cp_terms as CpTerms | null;
    const events = eventsByClaim.get(claim.id) ?? [];
    if (!cpTerms || typeof cpTerms !== "object" || events.length === 0) {
      report.skippedClaims++;
      continue;
    }

    let totals;
    try {
      totals = recomputeLaytime(events, cpTerms).totals;
    } catch {
      report.skippedClaims++;
      continue;
    }

    const effects = computeClaimClauseEffects(events, cpTerms) ?? [];
    const netAmount = new Decimal(totals.demurrage_amount)
      .minus(totals.despatch_amount)
      .toDecimalPlaces(2)
      .toNumber();

    report.claims.push({
      claimId: claim.id,
      vessel: claim.vessel,
      voyageRef: claim.voyage_ref,
      port: claim.port,
      cpForm: cpTerms.cp_form ?? claim.cp_form ?? "GENCON94",
      daysBasis: cpTerms.days_basis,
      norVariant: cpTerms.nor_variant,
      currency: totals.currency,
      demurrage: totals.demurrage_amount,
      despatch: totals.despatch_amount,
      net: netAmount,
      settledAmount: claim.settled_amount ?? null,
      clauseEffects: effects,
    });

    for (const eff of effects) {
      const aggKey = `${eff.key}:${totals.currency}`;
      const agg = aggMap.get(aggKey) ?? {
        key: eff.key,
        label: eff.label,
        totalDelta: 0,
        claimCount: 0,
        currency: totals.currency,
      };
      agg.totalDelta = new Decimal(agg.totalDelta).plus(eff.deltaNet).toDecimalPlaces(2).toNumber();
      agg.claimCount++;
      // Generic label once multiple claims with differing parameters merge.
      if (agg.claimCount > 1) {
        agg.label = {
          days_basis: "Laytime exceptions (SHEX family) vs SHINC",
          turn_time: "Turn time concessions",
          weather: "Weather interruptions",
          shifting: "Shifting / berthing delays",
        }[eff.key] ?? eff.label;
      }
      aggMap.set(aggKey, agg);
    }

    const t = totalsMap.get(totals.currency) ?? {
      demurrage: new Decimal(0),
      despatch: new Decimal(0),
      settled: new Decimal(0),
      settledDemurrage: new Decimal(0),
      settledClaimCount: 0,
    };
    t.demurrage = t.demurrage.plus(totals.demurrage_amount);
    t.despatch = t.despatch.plus(totals.despatch_amount);
    if (claim.settled_amount != null && totals.demurrage_amount > 0) {
      t.settled = t.settled.plus(claim.settled_amount);
      t.settledDemurrage = t.settledDemurrage.plus(totals.demurrage_amount);
      t.settledClaimCount++;
    }
    totalsMap.set(totals.currency, t);
  }

  report.aggregates = [...aggMap.values()].sort(
    (a, b) => Math.abs(b.totalDelta) - Math.abs(a.totalDelta)
  );
  report.totalsByCurrency = [...totalsMap.entries()].map(([currency, t]) => ({
    currency,
    demurrage: t.demurrage.toDecimalPlaces(2).toNumber(),
    despatch: t.despatch.toDecimalPlaces(2).toNumber(),
    net: t.demurrage.minus(t.despatch).toDecimalPlaces(2).toNumber(),
    settled: t.settled.toDecimalPlaces(2).toNumber(),
    settledClaimCount: t.settledClaimCount,
    recoveryRate: t.settledDemurrage.gt(0)
      ? t.settled.div(t.settledDemurrage).toDecimalPlaces(4).toNumber()
      : null,
  }));

  return report;
}
