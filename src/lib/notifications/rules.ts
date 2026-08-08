// Which domain events become notifications, for whom, and saying what.
//
// Pure: takes an event, returns a draft or null. No database, no clock, no
// randomness — so the interesting decisions (who gets told, and when we stay
// quiet) are unit-testable without a fixture tenant.
//
// ── ROUTED BY CAPABILITY, NOT BY ROLE NAME ─────────────────────────────────
//
// The obvious reading of "alert the finance manager" is to store `role:
// 'finance_manager'` and notify everyone holding it. That is wrong here in a
// way that is easy to miss: `admin` outranks `finance_manager` and can do
// everything they can, so a literal role match silently excludes the very
// people most likely to be watching — and in a small tenant, where the admin IS
// the finance manager, it would deliver the notification to nobody at all.
//
// So a rule names the CAPABILITY the reader would need to act, and recipients
// are everyone whose role clears it. That reuses the Phase 14 ladder rather
// than restating a parallel one, and it means adding a role between two
// existing ones routes correctly without touching this file. It is the same
// "middle-child gap" the min-role model avoids, seen from the delivery side.

import type { Capability } from "@/lib/auth/roles";
import { EVENT_TYPES, type DomainEvent } from "@/lib/events/outbox";

export const NOTIFICATION_KINDS = {
  /** The agents finished and produced a recommendation for a human. */
  NEGOTIATION_PROPOSED: "negotiation.settlement_proposed",
  /** A claim was agreed; its payment instruction is now generatable. */
  CLAIM_AGREED: "claim.agreed",
  /** A pre-arrival simulation whose tail is bad enough to plan around. */
  RISK_EXPOSURE: "risk.exposure_alert",
} as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS];

export type Severity = "info" | "action" | "urgent";

export interface NotificationDraft {
  kind: NotificationKind;
  /** Everyone whose role clears this capability receives it. */
  capability: Capability;
  severity: Severity;
  title: string;
  body: string;
  /** Where clicking it goes. */
  href: string;
  subjectType: "claim" | "pre_arrival_risk";
  subjectId: string;
  /**
   * Stable per (kind, source event). The outbox is at-least-once, so this is
   * what stops a redelivery becoming a second copy in someone's inbox.
   */
  dedupeKey: string;
}

/**
 * The P90 alert threshold: more likely than not to go on demurrage.
 *
 * A currency amount would have been the obvious knob and is the wrong one —
 * "$50,000 of exposure" means something different to a tenant running capesizes
 * than to one running coasters, and a fixed number would spam the second and
 * stay silent for the first. A probability is comparable across tenants and
 * across cargoes.
 */
export const DEMURRAGE_PROBABILITY_ALERT = 0.5;

/** Above this, the tail is bad enough that "when you get a chance" is wrong. */
export const DEMURRAGE_PROBABILITY_URGENT = 0.75;

function money(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "an unstated amount";
  const ccy = currency || "USD";
  return `${ccy} ${Math.round(amount).toLocaleString("en-US")}`;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/**
 * The notification an event should produce, or null for "say nothing".
 *
 * Returning null is the common case and the important one: most events in this
 * log are machine bookkeeping (`claim.recomputed` fires on every engine run),
 * and an inbox that receives all of them is one nobody reads — at which point
 * the notifications that DO matter are lost too.
 */
export function draftFor(event: DomainEvent): NotificationDraft | null {
  switch (event.eventType) {
    case EVENT_TYPES.NEGOTIATION_COMPLETED: {
      const p = event.payload as {
        claim_id?: string;
        recommended_settlement?: number | string | null;
        currency?: string | null;
        settlement_probability?: number | string | null;
        converged?: boolean | null;
      };
      const claimId = p.claim_id;
      if (!claimId) return null;

      // numeric columns arrive as strings over PostgREST; a Number() here keeps
      // the formatting from rendering "NaN" at someone.
      const recommended = p.recommended_settlement == null ? null : Number(p.recommended_settlement);
      const probability = p.settlement_probability == null ? null : Number(p.settlement_probability);

      return {
        kind: NOTIFICATION_KINDS.NEGOTIATION_PROPOSED,
        // The person who runs negotiations, not only the one who can settle.
        capability: "claim.write",
        severity: "action",
        title: "Negotiation agents proposed a settlement",
        body:
          `The agents recommend settling at ${money(recommended, p.currency)}` +
          (probability != null && Number.isFinite(probability)
            ? ` (${pct(probability)} settlement probability)`
            : "") +
          `${p.converged === false ? ", though a gap remains" : ""}. ` +
          "Nothing settles until a human reviews it.",
        href: `/claims/${claimId}/workspace`,
        subjectType: "claim",
        subjectId: claimId,
        dedupeKey: `${NOTIFICATION_KINDS.NEGOTIATION_PROPOSED}:${event.idempotencyKey}`,
      };
    }

    case EVENT_TYPES.SETTLEMENT_READY: {
      const claimId = (event.payload as { claim_id?: string }).claim_id ?? event.aggregateId;
      if (!claimId) return null;

      return {
        kind: NOTIFICATION_KINDS.CLAIM_AGREED,
        // Reviewing the escrow payload is a finance act, so this is addressed
        // to whoever can actually do something about it.
        capability: "claim.settle",
        severity: "action",
        title: "Claim agreed — settlement payload ready to review",
        body:
          "The figures are now fixed and a payment instruction has been generated. " +
          "Check the bank and wallet details on the payload before anything is released.",
        href: `/claims/${claimId}/workspace`,
        subjectType: "claim",
        subjectId: claimId,
        dedupeKey: `${NOTIFICATION_KINDS.CLAIM_AGREED}:${event.idempotencyKey}`,
      };
    }

    case EVENT_TYPES.RISK_ASSESSED: {
      const p = event.payload as {
        risk_id?: string;
        claim_id?: string | null;
        decision_grade?: boolean | null;
        demurrage_probability?: number | string | null;
        p90_exposure?: number | string | null;
        currency?: string | null;
      };

      // NOT DECISION-GRADE MEANS SILENCE, and this is the rule most worth
      // keeping. A simulation built on mock AIS or an unresolved congestion
      // source is explicitly not decision-grade (`provenance.ts` decides this in
      // one place), and telling someone to re-plan a voyage around a figure the
      // system itself will not stand behind is worse than telling them nothing.
      if (p.decision_grade !== true) return null;

      const probability =
        p.demurrage_probability == null ? null : Number(p.demurrage_probability);
      if (probability == null || !Number.isFinite(probability)) return null;
      if (probability < DEMURRAGE_PROBABILITY_ALERT) return null;

      const riskId = p.risk_id;
      if (!riskId) return null;

      const p90 = p.p90_exposure == null ? null : Number(p.p90_exposure);

      return {
        kind: NOTIFICATION_KINDS.RISK_EXPOSURE,
        capability: "claim.write",
        severity:
          probability >= DEMURRAGE_PROBABILITY_URGENT ? "urgent" : "action",
        title: "Pre-arrival risk: demurrage more likely than not",
        body:
          `This voyage carries a ${pct(probability)} chance of going on demurrage` +
          (p90 != null && Number.isFinite(p90)
            ? `, with a P90 exposure of ${money(p90, p.currency)}` +
              " — the tail, not the average."
            : ".") +
          " Worth re-checking the laycan and the berth queue.",
        // The risk lives on the simulator, which is where the distribution and
        // its inputs are; the claim page would show none of it.
        href: `/simulator/pre-arrival?risk=${riskId}`,
        subjectType: "pre_arrival_risk",
        subjectId: riskId,
        dedupeKey: `${NOTIFICATION_KINDS.RISK_EXPOSURE}:${event.idempotencyKey}`,
      };
    }

    default:
      // `claim.recomputed`, `settlement.changed` and anything added later are
      // deliberately silent until someone decides they warrant interrupting a
      // person. Defaulting to "notify" is how inboxes die.
      return null;
  }
}
