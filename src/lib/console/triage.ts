// Voyage console triage: turns the whole book into a ranked queue of actions.
//
// The dashboard answers "what claims do I have"; this answers "what should I do
// next, and what does ignoring it cost". Every other surface in the app is
// claim-scoped — you have to already know which claim needs attention before you
// can act on it. That is the wrong shape for daily operational use, and it is
// how time bars expire: nothing surfaces a deadline you were not already
// looking at.
//
// Pure, like the engine and time-bar modules — the caller assembles the facts
// from the database and this decides ordering. No I/O here.

import type { TimeBarStatus } from "@/lib/time-bar";

export type TriageReason =
  | "TIME_BAR_EXPIRING"
  | "TIME_BAR_EXPIRED"
  | "SHIELD_ALERT"
  | "PROPOSAL_PENDING"
  | "NO_CALCULATION"
  | "EVENTS_UNCONFIRMED"
  | "EVIDENCE_UNVERIFIED"
  | "SETTLEMENT_READY";

export type TriageSeverity = "critical" | "high" | "medium" | "low";

/** One claim's facts, as gathered by the caller. */
export interface TriageClaimInput {
  claimId: string;
  vessel: string;
  voyageRef: string;
  port: string;
  status: string;
  timeBar: TimeBarStatus | null;
  /** Owner's net position: demurrage − despatch. Negative = owed to charterer. */
  netAmount: number;
  currency: string;
  hasCalculation: boolean;
  /** Open (unresolved) voyage-shield alerts. */
  openAlerts: number;
  /** Counterparty amendments awaiting the owner's review. */
  pendingProposals: number;
  /** Extracted events still in `suggested` state. */
  suggestedEvents: number;
  /** Rows in evidence_checks for this claim. */
  evidenceChecks: number;
  settled: boolean;
}

export interface TriageAction {
  claimId: string;
  vessel: string;
  voyageRef: string;
  port: string;
  reason: TriageReason;
  severity: TriageSeverity;
  headline: string;
  detail: string;
  /** Money this action bears on, for display and for ranking within a tier. */
  amountAtStake: number;
  currency: string;
  href: string;
  score: number;
}

const SEVERITY_RANK: Record<TriageSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// Ranking is tiered, not a weighted sum: severity decides the band, money only
// orders within it. A weighted formula would let a large comfortable claim
// outrank a small one that is seven days from being time-barred — but the money
// on a big claim is still recoverable next week, and the barred one is gone
// forever. Irreversibility beats size.
const TIER = 1_000_000_000;

function scoreOf(severity: TriageSeverity, amount: number): number {
  const money = Math.min(Math.abs(amount), TIER - 1);
  return SEVERITY_RANK[severity] * TIER + money;
}

function money(amount: number, currency: string): string {
  return `${currency} ${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Every action a single claim currently warrants. One claim can produce several
 * (an expiring time bar AND an unreviewed proposal are two distinct pieces of
 * work), so the console shows work items, not claims.
 */
export function triageClaim(input: TriageClaimInput): TriageAction[] {
  // A settled claim is finished business — its time bar and its proposals no
  // longer represent work, and leaving it in the queue trains people to ignore
  // the queue.
  if (input.settled) return [];

  const actions: TriageAction[] = [];
  const base = {
    claimId: input.claimId,
    vessel: input.vessel,
    voyageRef: input.voyageRef,
    port: input.port,
    currency: input.currency,
    href: `/claims/${input.claimId}/workspace`,
  };

  const add = (
    reason: TriageReason,
    severity: TriageSeverity,
    headline: string,
    detail: string,
    amountAtStake = input.netAmount,
  ) => {
    actions.push({
      ...base,
      reason,
      severity,
      headline,
      detail,
      amountAtStake,
      score: scoreOf(severity, amountAtStake),
    });
  };

  const tb = input.timeBar;
  if (tb && tb.daysRemaining !== null) {
    if (tb.state === "critical") {
      add(
        "TIME_BAR_EXPIRING",
        "critical",
        `Time bar in ${tb.daysRemaining} day${tb.daysRemaining === 1 ? "" : "s"}`,
        tb.complete
          ? "Claim pack is complete — present it before the deadline."
          : `Claim pack incomplete: ${tb.completeness
              .filter((c) => !c.ok)
              .map((c) => c.label)
              .join(", ")}.`,
      );
    } else if (tb.state === "warning") {
      add(
        "TIME_BAR_EXPIRING",
        "high",
        `Time bar in ${tb.daysRemaining} days`,
        tb.complete
          ? "Pack is ready; present it."
          : "Complete the claim pack while there is still time.",
      );
    } else if (tb.state === "expired") {
      // Kept visible but ranked last: no action recovers it, yet a silently
      // vanishing claim is how a team never learns the deadline was missed.
      add(
        "TIME_BAR_EXPIRED",
        "low",
        "Time bar expired",
        "The contractual window has passed. Recovery now depends on the counterparty's agreement.",
      );
    }
  }

  if (input.openAlerts > 0) {
    add(
      "SHIELD_ALERT",
      "high",
      `${input.openAlerts} open Legal Shield alert${input.openAlerts === 1 ? "" : "s"}`,
      "Independent evidence contradicts a claimed delay. Review before this is presented.",
    );
  }

  if (input.pendingProposals > 0) {
    add(
      "PROPOSAL_PENDING",
      "high",
      `${input.pendingProposals} counterparty amendment${input.pendingProposals === 1 ? "" : "s"} awaiting review`,
      "The counterparty is blocked on your response.",
    );
  }

  if (input.suggestedEvents > 0) {
    add(
      "EVENTS_UNCONFIRMED",
      "medium",
      `${input.suggestedEvents} extracted event${input.suggestedEvents === 1 ? "" : "s"} unconfirmed`,
      "Unconfirmed events cannot anchor a time bar or support a calculation.",
    );
  }

  if (!input.hasCalculation) {
    add(
      "NO_CALCULATION",
      "medium",
      "No laytime calculation yet",
      "Events are in, but the claim has never been computed — its exposure is unknown.",
      0,
    );
  } else {
    if (input.evidenceChecks === 0 && input.netAmount > 0) {
      add(
        "EVIDENCE_UNVERIFIED",
        "low",
        "Claim never evidence-checked",
        `${money(input.netAmount, input.currency)} claimed with no independent weather or position verification.`,
      );
    }
    if (input.netAmount > 0 && input.status === "demurrage") {
      add(
        "SETTLEMENT_READY",
        "medium",
        `${money(input.netAmount, input.currency)} computed and uncollected`,
        "Calculated demurrage that has not been settled.",
      );
    }
  }

  return actions;
}

export interface TriageSummary {
  actions: TriageAction[];
  counts: Record<TriageSeverity, number>;
  /** Sum of net exposure across claims with at least one action, not per action. */
  totalAtStake: number;
  currency: string;
  claimsNeedingAction: number;
}

/**
 * Ranks the whole book. Ties break on claim id so the order is stable across
 * renders — a queue that reshuffles on refresh is unusable.
 */
export function triageBook(inputs: TriageClaimInput[]): TriageSummary {
  const actions = inputs
    .flatMap(triageClaim)
    .sort((a, b) => b.score - a.score || a.claimId.localeCompare(b.claimId));

  const counts: Record<TriageSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of actions) counts[a.severity]++;

  const claimsWithActions = new Set(actions.map((a) => a.claimId));
  // Exposure is summed per claim, never per action: one claim raising three
  // actions must not count its money three times.
  const totalAtStake = inputs
    .filter((c) => claimsWithActions.has(c.claimId) && c.netAmount > 0)
    .reduce((sum, c) => sum + c.netAmount, 0);

  return {
    actions,
    counts,
    totalAtStake,
    // Mixed-currency books would need conversion; the app is single-currency per
    // claim and overwhelmingly USD, so the majority currency labels the total.
    currency: majorityCurrency(inputs),
    claimsNeedingAction: claimsWithActions.size,
  };
}

function majorityCurrency(inputs: TriageClaimInput[]): string {
  const tally = new Map<string, number>();
  for (const c of inputs) tally.set(c.currency, (tally.get(c.currency) ?? 0) + 1);
  let best = "USD";
  let bestCount = -1;
  for (const [cur, count] of [...tally].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = cur;
      bestCount = count;
    }
  }
  return best;
}
