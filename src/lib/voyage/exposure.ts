// Live demurrage meter: running laytime exposure for a voyage still in progress.
//
// Every other calculation surface in this app is retrospective — it answers
// "what did this voyage cost" once the cargo operation has completed. That is
// the wrong question while the ship is still working: by the time the number is
// knowable, every decision that could have changed it has already been made.
// This module answers "where do we stand right now, and when does laytime run
// out", which is the number an operator can still act on.
//
// The whole thing rests on one observation about the engine: `recomputeLaytime`
// derives its operational window end from the last COMPLETED_LOADING /
// COMPLETED_DISCHARGE event, falling back to a flat 72h after commencement when
// no completion exists. So "used laytime as of time T" is exactly the engine's
// own answer for an event set whose operations completed at T. We therefore
// append a *synthetic* completion event at the cut-off and run the real engine,
// rather than re-implementing laytime accrual here. Two implementations of the
// counting rules would eventually disagree, and the disagreement would surface
// as a customer arguing with their own dashboard.
//
// That equivalence is exact, not approximate, including under `-UU` bases:
// `getOperationsIntervals` already closes an unpaired operation at `windowEnd`,
// so closing it explicitly at the same instant changes nothing.
//
// Pure, like the engine, time-bar and triage modules. `now` is injected — this
// file never reads a clock, which is what makes the projections testable and
// the sweep reproducible.

import { recomputeLaytime, NoNorError } from "@/lib/laytime/gencon94";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";
import Decimal from "decimal.js";

/** Event types that terminate the operational window. */
const COMPLETION_EVENTS = ["COMPLETED_LOADING", "COMPLETED_DISCHARGE"] as const;

export type ExposureState =
  | "not_started" // no NOR tendered yet — laytime cannot have begun
  | "laytime_running" // within the allowance
  | "demurrage_accruing" // allowance exhausted, clock costing money
  | "completed"; // a real completion event exists — use the stored calculation

export interface ExposureInput {
  /** Confirmed events so far. A live voyage's set is legitimately incomplete. */
  events: SofEventInput[];
  terms: CpTerms;
  /** ISO 8601. Injected — this module never reads a clock. */
  now: string;
  /**
   * Optional projected completion, e.g. an AIS-derived ETA plus an expected
   * cargo-operation duration. Absent means no projection is offered; we do not
   * invent one, because a made-up completion time produces a made-up liability.
   */
  projectedCompletionAt?: string | null;
}

export interface ExposureProjection {
  projectedCompletionAt: string;
  projectedUsedHours: number;
  projectedDemurrageHours: number;
  projectedDemurrage: number;
  projectedDespatch: number;
  /** Owner's perspective: demurrage − despatch. */
  projectedNet: number;
}

export interface ExposureSnapshot {
  state: ExposureState;
  /** The instant this snapshot describes (echoes `now`). */
  asOf: string;
  allowedHours: number;
  /** Laytime consumed as of `asOf`, per the engine's counting rules. */
  usedHours: number;
  /** Allowance remaining, floored at zero. */
  remainingHours: number;
  /** 0–100+; exceeds 100 once on demurrage. */
  percentConsumed: number;
  /** Hours already on demurrage as of `asOf`. */
  onDemurrageHours: number;
  /** Demurrage accrued so far — money already exposed, not a forecast. */
  accruedDemurrage: number;
  currency: string;
  /**
   * When the allowance will be exhausted, if it has not been already. Found by
   * bisecting the engine itself rather than extrapolating a rate, because the
   * accrual rate is not constant — SHEX weekends, excepted periods and weather
   * all stop the clock, so a linear projection would be wrong by exactly the
   * amount that matters.
   */
  laytimeExhaustedAt: string | null;
  projection: ExposureProjection | null;
  /** Set when no snapshot could be computed; `state` is then "not_started". */
  unavailableReason: string | null;
}

const MS_PER_HOUR = 3_600_000;
/** Bisection resolution. One minute is finer than any SoF timestamp we ingest. */
const BISECT_RESOLUTION_MS = 60_000;
/**
 * Ceiling on the forward search. The engine refuses to iterate beyond 1440
 * hours from laytime commencement (`CALCULATION_TIMEOUT`), and commencement is
 * earlier than `now`, so the reachable horizon is strictly less than 60 days
 * from now and depends on how long the voyage has already run. Rather than
 * duplicate the engine's commencement logic to compute it, the search probes
 * outward and lets the engine tell us where its own limit is.
 */
const MAX_FORWARD_DAYS = 60;

function toMs(iso: string): number {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) throw new Error(`INVALID_TIMESTAMP: ${iso}`);
  return ms;
}

function hasCompletion(events: SofEventInput[]): boolean {
  return events.some((e) =>
    (COMPLETION_EVENTS as readonly string[]).includes(e.event_type)
  );
}

/**
 * The completion event type to synthesise. Mirrors whichever operation is open
 * so the synthetic event is the one the voyage would actually have produced.
 */
function completionTypeFor(events: SofEventInput[]): (typeof COMPLETION_EVENTS)[number] {
  const lastCommenced = [...events]
    .filter(
      (e) =>
        e.event_type === "COMMENCED_LOADING" || e.event_type === "COMMENCED_DISCHARGE"
    )
    .sort((a, b) => toMs(a.occurred_at) - toMs(b.occurred_at))
    .pop();
  return lastCommenced?.event_type === "COMMENCED_DISCHARGE"
    ? "COMPLETED_DISCHARGE"
    : "COMPLETED_LOADING";
}

/**
 * Runs the real engine against the event set as if operations completed at
 * `cutoffMs`. The synthetic event carries a reserved id so it can never be
 * confused with a persisted row if a caller logs the input set.
 */
function computeAt(input: ExposureInput, cutoffMs: number) {
  const synthetic: SofEventInput = {
    id: "__live_exposure_cutoff__",
    occurred_at: new Date(cutoffMs).toISOString(),
    event_type: completionTypeFor(input.events),
  };
  return recomputeLaytime([...input.events, synthetic], input.terms);
}

/**
 * Earliest instant at which demurrage begins to accrue, or null if the
 * allowance is not exhausted before the engine's computable horizon.
 *
 * The predicate is "has any demurrage hour been billed", not "has used_hours
 * reached the allowance". The two differ by one hour and the difference is not
 * cosmetic: the engine credits a whole hour for any partial hour at the end of
 * the window, so `used_hours` hits the allowance the moment the *final laytime
 * hour begins*, an hour before the allowance is actually spent. Bisecting on
 * the demurrage clock instead lands on the instant money starts — which is the
 * only instant an operator can act against — and it needs no assumption that
 * the hour blocks are aligned to the clock (they are aligned to laytime
 * commencement, which an odd NOR time makes arbitrary).
 *
 * Two properties make the search correct and cheap. Both totals are
 * monotonically non-decreasing in the cut-off (extending the window only ever
 * adds hours), so bisection applies. And an earlier cut-off costs strictly
 * fewer engine iterations than a later one, so once a probe succeeds every
 * earlier probe succeeds too — which is why the doubling phase can establish a
 * safe upper bound before the bisection phase starts.
 */
function findExhaustion(input: ExposureInput, fromMs: number): string | null {
  const ceilingMs = fromMs + MAX_FORWARD_DAYS * 24 * MS_PER_HOUR;
  const onDemurrageAt = (ms: number) => computeAt(input, ms).totals.time_on_demurrage_hours > 0;

  // Phase 1 — grow outward until demurrage appears or the engine refuses.
  let hi = 0;
  let reached = false;
  for (let stepH = 24; ; stepH *= 2) {
    const probe = Math.min(fromMs + stepH * MS_PER_HOUR, ceilingMs);
    let hit: boolean;
    try {
      hit = onDemurrageAt(probe);
    } catch {
      break; // the engine's own iteration limit — fall back to the last good probe
    }
    hi = probe;
    reached = hit;
    if (hit || probe >= ceilingMs) break;
  }
  // Not reached anywhere the engine is willing to compute. Honest null rather
  // than an extrapolated guess.
  if (!reached) return null;

  // Phase 2 — bisect for the first minute at which demurrage is running.
  let lo = fromMs;
  while (hi - lo > BISECT_RESOLUTION_MS) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (onDemurrageAt(mid)) hi = mid;
    else lo = mid;
  }
  return new Date(hi).toISOString();
}

function unavailable(now: string, reason: string, terms: CpTerms): ExposureSnapshot {
  return {
    state: "not_started",
    asOf: now,
    allowedHours: terms.laytime_allowed_hours,
    usedHours: 0,
    remainingHours: terms.laytime_allowed_hours,
    percentConsumed: 0,
    onDemurrageHours: 0,
    accruedDemurrage: 0,
    currency: terms.currency,
    laytimeExhaustedAt: null,
    projection: null,
    unavailableReason: reason,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Current laytime exposure for a voyage in progress.
 *
 * Returns a `completed` snapshot untouched by projection when the event set
 * already contains a completion event — at that point the stored calculation is
 * authoritative and a "live" number would only invite disagreement with it.
 */
export function computeLiveExposure(input: ExposureInput): ExposureSnapshot {
  const { terms, now } = input;
  const nowMs = toMs(now);

  if (hasCompletion(input.events)) {
    let result;
    try {
      result = recomputeLaytime(input.events, terms);
    } catch (e) {
      return unavailable(
        now,
        e instanceof Error ? e.message : "CALCULATION_FAILED",
        terms
      );
    }
    const t = result.totals;
    return {
      state: "completed",
      asOf: now,
      allowedHours: t.allowed_hours,
      usedHours: round2(t.used_hours),
      remainingHours: round2(Math.max(0, t.allowed_hours - t.used_hours)),
      percentConsumed:
        t.allowed_hours > 0 ? round2((t.used_hours / t.allowed_hours) * 100) : 0,
      onDemurrageHours: round2(t.time_on_demurrage_hours),
      accruedDemurrage: t.demurrage_amount,
      currency: t.currency,
      laytimeExhaustedAt: null,
      projection: null,
      unavailableReason: null,
    };
  }

  let atNow;
  try {
    atNow = computeAt(input, nowMs);
  } catch (e) {
    if (e instanceof NoNorError) {
      return unavailable(now, "NOR_NOT_TENDERED", terms);
    }
    return unavailable(now, e instanceof Error ? e.message : "CALCULATION_FAILED", terms);
  }

  const t = atNow.totals;
  const allowedHours = t.allowed_hours;
  const usedHours = t.used_hours;
  // Mirrors the engine's own switch (`usedHours >= allowedHours` → demurrage)
  // rather than testing accrued demurrage hours: at the exact instant the
  // allowance is met, no demurrage hour has elapsed yet but the next one costs
  // money, and that is the moment an operator needs the meter to have flipped.
  const onDemurrage = usedHours >= allowedHours;

  // Only search forward when the allowance is still intact; once demurrage is
  // running the answer is "already", and the bisection would be wasted work.
  const laytimeExhaustedAt = onDemurrage ? null : findExhaustion(input, nowMs);

  let projection: ExposureProjection | null = null;
  if (input.projectedCompletionAt) {
    const projMs = toMs(input.projectedCompletionAt);
    // A projection into the past is a stale ETA, not a forecast — drop it
    // rather than present a "projection" the meter has already overtaken.
    if (projMs >= nowMs) {
      try {
        const pt = computeAt(input, projMs).totals;
        projection = {
          projectedCompletionAt: input.projectedCompletionAt,
          projectedUsedHours: round2(pt.used_hours),
          projectedDemurrageHours: round2(pt.time_on_demurrage_hours),
          projectedDemurrage: pt.demurrage_amount,
          projectedDespatch: pt.despatch_amount,
          projectedNet: new Decimal(pt.demurrage_amount)
            .minus(pt.despatch_amount)
            .toNumber(),
        };
      } catch {
        projection = null; // an unprojectable voyage reports no projection
      }
    }
  }

  return {
    state: onDemurrage ? "demurrage_accruing" : "laytime_running",
    asOf: now,
    allowedHours,
    usedHours: round2(usedHours),
    remainingHours: round2(Math.max(0, allowedHours - usedHours)),
    percentConsumed: allowedHours > 0 ? round2((usedHours / allowedHours) * 100) : 0,
    onDemurrageHours: round2(t.time_on_demurrage_hours),
    accruedDemurrage: t.demurrage_amount,
    currency: t.currency,
    laytimeExhaustedAt,
    projection,
    unavailableReason: null,
  };
}

// === Alerting ===

export type ExposureAlertLevel = "none" | "approaching" | "imminent" | "on_demurrage";

export interface ExposureAlert {
  level: ExposureAlertLevel;
  headline: string;
  detail: string;
}

// Thresholds are the smaller of an absolute hours-remaining figure and a share
// of the allowance, because neither works alone. A fixed 72h "approaching" band
// fires from the first hour of a 72h fixture — the alert would be permanently
// on and therefore ignored. A pure percentage misfires the other way: 10% of a
// 30-day allowance is 72h, which is not urgent, while 10% of a 24h allowance is
// 2.4h, which is far too late to act on. Taking the minimum keeps the warning
// proportionate on long fixtures and still absolute on short ones.
export const IMMINENT_THRESHOLD_HOURS = 24;
export const APPROACHING_THRESHOLD_HOURS = 72;
export const IMMINENT_SHARE_OF_ALLOWANCE = 0.15;
export const APPROACHING_SHARE_OF_ALLOWANCE = 0.35;

/** Remaining-hours cut-offs for one allowance. Exported for the UI, so the
 *  meter can draw its bands at exactly the points the alerts fire. */
export function alertThresholds(allowedHours: number): {
  imminent: number;
  approaching: number;
} {
  return {
    imminent: Math.min(IMMINENT_THRESHOLD_HOURS, allowedHours * IMMINENT_SHARE_OF_ALLOWANCE),
    approaching: Math.min(
      APPROACHING_THRESHOLD_HOURS,
      allowedHours * APPROACHING_SHARE_OF_ALLOWANCE
    ),
  };
}

function fmtMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtHours(h: number): string {
  return `${h.toLocaleString("en-US", { maximumFractionDigits: 1 })}h`;
}

/**
 * Turns a snapshot into an operator-facing alert. Pure and separate from the
 * computation so the thresholds can be tuned without touching the maths.
 */
export function exposureAlert(snapshot: ExposureSnapshot): ExposureAlert {
  if (snapshot.state === "demurrage_accruing") {
    return {
      level: "on_demurrage",
      headline: `On demurrage — ${fmtMoney(snapshot.accruedDemurrage, snapshot.currency)} accrued`,
      detail: `Laytime was exhausted; ${fmtHours(snapshot.onDemurrageHours)} on demurrage so far and still counting.`,
    };
  }
  if (snapshot.state !== "laytime_running") {
    return { level: "none", headline: "", detail: "" };
  }
  const remaining = snapshot.remainingHours;
  const bands = alertThresholds(snapshot.allowedHours);
  if (remaining <= bands.imminent) {
    return {
      level: "imminent",
      headline: `Laytime expires in ${fmtHours(remaining)}`,
      detail: `${fmtHours(snapshot.usedHours)} of ${fmtHours(snapshot.allowedHours)} consumed. Demurrage begins once the allowance is exhausted.`,
    };
  }
  if (remaining <= bands.approaching) {
    return {
      level: "approaching",
      headline: `${fmtHours(remaining)} of laytime remaining`,
      detail: `${snapshot.percentConsumed.toFixed(1)}% of the allowance consumed.`,
    };
  }
  return { level: "none", headline: "", detail: "" };
}
