// Hinterland supply-chain notifications — the decision, kept pure.
//
// THE COMMERCIAL POINT. When a vessel is badly delayed, the trucks and trains
// booked against her original window are already rolling. They arrive, find no
// cargo, and the shipper pays road/rail demurrage on top of the marine claim.
// The marine delay is knowable days ahead of the hinterland one; telling the
// logistics provider early is the whole product.
//
// THE DISCIPLINE. A notification tells a third party to re-plan real assets, so
// a false positive costs a customer money just as a miss does. Two rules follow:
//
//   1. **Never fire on an estimate we do not have.** The trigger is the P90 of
//      the waiting-time distribution. Where that statistic is absent (rows
//      assessed before it was recorded) the answer is "cannot say", never the
//      mean — a mean wait of 10h routinely hides a P90 of 40h, and substituting
//      it would understate precisely the tail this exists to warn about.
//   2. **Never fire on a forecast that is not decision-grade.** `decisionGrade`
//      is already false when any input was mock or synthetic. Re-planning a
//      rail slot on synthetic congestion data is worse than not calling.

/** Default: a full day of delay is the point at which hinterland re-planning pays. */
export const DEFAULT_DELAY_THRESHOLD_HOURS = 24;

export const HINTERLAND_EVENTS = [
  "hinterland.delay_forecast",
  "hinterland.stoppage",
] as const;

export type HinterlandEvent = (typeof HINTERLAND_EVENTS)[number];

export function isHinterlandEvent(s: string): s is HinterlandEvent {
  return (HINTERLAND_EVENTS as readonly string[]).includes(s);
}

/** The stored risk row, reduced to what the decision needs. */
export interface RiskSnapshot {
  riskId: string;
  claimId: string | null;
  vessel: string;
  voyageRef: string | null;
  port: string;
  cargo: string | null;
  etaISO: string | null;
  decisionGrade: boolean;
  /** NULL when the assessment predates the statistic. Not substitutable. */
  p90WaitingHours: number | null;
  p90StoppageHours: number | null;
  demurrageProbability: number;
  p90Exposure: number | null;
  currency: string | null;
}

export type DelayDecision =
  | { fire: true; event: "hinterland.delay_forecast"; delayHours: number }
  | { fire: false; reason: "below_threshold" | "not_decision_grade" | "statistic_unavailable" };

/**
 * Should a forecast delay wake the hinterland?
 *
 * `thresholdHours` is per-subscription: a container terminal cares about 12h,
 * a bulk rail operator may not move below 48h.
 */
export function decideDelayNotification(
  risk: RiskSnapshot,
  thresholdHours: number = DEFAULT_DELAY_THRESHOLD_HOURS
): DelayDecision {
  // Ordered so the most informative reason wins. "We would not trust this
  // number ourselves" outranks "the number was small".
  if (!risk.decisionGrade) return { fire: false, reason: "not_decision_grade" };

  if (risk.p90WaitingHours === null || !Number.isFinite(risk.p90WaitingHours)) {
    return { fire: false, reason: "statistic_unavailable" };
  }

  // Stoppage (weather, strikes) delays the berth as surely as the queue does,
  // so the hinterland-relevant delay is the pair. They are both P90s of the
  // same trial set, so adding them is conservative rather than double-counting:
  // the true P90 of the sum is at most the sum of the P90s.
  const delayHours = risk.p90WaitingHours + (risk.p90StoppageHours ?? 0);

  if (delayHours < thresholdHours) return { fire: false, reason: "below_threshold" };
  return { fire: true, event: "hinterland.delay_forecast", delayHours };
}

/** A confirmed, already-happened stoppage on a live claim. */
export interface StoppageSnapshot {
  claimId: string;
  vessel: string;
  voyageRef: string | null;
  port: string;
  cargo: string | null;
  /** Total agreed excepted/stoppage hours in the current calculation. */
  stoppageHours: number;
  /** When the vessel is now expected to complete, if known. */
  revisedCompletionISO: string | null;
  currency: string | null;
  demurrageAmount: number | null;
}

export type StoppageDecision =
  | { fire: true; event: "hinterland.stoppage"; stoppageHours: number }
  | { fire: false; reason: "below_threshold" | "no_stoppage" };

export function decideStoppageNotification(
  claim: StoppageSnapshot,
  thresholdHours: number = DEFAULT_DELAY_THRESHOLD_HOURS
): StoppageDecision {
  if (!(claim.stoppageHours > 0)) return { fire: false, reason: "no_stoppage" };
  if (claim.stoppageHours < thresholdHours) return { fire: false, reason: "below_threshold" };
  return { fire: true, event: "hinterland.stoppage", stoppageHours: claim.stoppageHours };
}

// === Payloads ===
//
// Deliberately self-describing and flat. The reader is a logistics partner's
// integration engineer, not us: every field says its unit, every time is ISO
// 8601 with an offset, and `forecast` vs `observed` is explicit so nobody books
// a truck against a probability believing it is a fact.

export interface HinterlandDelayPayload {
  event: "hinterland.delay_forecast";
  basis: "forecast";
  riskId: string;
  claimId: string | null;
  vessel: string;
  voyageRef: string | null;
  port: string;
  cargo: string | null;
  etaISO: string | null;
  /** P90 — 1 in 10 voyages are worse than this, not the expected case. */
  delayHoursP90: number;
  thresholdHours: number;
  demurrageProbability: number;
  marineExposureP90: number | null;
  currency: string | null;
  firedAt: string;
  /**
   * Stated in the payload, not just in our docs. A partner acting on this is
   * committing assets, and "P90 of a Monte Carlo over ensemble weather" is a
   * materially different claim from "the vessel is late".
   */
  interpretation: string;
}

export interface HinterlandStoppagePayload {
  event: "hinterland.stoppage";
  basis: "observed";
  claimId: string;
  vessel: string;
  voyageRef: string | null;
  port: string;
  cargo: string | null;
  stoppageHours: number;
  thresholdHours: number;
  revisedCompletionISO: string | null;
  marineDemurrage: number | null;
  currency: string | null;
  firedAt: string;
  interpretation: string;
}

export function buildDelayPayload(
  risk: RiskSnapshot,
  delayHours: number,
  thresholdHours: number,
  firedAt: Date
): HinterlandDelayPayload {
  return {
    event: "hinterland.delay_forecast",
    basis: "forecast",
    riskId: risk.riskId,
    claimId: risk.claimId,
    vessel: risk.vessel,
    voyageRef: risk.voyageRef,
    port: risk.port,
    cargo: risk.cargo,
    etaISO: risk.etaISO,
    delayHoursP90: round2(delayHours),
    thresholdHours,
    demurrageProbability: risk.demurrageProbability,
    marineExposureP90: risk.p90Exposure,
    currency: risk.currency,
    firedAt: firedAt.toISOString(),
    interpretation:
      "P90 of simulated waiting plus stoppage time before the vessel completes " +
      "cargo operations. This is a forecast from a Monte Carlo over ensemble " +
      "weather and observed port congestion, not an observed delay: roughly 1 " +
      "voyage in 10 is expected to be worse than this figure.",
  };
}

export function buildStoppagePayload(
  claim: StoppageSnapshot,
  thresholdHours: number,
  firedAt: Date
): HinterlandStoppagePayload {
  return {
    event: "hinterland.stoppage",
    basis: "observed",
    claimId: claim.claimId,
    vessel: claim.vessel,
    voyageRef: claim.voyageRef,
    port: claim.port,
    cargo: claim.cargo,
    stoppageHours: round2(claim.stoppageHours),
    thresholdHours,
    revisedCompletionISO: claim.revisedCompletionISO,
    marineDemurrage: claim.demurrageAmount,
    currency: claim.currency,
    firedAt: firedAt.toISOString(),
    interpretation:
      "Excepted/stoppage time recorded against the confirmed statement of facts " +
      "and applied by the laytime engine. This is an observed interruption that " +
      "has already occurred, not a forecast.",
  };
}

/**
 * Per-subscription threshold, validated.
 *
 * A misconfigured `0` would notify on every voyage and train the partner to
 * ignore us, which is the expensive failure mode; a negative or non-finite
 * value is nonsense. Both fall back to the default rather than being obeyed.
 */
export function thresholdFor(config: unknown): number {
  const raw = (config as { hinterland_delay_threshold_hours?: unknown } | null)
    ?.hinterland_delay_threshold_hours;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DELAY_THRESHOLD_HOURS;
  return n;
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}
