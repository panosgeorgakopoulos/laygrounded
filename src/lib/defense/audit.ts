// Defense Mode — adjudicating a demurrage claim someone has sent *to* you.
//
// The rest of the app helps an owner build a claim. This is the other side of
// the same desk: a charterer, trader or receiver gets a demurrage invoice with a
// PDF calculation attached and has to decide what to pay. Manual audit costs
// more than the average error, so most claims are paid close to as-presented —
// which is precisely why overclaiming persists.
//
// Everything here is an engine run, never an opinion. The claimant's own
// asserted events and their own asserted CP terms go through the same
// deterministic GENCON 94 / ASBATANKVOY engine that computes our claims, and the
// challenges are the differences that produces. That is what makes a reduction
// defensible in a negotiation: it is reproducible by the other side.
//
// Pure — no I/O, no AI, no Supabase. The caller assembles evidence verdicts and
// clause flags; this prices them.
//
// DIRECTION MATTERS, and it is the opposite of the owner-side intuition. Under a
// weather-working-days basis an excluded period does not consume laytime, so the
// clock is exhausted later and LESS demurrage accrues — every exclusion on the
// claimant's own timeline is already working for the payer. Striking one out
// (which is what `sensitivity.ts` correctly lists as an owner *opportunity*)
// therefore INCREASES the bill. Verified on the engine: a 12h weather window
// removed took a specimen claim from 36,000 to 48,000.
//
// So a defender's money comes from four moves, not from deleting exclusions:
//   1. arithmetic — the invoice exceeds the claimant's own calculation;
//   2. terms      — our copy of the fixture is more favourable than theirs;
//   3. later start / earlier end — AIS contradicts the NOR or the completion;
//   4. exclusions the claimant OMITTED — weather the record supports but the
//      SoF never logged.

import { Decimal } from "decimal.js";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";

/** Where a challenge's authority comes from. Ordered by how hard it is to rebut. */
export type ChallengeBasis = "arithmetic" | "evidence" | "terms" | "clause";

/**
 * How strongly the challenge can be pressed.
 *
 * `conclusive` — the claimant's own figures do not follow from the claimant's
 *   own stated facts, or independent data directly contradicts an asserted
 *   delay. Little room to argue.
 * `strong`  — rests on a term or a record we hold and they must disprove.
 * `arguable` — a genuine interpretation dispute; useful as negotiating room,
 *   not as a deduction to be asserted flatly.
 */
export type ChallengeStrength = "conclusive" | "strong" | "arguable";

export interface DefenseChallenge {
  id: string;
  basis: ChallengeBasis;
  strength: ChallengeStrength;
  label: string;
  rationale: string;
  clauseRef?: string;
  /**
   * Indicative money this challenge removes when priced ALONE, in the claim's
   * currency. Never sum these — see `defensiblePosition`, which prices every
   * upheld challenge in a single combined engine run.
   */
  reduction: number;
  eventIds: string[];
}

export interface ClauseFlagInput {
  eventId?: string;
  severity: string;
  label: string;
  clauseRef: string;
}

export interface DefenseAuditInput {
  /** The amount actually invoiced, as stated on their claim. */
  claimedAmount: number;
  /** The events exactly as the claimant asserts them. */
  events: SofEventInput[];
  /** CP terms as the CLAIMANT applied them. */
  cpTerms: CpTerms;
  /**
   * CP terms as WE hold them, from our copy of the fixture. Only the fields that
   * differ need be supplied. Absent = we are not disputing the terms.
   */
  ourCpTerms?: Partial<CpTerms>;
  /**
   * AIS-derived actual arrival, supplied only when the position record
   * contradicts the tendered NOR. Laytime cannot begin on a notice given before
   * the vessel was where the notice says it was.
   */
  norContradictedArrivalIso?: string;
  /**
   * Weather windows the ERA5 record supports but the claimant's SoF never
   * logged. Each is an exclusion left out of the claim — the commonest quiet
   * overcharge, because nobody audits for the stoppage that was not written down.
   */
  unrecordedWeatherWindows?: Array<{ startIso: string; endIso: string; source?: string }>;
  /** Evidence-supported completion earlier than the claimant asserts. */
  contradictedCompletionIso?: string;
  /** Evidence checks that could not be resolved either way. Reported, not assumed. */
  inconclusiveChecks?: number;
  /** True when no evidence verification has been run at all. */
  evidenceUnavailable?: boolean;
  clauseFlags?: ClauseFlagInput[];
}

export interface DefenseAuditResult {
  claimedAmount: number;
  /** The engine's answer on the claimant's own events and own terms. */
  recomputedAmount: number;
  currency: string;
  /** claimed − recomputed. Positive = they invoiced more than their own facts support. */
  arithmeticDelta: number;
  challenges: DefenseChallenge[];
  /**
   * What we say we owe: every upheld challenge applied together and priced in
   * ONE engine run, so interacting amendments cannot be double-counted.
   */
  defensiblePosition: number;
  /** claimed − defensiblePosition. The whole exposure this audit removes. */
  totalChallenged: number;
  /** Honest gaps — what this audit could NOT check. */
  notes: string[];
}

// Currency is money, so every figure runs through Decimal and is rounded once,
// at the boundary, exactly as the engine does.
function round2(d: Decimal): number {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

/** Owner's net position — what a claimant would actually bill. */
function netOf(events: SofEventInput[], cpTerms: CpTerms): Decimal | null {
  try {
    const r = recomputeLaytime(events, cpTerms);
    return new Decimal(r.totals.demurrage_amount).minus(r.totals.despatch_amount);
  } catch {
    // A set of amendments can make the claim uncomputable (e.g. NOR removed).
    // That is not a reduction to zero — it is an unpriceable perturbation, and
    // the caller must not treat it as money saved.
    return null;
  }
}

function shiftEventTo(events: SofEventInput[], id: string, iso: string): SofEventInput[] {
  return events.map((e) => (e.id === id ? { ...e, occurred_at: iso } : e));
}

/**
 * Adds a weather exclusion the claimant's SoF omits. The synthetic ids are
 * namespaced so they cannot collide with the claimant's own event ids — these
 * are our assertions, not theirs, and the distinction has to survive into any
 * document generated from this audit.
 */
function insertWeatherWindow(
  events: SofEventInput[],
  startIso: string,
  endIso: string,
  index: number,
): SofEventInput[] {
  return [
    ...events,
    { id: `defense-wx-${index}-start`, occurred_at: startIso, event_type: "WEATHER_DELAY" },
    { id: `defense-wx-${index}-end`, occurred_at: endIso, event_type: "WEATHER_DELAY_END" },
  ];
}

// Only these terms change the money in a way a charterer can assert from their
// own copy of the fixture. Deliberately excludes port_timezone and cp_form:
// those change the whole computation basis and belong in a dispute about which
// contract governs, not in a line-item deduction.
const CHALLENGEABLE_TERMS: Array<{
  key: keyof CpTerms;
  label: string;
  clauseRef: string;
}> = [
  { key: "laytime_allowed_hours", label: "Laytime allowed", clauseRef: "GENCON94-6(a)" },
  { key: "days_basis", label: "Laytime basis", clauseRef: "GENCON94-6(c)" },
  { key: "turn_time_hours", label: "Turn time", clauseRef: "GENCON94-6(c)" },
  { key: "demurrage_rate", label: "Demurrage rate", clauseRef: "GENCON94-7" },
  { key: "nor_variant", label: "NOR variant", clauseRef: "GENCON94-6(c)" },
];

function describeTerm(key: keyof CpTerms, value: unknown): string {
  if (key === "demurrage_rate") return `${value}/day`;
  if (key === "laytime_allowed_hours" || key === "turn_time_hours") return `${value}h`;
  return String(value);
}

/**
 * Audits an inbound claim. Returns the reductions we can defend and the number
 * we should put back on the table.
 */
export function auditInboundClaim(input: DefenseAuditInput): DefenseAuditResult {
  const claimed = new Decimal(input.claimedAmount);
  const notes: string[] = [];
  const challenges: DefenseChallenge[] = [];

  const baseline = netOf(input.events, input.cpTerms);
  if (baseline === null) {
    // Their own timeline does not compute — usually a missing NOR. That is a
    // complete answer to the claim as presented, so it is reported as such
    // rather than as a partial deduction.
    return {
      claimedAmount: input.claimedAmount,
      recomputedAmount: 0,
      currency: input.cpTerms.currency,
      arithmeticDelta: input.claimedAmount,
      challenges: [
        {
          id: "uncomputable",
          basis: "arithmetic",
          strength: "conclusive",
          label: "Claim does not compute on its own facts",
          rationale:
            "The events as presented do not support a laytime calculation at all — " +
            "typically no valid Notice of Readiness. Nothing is payable until the " +
            "claimant presents a computable timeline.",
          reduction: input.claimedAmount,
          eventIds: [],
        },
      ],
      defensiblePosition: 0,
      totalChallenged: input.claimedAmount,
      notes: ["The claimant's timeline could not be computed; no further audit was possible."],
    };
  }

  // ── 1. Arithmetic: does their invoice match their own stated facts? ────────
  const arithmeticDelta = claimed.minus(baseline);
  if (arithmeticDelta.abs().greaterThan(0.5)) {
    const over = arithmeticDelta.greaterThan(0);
    challenges.push({
      id: "arithmetic",
      basis: "arithmetic",
      strength: "conclusive",
      label: over
        ? "Invoice exceeds the claimant's own calculation"
        : "Invoice is below the claimant's own calculation",
      rationale:
        `Recomputing the claimant's own events under the claimant's own CP terms gives ` +
        `${input.cpTerms.currency} ${round2(baseline).toLocaleString("en-US")}, against an ` +
        `invoiced ${input.cpTerms.currency} ${round2(claimed).toLocaleString("en-US")}. ` +
        (over
          ? "The difference is unsupported by their own submission."
          : "Noted for completeness — the claim is understated, not overstated."),
      reduction: over ? round2(arithmeticDelta) : 0,
      eventIds: [],
    });
  }

  // Every subsequent challenge is priced against the recomputed baseline, not
  // against the invoice — otherwise an arithmetic error would be counted twice.
  const priceAgainstBaseline = (events: SofEventInput[], terms: CpTerms): number => {
    const perturbed = netOf(events, terms);
    if (perturbed === null) return 0;
    const delta = baseline.minus(perturbed);
    return delta.greaterThan(0) ? round2(delta) : 0;
  };

  // ── 2. Evidence: a later start, an earlier end, or an omitted exclusion ───
  let evidenceAmended = input.events;

  if (input.norContradictedArrivalIso) {
    const nor = input.events.find((e) => e.event_type === "NOR_TENDERED");
    if (nor && new Date(input.norContradictedArrivalIso) > new Date(nor.occurred_at)) {
      const deferred = shiftEventTo(input.events, nor.id, input.norContradictedArrivalIso);
      const reduction = priceAgainstBaseline(deferred, input.cpTerms);
      if (reduction > 0) {
        evidenceAmended = shiftEventTo(evidenceAmended, nor.id, input.norContradictedArrivalIso);
        challenges.push({
          id: "evidence-nor-position",
          basis: "evidence",
          strength: "conclusive",
          label: "NOR tendered before the vessel had arrived",
          rationale:
            "AIS position history places the vessel away from the port at the time the " +
            "Notice of Readiness was tendered. A notice given before arrival is invalid, " +
            "and laytime cannot commence before the vessel was actually there.",
          clauseRef: "GENCON94-6(c)",
          reduction,
          eventIds: [nor.id],
        });
      }
    }
  }

  for (const [i, window] of (input.unrecordedWeatherWindows ?? []).entries()) {
    const withWindow = insertWeatherWindow(evidenceAmended, window.startIso, window.endIso, i);
    const reduction = priceAgainstBaseline(withWindow, input.cpTerms);
    if (reduction <= 0) continue;
    evidenceAmended = withWindow;
    challenges.push({
      id: `evidence-unrecorded-weather-${i}`,
      basis: "evidence",
      strength: "strong",
      label: "Weather stoppage omitted from the claimant's statement of facts",
      rationale:
        `The meteorological record shows stoppage-grade conditions from ${window.startIso} ` +
        `to ${window.endIso}, which the presented SoF does not log. Under a weather-working-days ` +
        "basis that period does not consume laytime, so the claim overstates the time used.",
      clauseRef: "GENCON94-6(c)",
      reduction,
      eventIds: [],
    });
  }

  if (input.contradictedCompletionIso) {
    const completion = input.events.find(
      (e) => e.event_type === "COMPLETED_LOADING" || e.event_type === "COMPLETED_DISCHARGE",
    );
    if (completion && new Date(input.contradictedCompletionIso) < new Date(completion.occurred_at)) {
      const earlier = shiftEventTo(evidenceAmended, completion.id, input.contradictedCompletionIso);
      const reduction = priceAgainstBaseline(earlier, input.cpTerms);
      if (reduction > 0) {
        evidenceAmended = earlier;
        challenges.push({
          id: "evidence-completion",
          basis: "evidence",
          strength: "strong",
          label: "Cargo operations completed earlier than claimed",
          rationale:
            "Independent record places completion before the time asserted. Demurrage " +
            "cannot run past the completion of cargo operations.",
          clauseRef: "GENCON94-7",
          reduction,
          eventIds: [completion.id],
        });
      }
    }
  }

  if (
    input.evidenceUnavailable &&
    !input.norContradictedArrivalIso &&
    !(input.unrecordedWeatherWindows ?? []).length
  ) {
    notes.push(
      "No evidence verification has been run on this claim — weather stoppages and the " +
        "NOR position are unchecked. Running it may produce further conclusive challenges.",
    );
  }

  if (input.inconclusiveChecks && input.inconclusiveChecks > 0) {
    notes.push(
      `${input.inconclusiveChecks} evidence check${input.inconclusiveChecks === 1 ? "" : "s"} ` +
        "returned inconclusive and are NOT counted as challenges — an unresolved check is " +
        "not a contradiction.",
    );
  }

  // ── 3. Terms: what our copy of the fixture says ───────────────────────────
  if (input.ourCpTerms) {
    for (const { key, label, clauseRef } of CHALLENGEABLE_TERMS) {
      const ours = input.ourCpTerms[key];
      if (ours === undefined || ours === null) continue;
      const theirs = input.cpTerms[key];
      if (ours === theirs) continue;

      const correctedTerms = { ...input.cpTerms, [key]: ours } as CpTerms;
      const reduction = priceAgainstBaseline(input.events, correctedTerms);
      // A term difference that moves no money is real but not worth raising.
      if (reduction <= 0) continue;

      challenges.push({
        id: `terms-${String(key)}`,
        basis: "terms",
        strength: "strong",
        label: `${label} applied as ${describeTerm(key, theirs)}, fixture says ${describeTerm(key, ours)}`,
        rationale:
          `The claim is computed on ${label.toLowerCase()} of ${describeTerm(key, theirs)}. ` +
          `Our copy of the fixture records ${describeTerm(key, ours)}. Recomputing on the ` +
          "fixture term reduces the claim by this amount.",
        clauseRef,
        reduction,
        eventIds: [],
      });
    }
  } else {
    notes.push(
      "No fixture terms were supplied for comparison, so the claimant's stated CP terms " +
        "were taken at face value. Supplying your copy of the recap often finds more.",
    );
  }

  // ── 4. Clause flags: the NOR-validity argument, priced ────────────────────
  // Only NOR-validity flags are turned into money. The classic charterer point
  // is that a notice tendered at anchorage does not start the clock until the
  // vessel is actually alongside, so the priced amendment is "laytime commences
  // at ALL_FAST". Other flags are left to the reader rather than given an
  // invented perturbation — pricing a dispute we cannot state precisely would
  // put a number on an argument nobody made.
  const norEvent = input.events.find((e) => e.event_type === "NOR_TENDERED");
  const allFast = input.events.find((e) => e.event_type === "ALL_FAST");
  const norFlag = (input.clauseFlags ?? []).find(
    (f) => f.eventId === norEvent?.id || /\bnor\b/i.test(f.label),
  );
  if (norFlag && norEvent && allFast && new Date(allFast.occurred_at) > new Date(norEvent.occurred_at)) {
    const reduction = priceAgainstBaseline(
      shiftEventTo(input.events, norEvent.id, allFast.occurred_at),
      input.cpTerms,
    );
    if (reduction > 0) {
      challenges.push({
        id: `clause-nor-validity`,
        basis: "clause",
        strength: "arguable",
        label: norFlag.label,
        rationale:
          "The validity of the Notice of Readiness is contestable on these facts. Priced as " +
          "the amount at stake if laytime is held to commence on berthing instead — " +
          "negotiating room, not a deduction to assert flatly.",
        clauseRef: norFlag.clauseRef,
        reduction,
        eventIds: [norEvent.id],
      });
    }
  }

  challenges.sort((a, b) => b.reduction - a.reduction);

  // ── 5. The combined position ──────────────────────────────────────────────
  // Priced in ONE engine run with every asserted amendment applied together.
  // Summing the individual reductions would overstate wherever two amendments
  // touch the same hours: a deferred NOR and an added weather window can shadow
  // each other, and each would otherwise claim the full standalone saving.
  let combinedTerms: CpTerms = { ...input.cpTerms };
  if (input.ourCpTerms) {
    for (const { key } of CHALLENGEABLE_TERMS) {
      const ours = input.ourCpTerms[key];
      if (ours !== undefined && ours !== null) {
        combinedTerms = { ...combinedTerms, [key]: ours } as CpTerms;
      }
    }
  }

  // `evidenceAmended` already carries every evidence-backed amendment that
  // actually moved money. Clause challenges are `arguable` and are deliberately
  // NOT folded in — the defensible position must be a number we can hold, not
  // our best case.
  const combinedNet = netOf(evidenceAmended, combinedTerms);
  const defensible = combinedNet === null ? baseline : Decimal.max(combinedNet, new Decimal(0));
  const defensiblePosition = round2(defensible);

  if (challenges.some((c) => c.basis === "clause")) {
    notes.push(
      "Clause-based challenges are shown for negotiation but are excluded from the " +
        "defensible position, which reflects only what can be asserted outright.",
    );
  }

  return {
    claimedAmount: input.claimedAmount,
    recomputedAmount: round2(baseline),
    currency: input.cpTerms.currency,
    arithmeticDelta: round2(arithmeticDelta),
    challenges,
    defensiblePosition,
    totalChallenged: round2(claimed.minus(defensible)),
    notes,
  };
}
