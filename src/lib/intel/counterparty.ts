// Counterparty risk profile — "Know Your Counterparty", built to be defensible.
//
// A desk fixing with a counterparty it has traded with twenty times has the
// evidence to know how that trade goes, and no way to see it: the facts are
// spread across twenty claims nobody reads together. This module gathers them.
//
// WHAT THIS DELIBERATELY IS NOT
//
// It is not a cross-tenant reputation database about named commercial
// entities. Every behavioural signal below is computed from the VIEWING
// COMPANY'S OWN BOOK — their claims, their settlements, their evidence checks.
// That is their own commercial record and theirs to read.
//
// The cross-tenant aggregates this codebase already ships (`honesty_index`,
// `oracle_voyage_stats`) are keyed by port and month — places and time
// buckets. A score keyed by a named company is a different kind of object: it
// would let one customer's private settlement behaviour be inferred from an
// aggregate, and it would publish a commercial judgement about a third party
// who has no account, no notice and no way to contest it. k-anonymity does not
// fix that, because the subject of the score is the identified entity itself.
// If that is ever wanted it needs a product and legal decision, not a
// migration.
//
// The one exception is sanctions screening, which is already run per claim
// against public-record data and is reported here verbatim rather than folded
// into a score.
//
// THREE RULES THE SHAPE ENFORCES
//
//   1. No opaque number. Every signal carries its own value, its sample size
//      and its plain-language reading. The overall band is derived from the
//      listed signals and names which ones drove it.
//   2. Refuse on thin evidence. Below the observation floor a signal reports
//      `insufficient_data`, not a percentage computed from one claim.
//   3. Nothing is imputed. A counterparty with no settlement history has no
//      settlement signal — not an average borrowed from someone else.
//
// Pure — the caller reads rows and passes them in.

/** Claims with this counterparty required before a behavioural signal is shown. */
export const MIN_OBSERVATIONS = 3;

export type SignalVerdict = "favourable" | "neutral" | "adverse" | "insufficient_data";

export interface RiskSignal {
  key: string;
  label: string;
  verdict: SignalVerdict;
  /** The measured figure, in `unit`. Null when insufficient. */
  value: number | null;
  unit: "percent" | "days" | "count";
  /** How many of the viewing company's claims this figure rests on. */
  observations: number;
  /** Why this reads the way it does — or why there is no figure. Never empty. */
  detail: string;
}

export interface CounterpartyClaimRecord {
  claimId: string;
  /** Owner's claimed position: demurrage less despatch. Null when uncomputed. */
  claimedAmount: number | null;
  settledAmount: number | null;
  daysToSettle: number | null;
  /** Evidence verdicts recorded on this claim. */
  evidenceVerdicts: string[];
  /** Amendments the counterparty proposed on this claim. */
  proposalsRaised: number;
  /** Of those, how many the owner rejected. */
  proposalsRejected: number;
  timeBarExpired: boolean;
}

export interface SanctionsSnapshot {
  verdict: "clear" | "possible_match" | "match" | "unavailable";
  checkedAt: string | null;
  source: string;
}

export interface CounterpartyProfileInput {
  counterpartyName: string;
  claims: CounterpartyClaimRecord[];
  sanctions: SanctionsSnapshot | null;
}

export type RiskBand = "low" | "moderate" | "elevated" | "unrated";

export interface CounterpartyProfile {
  counterpartyName: string;
  band: RiskBand;
  /** Signals that drove the band, named so the reader can check the reasoning. */
  drivers: string[];
  totalClaims: number;
  settledClaims: number;
  signals: RiskSignal[];
  sanctions: SanctionsSnapshot | null;
  methodology: string;
  /** How a counterparty disputes what is recorded here. */
  correctionPath: string;
}

const METHODOLOGY =
  "Computed solely from your own company's claims with this counterparty — your " +
  "settlements, your evidence checks, your proposal history. No data from other " +
  "LayGrounded customers is used, and no score about this counterparty is shared " +
  `with anyone else. Signals need at least ${MIN_OBSERVATIONS} of your claims before ` +
  "they report a figure. Sanctions screening is public-record data, reported as " +
  "returned by the screening provider and never folded into the band.";

const CORRECTION_PATH =
  "Every figure traces to specific claims in your account. If a counterparty " +
  "disputes what is recorded, correct the underlying claim — the profile is " +
  "recomputed from it on the next read, and nothing is cached.";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function insufficient(key: string, label: string, unit: RiskSignal["unit"], n: number): RiskSignal {
  return {
    key,
    label,
    verdict: "insufficient_data",
    value: null,
    unit,
    observations: n,
    detail: `Needs at least ${MIN_OBSERVATIONS} of your claims with this counterparty; you have ${n}.`,
  };
}

/** Recovery rate: settled ÷ claimed across settled claims. */
function recoverySignal(claims: CounterpartyClaimRecord[]): RiskSignal {
  const settled = claims.filter(
    (c) => c.settledAmount !== null && c.claimedAmount !== null && c.claimedAmount > 0
  );
  if (settled.length < MIN_OBSERVATIONS) {
    return insufficient("recovery", "Recovery on settled claims", "percent", settled.length);
  }
  const pct =
    (settled.reduce((s, c) => s + c.settledAmount! / c.claimedAmount!, 0) / settled.length) * 100;
  const value = round1(pct);
  const verdict: SignalVerdict = value >= 85 ? "favourable" : value >= 60 ? "neutral" : "adverse";
  return {
    key: "recovery",
    label: "Recovery on settled claims",
    verdict,
    value,
    unit: "percent",
    observations: settled.length,
    detail: `They settle at ${value}% of what you claim, across ${settled.length} settled claim${settled.length === 1 ? "" : "s"}.`,
  };
}

/** How long settlement takes — a slow payer is a financing cost, not a dispute. */
function cycleSignal(claims: CounterpartyClaimRecord[]): RiskSignal {
  const withDays = claims.filter((c) => c.daysToSettle !== null && c.daysToSettle >= 0);
  if (withDays.length < MIN_OBSERVATIONS) {
    return insufficient("cycle", "Time to settle", "days", withDays.length);
  }
  const avg = withDays.reduce((s, c) => s + c.daysToSettle!, 0) / withDays.length;
  const value = round1(avg);
  const verdict: SignalVerdict = value <= 45 ? "favourable" : value <= 90 ? "neutral" : "adverse";
  return {
    key: "cycle",
    label: "Time to settle",
    verdict,
    value,
    unit: "days",
    observations: withDays.length,
    detail: `Settles in ${value} days on average, across ${withDays.length} claim${withDays.length === 1 ? "" : "s"}.`,
  };
}

/**
 * How often the independent archive contradicted a delay asserted on their
 * voyages. This is the sharpest signal the product has, and also the one most
 * open to misreading — a contradiction is evidence about a single recorded
 * event, not a finding of dishonesty, and the wording keeps it that way.
 */
function evidenceSignal(claims: CounterpartyClaimRecord[]): RiskSignal {
  const decisive = claims.filter((c) =>
    c.evidenceVerdicts.some((v) => v === "corroborated" || v === "contradicted")
  );
  if (decisive.length < MIN_OBSERVATIONS) {
    return insufficient("evidence", "Evidence corroboration", "percent", decisive.length);
  }
  const contradicted = decisive.filter((c) => c.evidenceVerdicts.includes("contradicted")).length;
  const value = round1((contradicted / decisive.length) * 100);
  const verdict: SignalVerdict = value === 0 ? "favourable" : value <= 25 ? "neutral" : "adverse";
  return {
    key: "evidence",
    label: "Claims with a contradicted delay",
    verdict,
    value,
    unit: "percent",
    observations: decisive.length,
    detail:
      `On ${contradicted} of ${decisive.length} verified claims, independent archive data did not ` +
      `support a delay recorded on the statement of facts. This is evidence about specific events, ` +
      `not a judgement about the counterparty.`,
  };
}

/** How contested the trade is: amendments raised, and how many did not stand. */
function disputeSignal(claims: CounterpartyClaimRecord[]): RiskSignal {
  if (claims.length < MIN_OBSERVATIONS) {
    return insufficient("disputes", "Amendments raised", "count", claims.length);
  }
  const raised = claims.reduce((s, c) => s + c.proposalsRaised, 0);
  const rejected = claims.reduce((s, c) => s + c.proposalsRejected, 0);
  const perClaim = round1(raised / claims.length);
  const verdict: SignalVerdict = raised === 0 ? "favourable" : perClaim <= 2 ? "neutral" : "adverse";
  return {
    key: "disputes",
    label: "Amendments raised",
    verdict,
    value: perClaim,
    unit: "count",
    observations: claims.length,
    detail:
      raised === 0
        ? `They have never proposed an amendment across ${claims.length} claims.`
        : `${raised} amendment${raised === 1 ? "" : "s"} proposed across ${claims.length} claims (${perClaim} per claim); ${rejected} rejected.`,
  };
}

/**
 * Overall band.
 *
 * A count of adverse signals, not a weighted score. A weighted score would
 * imply a precision this data does not have and would hide which fact drove the
 * result — and the whole point of the shape is that the reader can check the
 * reasoning. Signals with insufficient data are ignored rather than scored as
 * neutral, so a thin history reads as `unrated` instead of quietly averaging
 * out to "moderate".
 */
function deriveBand(signals: RiskSignal[], sanctions: SanctionsSnapshot | null): {
  band: RiskBand;
  drivers: string[];
} {
  const rated = signals.filter((s) => s.verdict !== "insufficient_data");
  const adverse = rated.filter((s) => s.verdict === "adverse");
  const drivers = adverse.map((s) => s.label);

  // A sanctions hit is not a risk band, it is a stop. It outranks everything
  // and is named explicitly rather than being blended into a score.
  if (sanctions?.verdict === "match" || sanctions?.verdict === "possible_match") {
    return {
      band: "elevated",
      drivers: [
        sanctions.verdict === "match"
          ? "Sanctions screening returned a match"
          : "Sanctions screening returned a possible match requiring review",
        ...drivers,
      ],
    };
  }

  if (rated.length === 0) {
    return { band: "unrated", drivers: ["Not enough history with this counterparty to rate."] };
  }
  if (adverse.length >= 2) return { band: "elevated", drivers };
  if (adverse.length === 1) return { band: "moderate", drivers };
  return { band: "low", drivers: ["No adverse signals across the history you have."] };
}

export function buildCounterpartyProfile(
  input: CounterpartyProfileInput
): CounterpartyProfile {
  const claims = input.claims;
  const signals = [
    recoverySignal(claims),
    cycleSignal(claims),
    evidenceSignal(claims),
    disputeSignal(claims),
  ];
  const { band, drivers } = deriveBand(signals, input.sanctions);

  return {
    counterpartyName: input.counterpartyName,
    band,
    drivers,
    totalClaims: claims.length,
    settledClaims: claims.filter((c) => c.settledAmount !== null).length,
    signals,
    sanctions: input.sanctions,
    methodology: METHODOLOGY,
    correctionPath: CORRECTION_PATH,
  };
}
