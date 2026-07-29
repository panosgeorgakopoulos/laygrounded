// Settlement expectation model — what a claim of this shape actually settles for.
//
// LMAA awards are largely unpublished, so the industry negotiates blind: a desk
// deciding whether to accept 60% has no reference for whether 60% is good. The
// settled claims already in the book are a reference nobody else holds. This
// module turns them into "claims with this profile settle at X% of claimed, in
// Y days", with the sample size attached so the reader can judge it.
//
// Two disciplines, both borrowed from the modules that already do this well:
//
//   1. TIERED MATCHING, ALWAYS DISCLOSED. An exact feature match is best but
//      rarest, so the sample widens in defined steps until it is usable — and
//      the tier it settled on is part of the answer. An estimate from a
//      relaxed sample that presents itself as an exact one is worse than no
//      estimate (see `oracle/pricing.ts`, which does the same with cargo).
//   2. REFUSE RATHER THAN GUESS. Below the sample floor the answer is
//      `insufficient_data` with a reason, never a number computed from two
//      observations.
//
// Pure — the caller reads rows with the service-role client and passes them in.

import { percentile } from "@/lib/oracle/pricing";
import { MIN_COMPANIES, MIN_VOYAGES } from "@/lib/intel/congestion";

/** Settled claims required before any figure is reported on your own book. */
export const MIN_SAMPLE_SETTLEMENTS = 4;

/**
 * Distinct companies required before a sample that spans companies may be
 * reported. A cross-company figure drawn from two books lets either of them
 * difference out the other; same floor as the public index.
 */
export const MIN_SAMPLE_COMPANIES = MIN_COMPANIES;

/**
 * Market-side floors — deliberately the *same numbers* as the port congestion
 * index (`MIN_VOYAGES` / `MIN_COMPANIES`), imported rather than restated so the
 * two cannot drift apart. If the published index ever tightens, this tightens
 * with it.
 */
export const MIN_MARKET_SETTLEMENTS = MIN_VOYAGES;
export const MIN_MARKET_COMPANIES = MIN_COMPANIES;

/**
 * Evidence posture at the time of settlement. This is the single strongest
 * predictor in the data the product holds: a claim whose weather stoppages the
 * independent archive contradicts settles very differently from one it
 * corroborates, and that is precisely the thing a desk cannot see from its own
 * gut.
 */
export type EvidencePosture = "corroborated" | "contradicted" | "mixed" | "unverified";

export interface ClaimProfile {
  cpForm: string;
  daysBasis: string;
  evidencePosture: EvidencePosture;
  /** The counterparty formally proposed amendments — the claim was contested. */
  contested: boolean;
}

export interface SettlementObservation {
  /** Whose book this settlement came from. Used for the k-anonymity floor. */
  companyId: string;
  /** Owner's claimed position at the time — demurrage less despatch. Must be > 0. */
  claimedAmount: number;
  settledAmount: number;
  /** Calendar days from claim creation to settlement; null when unknown. */
  daysToSettle: number | null;
  profile: ClaimProfile;
}

/** How far the sample had to be widened to become usable. */
export type MatchTier = "exact" | "posture" | "form" | "all";

export interface Band {
  p25: number;
  median: number;
  p75: number;
}

/** Whose settlements the figure was drawn from. */
export type ExpectationScope = "own" | "market";

export interface SettlementExpectation {
  scope: ExpectationScope;
  verdict: "estimated" | "insufficient_data";
  tier: MatchTier | null;
  sampleSize: number;
  sampleCompanies: number;
  /** Settled ÷ claimed, as a percentage. 100 means the claim was paid in full. */
  recoveryPct: Band | null;
  daysToSettle: Band | null;
  /** Plain-language reading of the result, or of why there isn't one. */
  note: string;
  /** How the figure was produced — shown alongside it, never omitted. */
  methodology: string;
}

/** Your book and the market side by side. */
export interface SettlementExpectationPair {
  own: SettlementExpectation;
  /**
   * Null when market expectations are switched off. Distinct from a `market`
   * carrying `insufficient_data`, which means the feature is on and the sample
   * was too thin — the UI must not present "disabled" as "no data".
   */
  market: SettlementExpectation | null;
  /** Set when `market` is null, so the reason is never guessed at. */
  marketUnavailableReason: string | null;
}

const TIER_LABEL: Record<MatchTier, string> = {
  exact: "same CP form, laytime basis, evidence posture and contested status",
  posture: "same CP form and evidence posture",
  form: "same CP form",
  all: "all settled claims",
};

function matches(tier: MatchTier, a: ClaimProfile, b: ClaimProfile): boolean {
  switch (tier) {
    case "exact":
      return (
        a.cpForm === b.cpForm &&
        a.daysBasis === b.daysBasis &&
        a.evidencePosture === b.evidencePosture &&
        a.contested === b.contested
      );
    case "posture":
      return a.cpForm === b.cpForm && a.evidencePosture === b.evidencePosture;
    case "form":
      return a.cpForm === b.cpForm;
    case "all":
      return true;
  }
}

function band(values: number[]): Band | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    p25: r(percentile(sorted, 0.25)),
    median: r(percentile(sorted, 0.5)),
    p75: r(percentile(sorted, 0.75)),
  };
}

const TIER_ORDER: MatchTier[] = ["exact", "posture", "form", "all"];

interface SampleRule {
  scope: ExpectationScope;
  minSettlements: number;
  minCompanies: number;
  /**
   * When false the company floor applies only to samples that actually span
   * more than one company — the own-book case, where the floor would otherwise
   * block a desk from reading its own data.
   */
  alwaysEnforceCompanyFloor: boolean;
}

const OWN_RULE: SampleRule = {
  scope: "own",
  minSettlements: MIN_SAMPLE_SETTLEMENTS,
  minCompanies: MIN_SAMPLE_COMPANIES,
  alwaysEnforceCompanyFloor: false,
};

const MARKET_RULE: SampleRule = {
  scope: "market",
  minSettlements: MIN_MARKET_SETTLEMENTS,
  minCompanies: MIN_MARKET_COMPANIES,
  alwaysEnforceCompanyFloor: true,
};

function unusable(
  rule: SampleRule,
  sampleSize: number,
  sampleCompanies: number,
  note: string
): SettlementExpectation {
  return {
    scope: rule.scope,
    verdict: "insufficient_data",
    tier: null,
    sampleSize,
    sampleCompanies,
    recoveryPct: null,
    daysToSettle: null,
    note,
    methodology:
      rule.scope === "market"
        ? `Market figures require at least ${rule.minSettlements} settled claims from at least ` +
          `${rule.minCompanies} distinct companies, excluding your own. Same floors as the ` +
          `published port congestion index.`
        : `Requires at least ${rule.minSettlements} settled claims; samples spanning ` +
          `more than one company additionally require ${rule.minCompanies} distinct companies.`,
  };
}

function runExpectation(
  target: ClaimProfile,
  history: SettlementObservation[],
  rule: SampleRule
): SettlementExpectation {
  // A claim with nothing claimed has no ratio to speak of; excluded here rather
  // than producing an infinite or negative recovery percentage downstream.
  const usable = history.filter((h) => h.claimedAmount > 0 && h.settledAmount >= 0);

  for (const tier of TIER_ORDER) {
    const sample = usable.filter((h) => matches(tier, target, h.profile));
    if (sample.length < rule.minSettlements) continue;

    const companies = new Set(sample.map((s) => s.companyId));
    // The floor exists to stop one company's outcomes being inferred from an
    // aggregate. On the own-book path a single-company sample is that company
    // reading its own data, which the floor was never meant to prevent; on the
    // market path it is always enforced, because there the whole sample is
    // other people's data.
    const floorApplies = rule.alwaysEnforceCompanyFloor || companies.size > 1;
    if (floorApplies && companies.size < rule.minCompanies) continue;

    const recoveryPct = band(sample.map((s) => (s.settledAmount / s.claimedAmount) * 100));
    const dayValues = sample
      .map((s) => s.daysToSettle)
      .filter((d): d is number => d !== null && d >= 0);

    const median = recoveryPct?.median ?? 0;
    const days = band(dayValues);
    const daysNote = days ? `, typically in ${Math.round(days.median)} days` : "";
    const lead = rule.scope === "market" ? "Across the market, claims" : "Claims";

    return {
      scope: rule.scope,
      verdict: "estimated",
      tier,
      sampleSize: sample.length,
      sampleCompanies: companies.size,
      recoveryPct,
      daysToSettle: days,
      note:
        `${lead} like this settle at about ${median}% of the amount claimed${daysNote}. ` +
        `Based on ${sample.length} settled claim${sample.length === 1 ? "" : "s"} (${TIER_LABEL[tier]}).`,
      methodology:
        `Median of settled ÷ claimed across ${sample.length} settled claims matched on ` +
        `${TIER_LABEL[tier]}, drawn from ${companies.size} compan${companies.size === 1 ? "y" : "ies"}` +
        `${rule.scope === "market" ? " other than your own" : ""}. ` +
        `p25–p75 shown as the band. Claims with no claimed amount are excluded.` +
        (rule.scope === "market"
          ? ` Aggregates only — no individual company's settlements are identifiable, and the ` +
            `sample is withheld below ${rule.minSettlements} claims or ${rule.minCompanies} companies.`
          : ""),
    };
  }

  const total = usable.length;
  const companies = new Set(usable.map((s) => s.companyId)).size;
  const noun = rule.scope === "market" ? "market settlement history" : "settled claims";
  return unusable(
    rule,
    total,
    companies,
    total === 0
      ? `No ${noun} yet — an expectation needs settlement history to learn from.`
      : `Only ${total} settled claim${total === 1 ? "" : "s"} available${
          rule.scope === "market" ? ` from ${companies} compan${companies === 1 ? "y" : "ies"}` : ""
        }; at least ${rule.minSettlements} claim${rule.minSettlements === 1 ? "" : "s"}${
          rule.scope === "market" ? ` from ${rule.minCompanies} companies` : ""
        } are needed before a figure means anything.`
  );
}

/**
 * Expected settlement outcome from the caller's own settled claims.
 *
 * The k-anonymity floor applies only when more than one company is actually
 * represented, so a desk querying purely its own book is never blocked by a
 * rule meant to protect other people's data.
 */
export function expectSettlement(
  target: ClaimProfile,
  history: SettlementObservation[]
): SettlementExpectation {
  return runExpectation(target, history, OWN_RULE);
}

/**
 * Expected settlement outcome across the market.
 *
 * `viewerCompanyId` is **excluded from the sample here**, not trusted to the
 * caller's query. Two reasons: on a thin profile a desk would otherwise be
 * compared largely against itself and read as perfectly average whatever it
 * does, and the company floor is meant to count *other* contributors. The same
 * exclusion is enforced the same way in `intel/benchmark.ts`.
 *
 * The sample is keyed by claim SHAPE — CP form, laytime basis, evidence
 * posture, contested status — never by counterparty or any other party
 * identity, and only aggregates leave this function. That is what makes it a
 * different proposition from a per-named-entity score (see the header of
 * `intel/counterparty.ts`).
 */
export function expectMarketSettlement(
  target: ClaimProfile,
  history: SettlementObservation[],
  viewerCompanyId: string
): SettlementExpectation {
  return runExpectation(
    target,
    history.filter((h) => h.companyId !== viewerCompanyId),
    MARKET_RULE
  );
}

/**
 * Evidence posture from a claim's verification verdicts.
 *
 * `unverified` and `corroborated` are deliberately distinct: "we checked and
 * the archive agreed" is a materially stronger negotiating position than "we
 * never checked", and collapsing them would let an unchecked claim borrow the
 * settlement history of a verified one.
 */
export function postureFromVerdicts(verdicts: string[]): EvidencePosture {
  const decisive = verdicts.filter((v) => v === "corroborated" || v === "contradicted");
  if (decisive.length === 0) return "unverified";
  const contradicted = decisive.filter((v) => v === "contradicted").length;
  if (contradicted === 0) return "corroborated";
  if (contradicted === decisive.length) return "contradicted";
  return "mixed";
}
