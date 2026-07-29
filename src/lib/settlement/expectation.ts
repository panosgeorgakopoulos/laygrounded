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
import { MIN_COMPANIES } from "@/lib/intel/congestion";

/** Settled claims required before any figure is reported. */
export const MIN_SAMPLE_SETTLEMENTS = 4;

/**
 * Distinct companies required before a sample that spans companies may be
 * reported. A cross-company figure drawn from two books lets either of them
 * difference out the other; same floor as the public index.
 */
export const MIN_SAMPLE_COMPANIES = MIN_COMPANIES;

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

export interface SettlementExpectation {
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

function unusable(sampleSize: number, sampleCompanies: number, note: string): SettlementExpectation {
  return {
    verdict: "insufficient_data",
    tier: null,
    sampleSize,
    sampleCompanies,
    recoveryPct: null,
    daysToSettle: null,
    note,
    methodology:
      `Requires at least ${MIN_SAMPLE_SETTLEMENTS} settled claims; samples spanning ` +
      `more than one company additionally require ${MIN_SAMPLE_COMPANIES} distinct companies.`,
  };
}

const TIER_ORDER: MatchTier[] = ["exact", "posture", "form", "all"];

/**
 * Expected settlement outcome for a claim with `target`'s profile.
 *
 * `history` may be the caller's own settled claims, a cross-company sample, or
 * both — the k-anonymity floor applies only when more than one company is
 * actually represented in the chosen sample, so a desk querying purely its own
 * book is never blocked by a rule meant to protect other people's data.
 */
export function expectSettlement(
  target: ClaimProfile,
  history: SettlementObservation[]
): SettlementExpectation {
  // A claim with nothing claimed has no ratio to speak of; excluded here rather
  // than producing an infinite or negative recovery percentage downstream.
  const usable = history.filter((h) => h.claimedAmount > 0 && h.settledAmount >= 0);

  for (const tier of TIER_ORDER) {
    const sample = usable.filter((h) => matches(tier, target, h.profile));
    if (sample.length < MIN_SAMPLE_SETTLEMENTS) continue;

    const companies = new Set(sample.map((s) => s.companyId));
    // The floor exists to stop one company's outcomes being inferred from an
    // aggregate. A single-company sample is that company reading its own data,
    // which the floor was never meant to prevent.
    if (companies.size > 1 && companies.size < MIN_SAMPLE_COMPANIES) continue;

    const recoveryPct = band(
      sample.map((s) => (s.settledAmount / s.claimedAmount) * 100)
    );
    const dayValues = sample
      .map((s) => s.daysToSettle)
      .filter((d): d is number => d !== null && d >= 0);

    const median = recoveryPct?.median ?? 0;
    const days = band(dayValues);
    const daysNote = days ? `, typically in ${Math.round(days.median)} days` : "";

    return {
      verdict: "estimated",
      tier,
      sampleSize: sample.length,
      sampleCompanies: companies.size,
      recoveryPct,
      daysToSettle: days,
      note:
        `Claims like this settle at about ${median}% of the amount claimed${daysNote}. ` +
        `Based on ${sample.length} settled claim${sample.length === 1 ? "" : "s"} (${TIER_LABEL[tier]}).`,
      methodology:
        `Median of settled ÷ claimed across ${sample.length} settled claims matched on ` +
        `${TIER_LABEL[tier]}, drawn from ${companies.size} compan${companies.size === 1 ? "y" : "ies"}. ` +
        `p25–p75 shown as the band. Claims with no claimed amount are excluded.`,
    };
  }

  const total = usable.length;
  const companies = new Set(usable.map((s) => s.companyId)).size;
  return unusable(
    total,
    companies,
    total === 0
      ? "No settled claims yet — an expectation needs settlement history to learn from."
      : `Only ${total} settled claim${total === 1 ? "" : "s"} available; at least ${MIN_SAMPLE_SETTLEMENTS} are needed before a figure means anything.`
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
