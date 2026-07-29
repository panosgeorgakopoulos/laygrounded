// Pre-fixture CP risk analysis.
//
// Every other surface in this product answers "what did this voyage cost".
// This one answers "what will these terms cost, before you sign them", which is
// the only moment the answer can still change anything.
//
// Two rules shape the output:
//
//   1. A RISK WITHOUT A PRICE IS AN OPINION. "SHINC is riskier than SHEX" is
//      something any broker already knows. "SHINC on this route in December
//      carries an expected USD 8,700 more exposure than SHEX" is a negotiating
//      position. So every risk that CAN be priced is priced, by replaying the
//      same historical voyages through the same scenario evaluator the clause
//      P&L analytics already use — not by new maths invented here.
//   2. AN UNPRICEABLE RISK SAYS SO. With no historical sample for the route, a
//      risk is still reported, with `expectedCost: null` and the reason. It is
//      never given a made-up number, and never silently dropped either — some
//      of the sharpest findings (a missing weather exception, an absent
//      demurrage rate) are structural and do not need a sample at all.
//
// Pure. The caller supplies the terms and whatever historical sample it has.

import type { CpTerms, DaysBasis } from "@/lib/laytime/types";
import { evaluateClauseScenario, type ClauseScenario } from "@/lib/analytics/predictive";
import type { OracleVoyageStat } from "@/lib/oracle/pricing";

export type RiskSeverity = "critical" | "high" | "medium" | "low";

/** Whose side the risk falls on. A CP is a two-sided document. */
export type Exposure = "owner" | "charterer";

export interface CpRisk {
  key: string;
  severity: RiskSeverity;
  /** One line an operator can act on. */
  headline: string;
  /** Why this matters, in contract terms. */
  detail: string;
  exposure: Exposure;
  /**
   * Expected money at stake per voyage, in the CP's currency. Null when the
   * risk is structural or when no historical sample supports a figure —
   * `costBasis` then says which.
   */
  expectedCost: number | null;
  costBasis: string;
  /** What to ask for instead. */
  recommendation: string;
  /** Knowledge-graph anchor, when the engine has a matching clause reference. */
  clauseRef: string | null;
}

export interface CpRiskInput {
  terms: CpTerms;
  /**
   * Historical voyages for the intended route, from `oracle_voyage_stats`.
   * Empty is normal and must not break the analysis — it only removes the
   * priced risks.
   */
  samples: OracleVoyageStat[];
  /** Fields the extractor could not find, so absence can be distinguished from a default. */
  missingFields?: string[];
}

export interface CpRiskReport {
  risks: CpRisk[];
  /** Sum of every priced risk. Null when nothing could be priced. */
  totalExpectedCost: number | null;
  currency: string;
  sampleSize: number;
  /** Stated plainly so a caller never mistakes a thin analysis for a clean one. */
  limitations: string[];
}

/** Below this a scenario comparison is noise rather than signal. */
export const MIN_PRICING_SAMPLE = 5;

/** Money difference below which a clause swap is not worth raising. */
const MATERIALITY_THRESHOLD = 250;

const SEVERITY_RANK: Record<RiskSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function scenarioFrom(terms: CpTerms, override: Partial<ClauseScenario> = {}): ClauseScenario {
  return {
    label: override.label ?? "proposed",
    daysBasis: override.daysBasis ?? terms.days_basis,
    laytimeAllowedHours: override.laytimeAllowedHours ?? terms.laytime_allowed_hours,
    demurrageRatePerDay: override.demurrageRatePerDay ?? terms.demurrage_rate,
    turnTimeHours: override.turnTimeHours ?? terms.turn_time_hours,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Prices one clause swap: the proposed terms against a counterfactual differing
 * in exactly one respect. The delta is the charterer's extra expected cost, so
 * a positive number always means "the proposed term is worse for the charterer"
 * whichever direction the swap runs.
 */
function priceSwap(
  terms: CpTerms,
  samples: OracleVoyageStat[],
  alternative: Partial<ClauseScenario>
): number | null {
  if (samples.length < MIN_PRICING_SAMPLE) return null;
  const proposed = evaluateClauseScenario(samples, scenarioFrom(terms));
  const counter = evaluateClauseScenario(samples, scenarioFrom(terms, alternative));
  return round2(proposed.meanLoss - counter.meanLoss);
}

/** Days bases that exclude weather time. Everything else runs through it. */
const WEATHER_EXCLUDING: DaysBasis[] = ["WWDSHEX-EIU", "WWDSSHEX-EIU"];

/** A safer counterpart for each basis, for the swap pricing. */
const SAFER_BASIS: Partial<Record<DaysBasis, DaysBasis>> = {
  SHINC: "SHEX",
  SHEX: "WWDSHEX-EIU",
  "SHEX-UU": "WWDSHEX-EIU",
  SSHEX: "WWDSSHEX-EIU",
  "SSHEX-UU": "WWDSSHEX-EIU",
};

export function analyzeCpRisk(input: CpRiskInput): CpRiskReport {
  const { terms, samples } = input;
  const missing = new Set(input.missingFields ?? []);
  const risks: CpRisk[] = [];
  const limitations: string[] = [];
  const priceable = samples.length >= MIN_PRICING_SAMPLE;

  if (!priceable) {
    limitations.push(
      samples.length === 0
        ? "No historical voyages for this route, so no risk could be priced. Structural findings below still apply."
        : `Only ${samples.length} historical voyage${samples.length === 1 ? "" : "s"} for this route; at least ${MIN_PRICING_SAMPLE} are needed to price a clause swap.`
    );
  }

  // --- Laytime basis ---
  const safer = SAFER_BASIS[terms.days_basis];
  if (safer) {
    const cost = priceSwap(terms, samples, { daysBasis: safer });
    if (cost === null || cost >= MATERIALITY_THRESHOLD) {
      risks.push({
        key: "days_basis",
        severity: terms.days_basis === "SHINC" ? "high" : "medium",
        headline:
          terms.days_basis === "SHINC"
            ? "Laytime runs on Sundays and holidays (SHINC)"
            : `Laytime basis ${terms.days_basis} counts weather time`,
        detail:
          terms.days_basis === "SHINC"
            ? "Under SHINC every hour counts, including weekends and public holidays. On a congested or holiday-heavy port this is the single largest driver of demurrage exposure."
            : `${terms.days_basis} does not exclude weather working time, so a stoppage the master could not avoid still consumes laytime.`,
        exposure: "charterer",
        expectedCost: cost,
        costBasis:
          cost === null
            ? "Not priced — insufficient historical voyages for this route."
            : `Expected extra cost per voyage versus ${safer}, across ${samples.length} historical voyages.`,
        recommendation: `Push for ${safer}.`,
        clauseRef: "GENCON94-6",
      });
    }
  }

  // --- Turn time ---
  if (terms.turn_time_hours <= 0) {
    risks.push({
      key: "no_turn_time",
      severity: "high",
      headline: "No turn time — laytime starts immediately on NOR",
      detail:
        "Without turn time, laytime commences the moment a valid NOR is tendered, with no allowance for the vessel to berth. Standard practice is 6 hours (12 on some trades).",
      exposure: "charterer",
      expectedCost: priceSwap(terms, samples, { turnTimeHours: 6 }),
      costBasis: priceable
        ? `Expected extra cost per voyage versus a 6-hour turn time, across ${samples.length} historical voyages.`
        : "Not priced — insufficient historical voyages for this route.",
      recommendation: "Ask for 6 hours' turn time.",
      clauseRef: "GENCON94-6",
    });
  }

  // --- Weather protection ---
  if (!WEATHER_EXCLUDING.includes(terms.days_basis)) {
    risks.push({
      key: "no_weather_exception",
      severity: "high",
      headline: "No weather working exception",
      detail:
        "Laytime runs through weather stoppages the vessel cannot work in. This is structural: it does not depend on the route's history, and it is the exception that independent archive verification is best able to defend later.",
      exposure: "charterer",
      // Deliberately unpriced even when a sample exists: the swap to a WWD
      // basis is already priced by the days_basis risk above, and reporting the
      // same money under two headings would double-count the total.
      expectedCost: null,
      costBasis: "Structural finding — the monetary effect is priced under the laytime basis risk.",
      recommendation: "Ask for a weather working days basis (WWDSHEX-EIU or WWDSSHEX-EIU).",
      clauseRef: "GENCON94-6c",
    });
  }

  // --- Demurrage rate ---
  if (terms.demurrage_rate <= 0) {
    risks.push({
      key: "no_demurrage_rate",
      severity: "critical",
      headline: "No demurrage rate agreed",
      detail:
        "With no rate in the charterparty, detention is argued at large rather than computed. This is the one finding that makes every other number on this page unquantifiable.",
      exposure: "owner",
      expectedCost: null,
      costBasis: "Cannot be priced — there is no rate to price with.",
      recommendation: "Agree an explicit demurrage rate per day before fixing.",
      clauseRef: "GENCON94-8",
    });
  } else if (terms.despatch_rate > terms.demurrage_rate) {
    risks.push({
      key: "despatch_exceeds_demurrage",
      severity: "medium",
      headline: "Despatch rate exceeds the demurrage rate",
      detail:
        "Despatch is conventionally half demurrage. A despatch rate above the demurrage rate means time saved pays the charterer more than time lost costs them, which is almost always a drafting error rather than an intention.",
      exposure: "owner",
      expectedCost: null,
      costBasis: "Structural finding — depends on how the voyage runs, not on the route's history.",
      recommendation: "Confirm despatch is intended, conventionally at half the demurrage rate.",
      clauseRef: "GENCON94-8",
    });
  }

  // --- Laytime allowance against what the port actually takes ---
  if (priceable && terms.laytime_allowed_hours > 0) {
    const used = samples.map((s) => s.usedHours).sort((a, b) => a - b);
    const medianUsed = used[Math.floor(used.length / 2)];
    if (medianUsed > terms.laytime_allowed_hours) {
      const shortfall = round2(medianUsed - terms.laytime_allowed_hours);
      risks.push({
        key: "allowance_below_history",
        severity: "critical",
        headline: `Laytime allowance is below what this route historically takes`,
        detail:
          `The allowance is ${terms.laytime_allowed_hours}h, but the median voyage on this route has used ${round2(medianUsed)}h — a shortfall of ${shortfall}h before anything goes wrong. On these terms the typical voyage goes on demurrage.`,
        exposure: "charterer",
        expectedCost: priceSwap(terms, samples, { laytimeAllowedHours: medianUsed }),
        costBasis: `Expected cost per voyage of the ${shortfall}h shortfall, across ${samples.length} historical voyages.`,
        recommendation: `Ask for at least ${Math.ceil(medianUsed)}h.`,
        clauseRef: "GENCON94-6",
      });
    }
  }

  // --- Terms the extractor never found ---
  // Reported separately from the risks above: "the contract says X and X is
  // dangerous" and "we could not find X at all" are different problems, and
  // conflating them would let a parsing gap masquerade as a contractual one.
  for (const field of missing) {
    risks.push({
      key: `missing_${field}`,
      severity: "medium",
      headline: `${field.replace(/_/g, " ")} not found in the document`,
      detail:
        "This term could not be located, so the analysis fell back to a default. Any figure that depends on it is indicative only.",
      exposure: "owner",
      expectedCost: null,
      costBasis: "Not priced — the term is unknown.",
      recommendation: `Confirm ${field.replace(/_/g, " ")} explicitly in the fixture.`,
      clauseRef: null,
    });
  }

  risks.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return (b.expectedCost ?? 0) - (a.expectedCost ?? 0);
  });

  const priced = risks.map((r) => r.expectedCost).filter((c): c is number => c !== null);
  const totalExpectedCost = priced.length
    ? round2(priced.reduce((a, b) => a + b, 0))
    : null;

  if (risks.some((r) => r.expectedCost === null) && totalExpectedCost !== null) {
    limitations.push(
      "The total covers priced risks only; structural findings above it carry no figure."
    );
  }

  return {
    risks,
    totalExpectedCost,
    currency: terms.currency,
    sampleSize: samples.length,
    limitations,
  };
}
