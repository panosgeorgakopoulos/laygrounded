// Protective notice automation.
//
// Demurrage claims die procedurally far more often than they die on the merits:
// the charterparty bars a claim not presented with its full supporting pack
// inside a fixed window, and a claim that misses the window is worth nothing
// regardless of how strong it was. `time-bar.ts` already computes the deadline
// and the pack checklist. This module decides, from that status alone, whether
// a protective notice is due — a letter served before expiry that preserves the
// claim while the missing documents are still being assembled.
//
// Pure. The caller supplies the time-bar status and what has already been
// filed; this returns a decision and the reason for it. No I/O, no clock —
// `computeTimeBar` has already resolved "now" into `daysRemaining`.

import type { TimeBarStatus } from "@/lib/time-bar";

export type NoticeVerdict =
  | "due" // serve one now
  | "not_yet" // deadline still comfortably far away
  | "already_filed" // a notice exists for this claim
  | "no_deadline" // no completion event, so no clock has started
  | "expired" // the bar has already passed — a notice cannot revive it
  | "settled"; // nothing left to preserve

export interface ProtectiveNoticeInput {
  timeBar: TimeBarStatus;
  /** A protective_notice draft already exists for this claim. */
  alreadyFiled: boolean;
  settled: boolean;
  /** Days before the deadline at which a notice becomes due. */
  leadDays?: number;
}

export interface ProtectiveNoticeDecision {
  verdict: NoticeVerdict;
  due: boolean;
  daysRemaining: number | null;
  deadline: string | null;
  /** Pack items still outstanding — what the notice must say is being assembled. */
  missing: string[];
  /** One line, suitable for the review queue summary. */
  reason: string;
}

/**
 * Default lead time. Long enough that a notice still has commercial effect and
 * a human has time to review it before service; short enough that it is not
 * crying wolf on every claim in the book. Deliberately longer than the
 * time-bar module's own `critical` band (7 days) — by the time a claim is
 * critical, drafting a notice is already late.
 */
export const DEFAULT_NOTICE_LEAD_DAYS = 14;

export function evaluateProtectiveNotice(
  input: ProtectiveNoticeInput
): ProtectiveNoticeDecision {
  const { timeBar } = input;
  const leadDays = input.leadDays ?? DEFAULT_NOTICE_LEAD_DAYS;
  const missing = timeBar.completeness.filter((c) => !c.ok).map((c) => c.label);

  const base = {
    daysRemaining: timeBar.daysRemaining,
    deadline: timeBar.deadline,
    missing,
  };

  if (input.settled) {
    return { ...base, verdict: "settled", due: false, reason: "Claim is settled." };
  }

  // Checked before the deadline itself: a claim whose notice is already on file
  // needs no second one, whatever the clock says.
  if (input.alreadyFiled) {
    return {
      ...base,
      verdict: "already_filed",
      due: false,
      reason: "A protective notice has already been drafted for this claim.",
    };
  }

  if (timeBar.state === "no_anchor" || timeBar.daysRemaining === null) {
    return {
      ...base,
      verdict: "no_deadline",
      due: false,
      reason: "No confirmed completion event, so the time-bar clock has not started.",
    };
  }

  // An expired bar is not a reason to send a letter. Serving a protective
  // notice after the deadline does not revive the claim, and a letter that
  // implies otherwise is worse than silence — it puts a false position in
  // writing. The claim still shows as expired on the console; this module just
  // refuses to paper over it.
  if (timeBar.daysRemaining < 0) {
    return {
      ...base,
      verdict: "expired",
      due: false,
      reason: `Time bar expired ${Math.abs(timeBar.daysRemaining)} day(s) ago; a notice cannot revive it.`,
    };
  }

  if (timeBar.daysRemaining > leadDays) {
    return {
      ...base,
      verdict: "not_yet",
      due: false,
      reason: `${timeBar.daysRemaining} days remain — inside the ${leadDays}-day notice window nothing is due yet.`,
    };
  }

  const packNote =
    missing.length === 0
      ? "the claim pack is complete"
      : `outstanding: ${missing.join("; ")}`;
  return {
    ...base,
    verdict: "due",
    due: true,
    reason: `Time bar in ${timeBar.daysRemaining} day(s) — ${packNote}.`,
  };
}
