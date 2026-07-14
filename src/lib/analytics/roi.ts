// ROI report: the three questions a new tenant asks on day one, answered by
// counterfactual runs of the deterministic engine over their existing book.
//
//   * Disputed weather   — demurrage the owner is losing to weather stoppages
//     that the ERA5 archive contradicts (evidence_checks verdict
//     'contradicted'). Each disputed window is struck individually — not all
//     weather on the claim — so the figure is the money actually attributable
//     to windows we can show didn't happen.
//   * SHEX vs SHINC      — what the days basis is worth on SHINC claims. See
//     the direction note on RoiBasisFinding: on an owner's book this is a
//     cost, not a saving.
//   * Time bar           — unsettled, quantified claims whose deadline is
//     inside the warning window, soonest first.
//
// Same discipline as the rest of the analytics layer: the compute half is
// pure and unit-tested; loadRoiReport owns the (batched) DB access. Every
// figure is an engine number — nothing here estimates.

import { Decimal } from "decimal.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import { findPairs } from "@/lib/laytime/sensitivity";
import { computeTimeBar, type TimeBarState } from "@/lib/time-bar";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";

export const ROI_WINDOW_MONTHS = 12;
// Sub-dollar deltas are engine noise, not findings.
const MATERIALITY = 1;

export interface RoiClaimInput {
  claimId: string;
  vessel: string;
  voyageRef: string;
  port: string;
  timeBarDays: number;
  cpTerms: CpTerms;
  // Confirmed (accepted/edited) events only — the same basis the engine and
  // the time bar use. A suggested event cannot anchor a legal deadline or a
  // money figure we show a customer.
  events: SofEventInput[];
  // sof_events ids of WEATHER_DELAY events whose evidence check came back
  // 'contradicted'.
  contradictedWeatherEventIds: string[];
  settledAt: string | null;
  hasSofDocument: boolean;
  hasCalculation: boolean;
}

export interface RoiWeatherFinding {
  claimId: string;
  vessel: string;
  voyageRef: string;
  port: string;
  currency: string;
  // Money the owner regains if the contradicted windows are struck out.
  recoverable: number;
  windowCount: number;
}

export interface RoiBasisFinding {
  claimId: string;
  vessel: string;
  voyageRef: string;
  port: string;
  currency: string;
  // SHEX net − SHINC net, owner's perspective. NEGATIVE on a typical owner's
  // book: SHEX excludes Sundays/holidays from laytime, so fewer hours count,
  // so less demurrage is earned. It is the charterer who saves. The sign is
  // preserved rather than abs()'d precisely so the UI cannot present a cost
  // as a saving.
  deltaNet: number;
}

export interface RoiTimeBarFinding {
  claimId: string;
  vessel: string;
  voyageRef: string;
  port: string;
  currency: string;
  deadline: string | null;
  daysRemaining: number | null;
  state: TimeBarState;
  // Null when the engine cannot price the claim. A deadline still matters
  // even when the money doesn't compute yet — see the loop in buildRoiReport.
  valueAtRisk: number | null;
  packComplete: boolean;
}

export interface CurrencyTotal {
  currency: string;
  amount: number;
}

export interface RoiReport {
  windowMonths: number;
  windowStart: string;
  generatedAt: string;
  disputedWeather: {
    totals: CurrencyTotal[];
    claimCount: number;
    findings: RoiWeatherFinding[];
  };
  basisSwap: {
    totals: CurrencyTotal[];
    claimCount: number;
    findings: RoiBasisFinding[];
  };
  timeBar: {
    totals: CurrencyTotal[];
    findings: RoiTimeBarFinding[];
  };
  // Claims the engine could not price (no events, bad terms, throwing terms).
  skippedClaims: number;
  // In the book but outside the 12-month window, or never completed — counted
  // so the headline can't quietly under-report by dropping them silently.
  outOfWindowClaims: number;
}

function netOf(events: SofEventInput[], cpTerms: CpTerms): Decimal | null {
  try {
    const r = recomputeLaytime(events, cpTerms);
    return new Decimal(r.totals.demurrage_amount).minus(r.totals.despatch_amount);
  } catch {
    return null;
  }
}

function money(d: Decimal): number {
  return d.toDecimalPlaces(2).toNumber();
}

// Latest confirmed completion — the same anchor the time bar uses, reused
// here to date a claim into (or out of) the 12-month window.
function completionAnchor(events: SofEventInput[]): Date | null {
  const completions = events
    .filter((e) => e.event_type === "COMPLETED_DISCHARGE" || e.event_type === "COMPLETED_LOADING")
    .map((e) => new Date(e.occurred_at))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return completions[completions.length - 1] ?? null;
}

function addTotal(totals: Map<string, Decimal>, currency: string, amount: Decimal): void {
  totals.set(currency, (totals.get(currency) ?? new Decimal(0)).plus(amount));
}

function toTotals(totals: Map<string, Decimal>): CurrencyTotal[] {
  return [...totals.entries()]
    .map(([currency, d]) => ({ currency, amount: money(d) }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

export function buildRoiReport(claims: RoiClaimInput[], now: Date): RoiReport {
  const windowStart = new Date(now);
  windowStart.setMonth(windowStart.getMonth() - ROI_WINDOW_MONTHS);

  const weatherFindings: RoiWeatherFinding[] = [];
  const basisFindings: RoiBasisFinding[] = [];
  const timeBarFindings: RoiTimeBarFinding[] = [];
  const weatherTotals = new Map<string, Decimal>();
  const basisTotals = new Map<string, Decimal>();
  const timeBarTotals = new Map<string, Decimal>();
  let skipped = 0;
  let outOfWindow = 0;

  for (const c of claims) {
    if (!c.cpTerms || c.events.length === 0) {
      skipped++;
      continue;
    }

    // One baseline run per claim, reused by every metric below — the
    // counterfactuals are the expensive part, so nothing recomputes it.
    // A claim the engine refuses (impossible terms, a voyage longer than its
    // iteration cap) is unpriceable, but NOT invisible: the time bar below
    // still runs, because "we can't compute this claim" is no reason to drop
    // it off the deadline queue. It is the likeliest one to be forgotten.
    let baselineTotals: ReturnType<typeof recomputeLaytime>["totals"] | null = null;
    try {
      baselineTotals = recomputeLaytime(c.events, c.cpTerms).totals;
    } catch {
      baselineTotals = null;
    }
    const currency = baselineTotals?.currency ?? c.cpTerms.currency ?? "USD";
    const isAsba = (c.cpTerms.cp_form ?? "GENCON94") === "ASBATANKVOY";

    // --- Metric 3: time bar (forward-looking; no window, never settled) ---
    if (!c.settledAt) {
      const tb = computeTimeBar({
        timeBarDays: c.timeBarDays,
        events: c.events,
        hasSofDocument: c.hasSofDocument,
        hasValidCpTerms: true,
        hasCalculation: c.hasCalculation,
        now,
      });
      if (tb.state === "warning" || tb.state === "critical") {
        timeBarFindings.push({
          claimId: c.claimId,
          vessel: c.vessel,
          voyageRef: c.voyageRef,
          port: c.port,
          currency,
          deadline: tb.deadline,
          daysRemaining: tb.daysRemaining,
          state: tb.state,
          valueAtRisk: baselineTotals?.demurrage_amount ?? null,
          packComplete: tb.complete,
        });
        if (baselineTotals) {
          addTotal(timeBarTotals, currency, new Decimal(baselineTotals.demurrage_amount));
        }
      }
    }

    // Metrics 1 and 2 are counterfactuals against a baseline; without one
    // there is nothing to compare to.
    if (!baselineTotals) {
      skipped++;
      continue;
    }
    const baseline = new Decimal(baselineTotals.demurrage_amount).minus(
      baselineTotals.despatch_amount
    );

    // --- Historical metrics are windowed on the completion anchor ---
    const anchor = completionAnchor(c.events);
    if (!anchor || anchor < windowStart || anchor > now) {
      outOfWindow++;
      continue;
    }

    // --- Metric 1: demurrage lost to contradicted weather ---
    if (c.contradictedWeatherEventIds.length > 0) {
      const disputed = new Set(c.contradictedWeatherEventIds);
      const strike = new Set<string>();
      let windowCount = 0;
      for (const pair of findPairs(c.events, "WEATHER_DELAY", "WEATHER_DELAY_END")) {
        if (!disputed.has(pair.startId)) continue;
        windowCount++;
        strike.add(pair.startId);
        if (pair.endId) strike.add(pair.endId);
      }
      if (windowCount > 0) {
        const cf = netOf(
          c.events.filter((e) => !strike.has(e.id)),
          c.cpTerms
        );
        if (cf !== null) {
          const recoverable = cf.minus(baseline);
          if (recoverable.abs().gte(MATERIALITY)) {
            weatherFindings.push({
              claimId: c.claimId,
              vessel: c.vessel,
              voyageRef: c.voyageRef,
              port: c.port,
              currency,
              recoverable: money(recoverable),
              windowCount,
            });
            addTotal(weatherTotals, currency, recoverable);
          }
        }
      }
    }

    // --- Metric 2: SHEX counterfactual on SHINC claims ---
    // Only SHINC claims can answer "what if SHEX instead?"; under Asbatankvoy
    // the days basis is inert (running hours), so the question is meaningless.
    if (!isAsba && c.cpTerms.days_basis === "SHINC") {
      const cf = netOf(c.events, { ...c.cpTerms, days_basis: "SHEX" });
      if (cf !== null) {
        const deltaNet = cf.minus(baseline);
        if (deltaNet.abs().gte(MATERIALITY)) {
          basisFindings.push({
            claimId: c.claimId,
            vessel: c.vessel,
            voyageRef: c.voyageRef,
            port: c.port,
            currency,
            deltaNet: money(deltaNet),
          });
          addTotal(basisTotals, currency, deltaNet);
        }
      }
    }
  }

  weatherFindings.sort((a, b) => Math.abs(b.recoverable) - Math.abs(a.recoverable));
  basisFindings.sort((a, b) => Math.abs(b.deltaNet) - Math.abs(a.deltaNet));
  // Soonest deadline first — this list is a queue, not a chart.
  timeBarFindings.sort((a, b) => (a.daysRemaining ?? 1e9) - (b.daysRemaining ?? 1e9));

  return {
    windowMonths: ROI_WINDOW_MONTHS,
    windowStart: windowStart.toISOString(),
    generatedAt: now.toISOString(),
    disputedWeather: {
      totals: toTotals(weatherTotals),
      claimCount: weatherFindings.length,
      findings: weatherFindings,
    },
    basisSwap: {
      totals: toTotals(basisTotals),
      claimCount: basisFindings.length,
      findings: basisFindings,
    },
    timeBar: { totals: toTotals(timeBarTotals), findings: timeBarFindings },
    skippedClaims: skipped,
    outOfWindowClaims: outOfWindow,
  };
}

// Loads a company's whole book in a fixed number of round trips (4), never
// per-claim: claims, their confirmed events, the contradicted weather checks,
// and which claims have a calculation. The engine runs are CPU-bound and
// unavoidable, but the DB access must not scale with the book.
export async function loadRoiReport(
  companyId: string,
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<RoiReport> {
  const { data: claims } = await supabase
    .from("claims")
    .select("id, vessel, voyage_ref, port, cp_terms, time_bar_days, settled_at")
    .eq("company_id", companyId);

  const claimRows = claims ?? [];
  if (claimRows.length === 0) return buildRoiReport([], now);
  const claimIds = claimRows.map((c) => c.id);

  const [eventsRes, evidenceRes, docsRes, calcsRes] = await Promise.all([
    supabase
      .from("sof_events")
      .select("id, claim_id, occurred_at, event_type")
      .in("claim_id", claimIds)
      .in("status", ["accepted", "edited"])
      .order("occurred_at", { ascending: true }),
    supabase
      .from("evidence_checks")
      .select("claim_id, event_id")
      .in("claim_id", claimIds)
      .eq("check_type", "weather")
      .eq("verdict", "contradicted"),
    supabase.from("documents").select("claim_id").in("claim_id", claimIds),
    supabase.from("laytime_calculations").select("claim_id").in("claim_id", claimIds),
  ]);

  const eventsByClaim = new Map<string, SofEventInput[]>();
  for (const e of eventsRes.data ?? []) {
    const list = eventsByClaim.get(e.claim_id) ?? [];
    list.push({ id: e.id, occurred_at: e.occurred_at, event_type: e.event_type });
    eventsByClaim.set(e.claim_id, list);
  }
  const contradictedByClaim = new Map<string, string[]>();
  for (const c of evidenceRes.data ?? []) {
    if (!c.event_id) continue;
    const list = contradictedByClaim.get(c.claim_id) ?? [];
    list.push(c.event_id);
    contradictedByClaim.set(c.claim_id, list);
  }
  const withDocs = new Set((docsRes.data ?? []).map((d) => d.claim_id));
  const withCalcs = new Set((calcsRes.data ?? []).map((c) => c.claim_id));

  return buildRoiReport(
    claimRows.map((c) => ({
      claimId: c.id,
      vessel: c.vessel,
      voyageRef: c.voyage_ref,
      port: c.port,
      timeBarDays: c.time_bar_days ?? 90,
      cpTerms: c.cp_terms as CpTerms,
      events: eventsByClaim.get(c.id) ?? [],
      contradictedWeatherEventIds: contradictedByClaim.get(c.id) ?? [],
      settledAt: c.settled_at ?? null,
      hasSofDocument: withDocs.has(c.id),
      hasCalculation: withCalcs.has(c.id),
    })),
    now
  );
}
