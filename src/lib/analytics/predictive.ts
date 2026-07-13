// Predictive analytics oracle — pure statistical math over historical
// voyage indices.
//
// Consolidates four forward-looking modules behind one pure surface:
//   * pre-fixture intelligence — replays proposed CP terms against the
//     observed voyage history at a port/month (the oracle_voyage_stats
//     matview) and prices the P50/P90 exposure;
//   * clause-swap hedging     — re-prices the same history under alternative
//     clause configurations and quantifies the swap ("reject SSHEX, push for
//     SHINC — expected saving $8,700");
//   * port resilience shock index — folds the port_honesty_and_resilience_index
//     matview (weather contradiction rate + congestion medians) into one
//     0–100 stress score;
//   * ROI onboarding calculator + early-warning ranking — reads a tenant's
//     raw claim book and maps historical leakage, time-bar exposure and
//     missed recoveries.
//
// Same discipline as the laytime engine and the pricing oracle it builds on:
// no I/O, no AI, no Supabase — all reads live in the API routes. Money
// aggregation runs through decimal.js. Every recommendation states the model
// it came from; the clause-basis multipliers below are documented heuristics,
// not engine reruns, and are only ever used to compare scenarios against
// each other on identical history.

import { Decimal } from "decimal.js";
import {
  MIN_SAMPLE_VOYAGES,
  percentile,
  type OracleVoyageStat,
} from "@/lib/oracle/pricing";
import type { DaysBasis } from "@/lib/laytime/types";

export { MIN_SAMPLE_VOYAGES };

// === Clause scenarios ===

// Share of counted laytime a days-basis clause excludes, as a fraction of
// SHINC-counted hours. Calendar-share heuristic: Sundays ≈ 1/7 (+ holiday
// allowance), Saturdays+Sundays ≈ 2/7; "unless used" (UU) halves the
// exclusion because worked excepted periods count; "even if used" (EIU)
// slightly widens it. Used ONLY to rank scenarios against each other on the
// same sample — never as an engine substitute.
export const DAYS_BASIS_EXCLUSION_SHARE: Record<DaysBasis, number> = {
  SHINC: 0,
  SHEX: 0.17,
  "SHEX-UU": 0.085,
  "WWDSHEX-EIU": 0.19,
  SSHEX: 0.29,
  "SSHEX-UU": 0.145,
  "WWDSSHEX-EIU": 0.31,
};

export interface ClauseScenario {
  label: string;
  daysBasis: DaysBasis;
  laytimeAllowedHours: number;
  demurrageRatePerDay: number;
  turnTimeHours: number;
}

export interface ScenarioResult {
  scenario: ClauseScenario;
  expectedLosses: number[]; // per historical voyage, ascending
  demurrageProbability: number;
  meanLoss: number;
  medianLoss: number;
  p90Loss: number;
  worstLoss: number;
}

const round2 = (x: Decimal | number) =>
  (x instanceof Decimal ? x : new Decimal(x)).toDecimalPlaces(2).toNumber();

// Replays every historical voyage under a hypothetical clause set. Sample
// used_hours are treated as SHINC-equivalent counted hours (that is what
// oracle_voyage_stats stores); the scenario then applies its exclusion share
// and turn time. Losses are the CHARTERER's demurrage cost — the owner's
// recovery — so perspective only matters when comparing scenarios.
export function evaluateClauseScenario(
  samples: OracleVoyageStat[],
  scenario: ClauseScenario
): ScenarioResult {
  const share = DAYS_BASIS_EXCLUSION_SHARE[scenario.daysBasis];
  const losses = samples
    .map((s) => {
      const counted = Decimal.max(
        new Decimal(s.usedHours).mul(1 - share).sub(scenario.turnTimeHours),
        0
      );
      const excess = Decimal.max(counted.sub(scenario.laytimeAllowedHours), 0);
      return round2(excess.div(24).mul(scenario.demurrageRatePerDay));
    })
    .sort((a, b) => a - b);

  const overCount = losses.filter((l) => l > 0).length;
  const meanLoss = losses.length
    ? round2(losses.reduce((acc, l) => acc.add(l), new Decimal(0)).div(losses.length))
    : 0;

  return {
    scenario,
    expectedLosses: losses,
    demurrageProbability: losses.length ? round2(overCount / losses.length) : 0,
    meanLoss,
    medianLoss: round2(percentile(losses, 0.5)),
    p90Loss: round2(percentile(losses, 0.9)),
    worstLoss: losses.length ? losses[losses.length - 1] : 0,
  };
}

// === Port resilience shock index ===

export interface PortResilienceSnapshot {
  portKey: string;
  month: number;
  // null when below the k-anonymity floor or never checked.
  weatherContradictionRate: number | null;
  weatherDecisiveChecks: number;
  medianCongestionDelayHours: number | null;
  p90CongestionDelayHours: number | null;
  voyagesObserved: number;
}

export type ShockBand = "resilient" | "moderate" | "strained" | "critical";

export interface ShockIndex {
  score: number | null; // 0 (calm, honest) … 100 (congested, contradicted)
  band: ShockBand | "insufficient_data";
  components: {
    congestionScore: number | null; // median normalized to a 72h saturation
    honestyScore: number | null; // contradiction rate, 0–1
  };
}

// 60% congestion / 40% honesty weighting: congestion moves money on every
// voyage, dishonest SoFs only on disputed ones. Median congestion saturates
// at 72h — beyond three days of queue the port is maximally stressed.
export const SHOCK_CONGESTION_SATURATION_HOURS = 72;

export function computeShockIndex(res: PortResilienceSnapshot | null): ShockIndex {
  const congestion =
    res?.medianCongestionDelayHours != null
      ? Math.min(Math.max(res.medianCongestionDelayHours, 0) / SHOCK_CONGESTION_SATURATION_HOURS, 1)
      : null;
  const honesty = res?.weatherContradictionRate ?? null;

  if (congestion === null && honesty === null) {
    return {
      score: null,
      band: "insufficient_data",
      components: { congestionScore: null, honestyScore: null },
    };
  }

  // A missing component redistributes its weight to the other one.
  const parts: Array<[number, number]> = [];
  if (congestion !== null) parts.push([congestion, 0.6]);
  if (honesty !== null) parts.push([honesty, 0.4]);
  const totalWeight = parts.reduce((a, [, w]) => a + w, 0);
  const score = round2(
    parts.reduce((a, [v, w]) => a + (v * w) / totalWeight, 0) * 100
  );

  const band: ShockBand =
    score < 25 ? "resilient" : score < 50 ? "moderate" : score < 75 ? "strained" : "critical";
  return { score, band, components: { congestionScore: congestion, honestyScore: honesty } };
}

// === Pre-fixture intelligence ===

export type Perspective = "charterer" | "owner";

export interface ClauseSwapAdvice {
  from: string;
  to: string;
  expectedSaving: number; // positive = the swap saves the caller money
  p90Before: number;
  p90After: number;
  advice: string;
}

export interface PreFixtureIntelligence {
  sampleSize: number;
  verifiedShare: number;
  proposed: ScenarioResult;
  alternatives: ScenarioResult[];
  clauseSwaps: ClauseSwapAdvice[]; // material swaps only, best first
  shockIndex: ShockIndex;
  recommendation: string;
}

export interface PreFixtureOptions {
  alternatives?: ClauseScenario[];
  resilience?: PortResilienceSnapshot | null;
  perspective?: Perspective;
  // Swaps moving less than this per voyage are noise, not negotiation points.
  materialityFloor?: number;
}

const fmtMoney = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

// Default counter-scenarios when the caller doesn't supply their own: the
// opposite days-basis family, a ±24h allowance move, and dropping turn time.
function defaultAlternatives(proposed: ClauseScenario): ClauseScenario[] {
  const alts: ClauseScenario[] = [];
  const swapBasis: DaysBasis = proposed.daysBasis === "SHINC" ? "SSHEX" : "SHINC";
  alts.push({ ...proposed, label: `${swapBasis} basis`, daysBasis: swapBasis });
  alts.push({
    ...proposed,
    label: `allowance +24h`,
    laytimeAllowedHours: proposed.laytimeAllowedHours + 24,
  });
  if (proposed.laytimeAllowedHours > 24) {
    alts.push({
      ...proposed,
      label: `allowance -24h`,
      laytimeAllowedHours: proposed.laytimeAllowedHours - 24,
    });
  }
  if (proposed.turnTimeHours > 0) {
    alts.push({ ...proposed, label: "no turn time", turnTimeHours: 0 });
  }
  return alts;
}

export function getPreFixtureIntelligence(
  samples: OracleVoyageStat[],
  proposed: ClauseScenario,
  opts: PreFixtureOptions = {}
): PreFixtureIntelligence {
  if (samples.length < MIN_SAMPLE_VOYAGES) throw new Error("INSUFFICIENT_DATA");
  const perspective = opts.perspective ?? "charterer";
  const materialityFloor = opts.materialityFloor ?? 500;

  const base = evaluateClauseScenario(samples, proposed);
  const alternatives = (opts.alternatives ?? defaultAlternatives(proposed)).map((s) =>
    evaluateClauseScenario(samples, s)
  );

  // Loss = charterer cost = owner revenue: a saving for one side is the
  // mirror image for the other.
  const sign = perspective === "charterer" ? 1 : -1;
  const clauseSwaps = alternatives
    .map((alt) => {
      const expectedSaving = round2((base.meanLoss - alt.meanLoss) * sign);
      return {
        from: proposed.label,
        to: alt.scenario.label,
        expectedSaving,
        p90Before: base.p90Loss,
        p90After: alt.p90Loss,
        advice:
          expectedSaving > 0
            ? `Clause Swap Advice: reject ${proposed.label}, push for ${alt.scenario.label} — expected saving ${fmtMoney(expectedSaving)} per voyage (P90 exposure ${fmtMoney(base.p90Loss)} → ${fmtMoney(alt.p90Loss)}).`
            : `Keep ${proposed.label} over ${alt.scenario.label} — the swap would cost ${fmtMoney(expectedSaving)} per voyage.`,
      };
    })
    .filter((s) => Math.abs(s.expectedSaving) >= materialityFloor)
    .sort((a, b) => b.expectedSaving - a.expectedSaving);

  const shockIndex = computeShockIndex(opts.resilience ?? null);

  const bestSwap = clauseSwaps.find((s) => s.expectedSaving > 0);
  const recommendation = bestSwap
    ? bestSwap.advice
    : `Proposed terms (${proposed.label}) are already the strongest configuration tested against ${samples.length} historical voyages.`;

  return {
    sampleSize: samples.length,
    verifiedShare: samples.length
      ? round2(samples.filter((s) => s.verified).length / samples.length)
      : 0,
    proposed: base,
    alternatives,
    clauseSwaps,
    shockIndex,
    recommendation,
  };
}

// === ROI onboarding calculator ===

export interface RoiClaimInput {
  id: string;
  demurrageAmount: number | null;
  settledAmount: number | null;
  settledAt: string | null;
  // Latest confirmed completion event — the time-bar anchor. Null = no anchor.
  completionAt: string | null;
  timeBarDays: number;
  hasCalculation: boolean;
}

export interface RoiSnapshot {
  claimCount: number;
  quantifiedClaimCount: number;
  totalClaimedValue: number;
  recoveredValue: number;
  recoveryRate: number | null; // over settled claims; null until one settles
  settledShortfall: number; // claimed − recovered on settled claims
  timeBarExpiredValue: number; // unsettled value past its deadline — gone
  atRiskValue: number; // unsettled value within the warning window
  unquantifiedClaimCount: number; // no calculation yet — invisible money
  estimatedLeakage: number; // expired + settled shortfall
  narrative: string;
}

const MS_PER_DAY = 24 * 3600_000;
const ROI_WARNING_DAYS = 21;

// Instant leakage map over a tenant's raw, unverified book — the PLG "here
// is what LayGrounded would have caught" number. Deliberately conservative:
// only counts money that is already quantified (a stored demurrage figure).
export function computeRoiSnapshot(claims: RoiClaimInput[], now: Date): RoiSnapshot {
  let claimed = new Decimal(0);
  let recovered = new Decimal(0);
  let settledClaimed = new Decimal(0);
  let expired = new Decimal(0);
  let atRisk = new Decimal(0);
  let quantified = 0;
  let unquantified = 0;
  let settledCount = 0;

  for (const c of claims) {
    if (!c.hasCalculation) unquantified++;
    const value = c.demurrageAmount != null && c.demurrageAmount > 0 ? c.demurrageAmount : 0;
    if (value > 0) quantified++;
    claimed = claimed.add(value);

    const isSettled = c.settledAt != null;
    if (isSettled) {
      settledCount++;
      settledClaimed = settledClaimed.add(value);
      recovered = recovered.add(c.settledAmount ?? 0);
      continue;
    }
    if (value > 0 && c.completionAt) {
      const deadline = new Date(c.completionAt).getTime() + c.timeBarDays * MS_PER_DAY;
      const daysRemaining = (deadline - now.getTime()) / MS_PER_DAY;
      if (daysRemaining < 0) expired = expired.add(value);
      else if (daysRemaining <= ROI_WARNING_DAYS) atRisk = atRisk.add(value);
    }
  }

  const shortfall = Decimal.max(settledClaimed.sub(recovered), 0);
  const leakage = expired.add(shortfall);
  const recoveryRate =
    settledCount > 0 && settledClaimed.gt(0)
      ? round2(recovered.div(settledClaimed))
      : null;

  const narrative =
    claims.length === 0
      ? "No claims on the book yet — upload a Statement of Facts or paste a fixture recap to start measuring."
      : `Across ${claims.length} claim(s): ${fmtMoney(round2(claimed))} quantified exposure, ` +
        `${fmtMoney(round2(expired))} already lost to time bars, ${fmtMoney(round2(atRisk))} at risk within ${ROI_WARNING_DAYS} days, ` +
        `${fmtMoney(round2(shortfall))} conceded in settlements` +
        (unquantified > 0
          ? `, and ${unquantified} claim(s) with no calculation — money nobody has counted.`
          : ".");

  return {
    claimCount: claims.length,
    quantifiedClaimCount: quantified,
    totalClaimedValue: round2(claimed),
    recoveredValue: round2(recovered),
    recoveryRate,
    settledShortfall: round2(shortfall),
    timeBarExpiredValue: round2(expired),
    atRiskValue: round2(atRisk),
    unquantifiedClaimCount: unquantified,
    estimatedLeakage: round2(leakage),
    narrative,
  };
}

// === Early-warning ranking ===

export interface EarlyWarningInput {
  id: string;
  vessel: string;
  voyageRef: string;
  demurrageAmount: number | null;
  daysToDeadline: number | null; // null = no completion anchor yet
  contradictedEvidenceCount: number;
  pendingProposalCount: number;
  settled: boolean;
}

export interface EarlyWarning {
  claimId: string;
  vessel: string;
  voyageRef: string;
  score: number; // 0–100
  reasons: string[];
}

// Deterministic risk scoring — the "AI-driven" early-warning feed is a
// transparent weighted rubric, so every alert can explain itself.
export function rankEarlyWarnings(inputs: EarlyWarningInput[]): EarlyWarning[] {
  const warnings: EarlyWarning[] = [];
  for (const c of inputs) {
    if (c.settled) continue;
    let score = 0;
    const reasons: string[] = [];

    if (c.daysToDeadline === null) {
      score += 10;
      reasons.push("No completion event confirmed — the time-bar clock is untracked.");
    } else if (c.daysToDeadline < 0) {
      score += 50;
      reasons.push("Time bar EXPIRED — recovery likely lost.");
    } else if (c.daysToDeadline <= 7) {
      score += 40;
      reasons.push(`Time bar in ${c.daysToDeadline} day(s).`);
    } else if (c.daysToDeadline <= 21) {
      score += 25;
      reasons.push(`Time bar in ${c.daysToDeadline} day(s).`);
    }

    if (c.contradictedEvidenceCount > 0) {
      score += Math.min(c.contradictedEvidenceCount * 15, 30);
      reasons.push(
        `${c.contradictedEvidenceCount} delay event(s) contradicted by independent evidence.`
      );
    }
    if (c.pendingProposalCount > 0) {
      score += Math.min(c.pendingProposalCount * 5, 15);
      reasons.push(`${c.pendingProposalCount} counterparty proposal(s) awaiting review.`);
    }
    const value = c.demurrageAmount ?? 0;
    if (value >= 100_000) {
      score += 15;
      reasons.push(`High-value claim (${fmtMoney(value)}).`);
    } else if (value >= 25_000) {
      score += 8;
    }

    if (score === 0) continue;
    warnings.push({
      claimId: c.id,
      vessel: c.vessel,
      voyageRef: c.voyageRef,
      score: Math.min(score, 100),
      reasons,
    });
  }
  return warnings.sort(
    (a, b) => b.score - a.score || (b.reasons.length - a.reasons.length)
  );
}

// === Facade ===
export class PredictiveOracle {
  getPreFixtureIntelligence = getPreFixtureIntelligence;
  evaluateClauseScenario = evaluateClauseScenario;
  computeShockIndex = computeShockIndex;
  computeRoiSnapshot = computeRoiSnapshot;
  rankEarlyWarnings = rankEarlyWarnings;
}
