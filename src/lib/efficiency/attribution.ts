// Who is the slow call attributable to, and does that create a deduction?
//
// ── WHY A RATE SHORTFALL IS NOT AUTOMATICALLY A DEDUCTION ──────────────────
//
// A stipulated rate ("10,000 MT per weather working day") is the mechanism for
// DERIVING the laytime allowance: allowed time = cargo ÷ rate. It is not a
// warranty by the terminal that creates a credit when missed.
//
// If the terminal loads slower than the stipulated rate, the vessel uses more
// laytime and goes on demurrage — and that is exactly what the rate-based
// allowance prices. The charterer nominates the berth and the terminal works
// for the charterer's account, so slow loading is the charterer's risk. That is
// the bargain: the owner gets demurrage.
//
// Subtracting the shortfall from laytime would therefore do two indefensible
// things at once: DOUBLE-COUNT the rate (once in the allowance, once as a
// credit), and reverse the risk allocation the parties agreed. It is the first
// thing an owner's club would attack.
//
// What IS deductible is the mirror image — time lost to the OWNER's side:
// gear breakdown, crew unavailability, the vessel not being ready. Plus
// whatever the charterparty expressly excepts.
//
// So this module MEASURES the shortfall always, ATTRIBUTES it where the
// evidence supports an attribution, and produces a deduction only on a stated
// basis: an owner-fault finding, or a charterparty clause the user names. A
// shortfall with no basis is reported as a negotiating position with its money
// value, clearly labelled as not a deduction.
//
// ── AND IT DOES NOT TOUCH THE ENGINE ───────────────────────────────────────
//
// A deduction is expressed as EXCEPTED_PERIOD events the engine already
// understands, exactly as the WWD resolver emits WEATHER_DELAY pairs. Changing
// gencon94.ts would alter the 500-case conformance corpus and the published
// WASM root, breaking whole-object verification for every settled claim.
//
// Pure: no I/O, no clock.

import { Decimal } from "decimal.js";
import type { AchievedRate } from "@/lib/efficiency/cargo-rate";

export type FaultParty = "owner" | "charterer_or_terminal" | "neither" | "unattributed";

export interface DeductionBasis {
  /**
   * Why time may be deducted. Both are stated by the user, not inferred:
   *   `owner_fault`  — the vessel's own gear or crew caused the lost time.
   *   `cp_clause`    — a charterparty clause expressly excepts it.
   */
  kind: "owner_fault" | "cp_clause";
  /** Clause reference or the finding relied on. Mandatory. */
  reference: string;
  /** Hours the basis actually covers, when narrower than the whole shortfall. */
  hours?: number;
}

export interface RateComparison {
  label: string;
  benchmarkTonnesPerDay: number;
  achievedTonnesPerDay: number;
  /** Negative = slower than the benchmark. */
  shortfallTonnesPerDay: number;
  shortfallPct: number;
  /** Extra hours the shortfall cost, versus meeting the benchmark. */
  hoursLost: number;
  source: string;
}

export interface EfficiencyAttribution {
  achieved: AchievedRate;
  /** Against the charterparty's own stipulated rate. */
  contractual: RateComparison | null;
  /** Against the cross-tenant market. Null when k-anonymity suppresses it. */
  market: RateComparison | null;
  marketUnavailableReason: string | null;

  /** Who the lost time is attributable to, on the evidence supplied. */
  attributedTo: FaultParty;
  /**
   * Hours that may actually be deducted from laytime.
   *
   * ZERO unless a basis was supplied. A rate shortfall alone does not create
   * one — see the module header.
   */
  deductibleHours: number;
  deductionBasis: DeductionBasis | null;
  /**
   * Money the shortfall is worth at the demurrage rate. Reported whether or not
   * it is deductible, because it is the size of the argument either way.
   */
  shortfallValue: number;
  currency: string;
  /** Plain-language statement of what this does and does not establish. */
  statement: string;
  evidence: Array<{ clause_ref: string; finding: string }>;
  caveats: string[];
}

export interface AttributionInput {
  achieved: AchievedRate;
  /** The CP's stipulated rate for this operation, MT/day. */
  contractualTonnesPerDay?: number | null;
  /** Cross-tenant median for this port/terminal/cargo, MT/day. */
  marketTonnesPerDay?: number | null;
  marketSampleSize?: number;
  marketUnavailableReason?: string | null;
  /** "terminal" or "port" — which bucket the market median came from. */
  marketScope?: "terminal" | "port" | null;
  marketLabel?: string | null;
  /** Set when a terminal was asked for but the port median was used. */
  marketFellBackToPortReason?: string | null;
  demurrageRatePerDay: number;
  currency: string;
  /**
   * The claim's CP form and days basis.
   *
   * Needed because a deduction expressed as an EXCEPTED_PERIOD is SILENTLY
   * IGNORED by the engine under GENCON 94 + SHINC — see the caveat below. A
   * deduction reported but not applied is the worst kind of wrong.
   */
  cpForm?: "GENCON94" | "ASBATANKVOY" | null;
  daysBasis?: string | null;
  /** Supplied by the user; never inferred from the shortfall itself. */
  deductionBasis?: DeductionBasis | null;
}

function compare(
  label: string,
  benchmark: number,
  achieved: AchievedRate,
  source: string
): RateComparison {
  const shortfall = achieved.tonnesPerDay - benchmark;
  // Hours the cargo WOULD have taken at the benchmark rate, versus what it did.
  const hoursAtBenchmark = new Decimal(achieved.quantity.tonnes).div(benchmark).mul(24);
  const hoursLost = new Decimal(achieved.hoursUsed).minus(hoursAtBenchmark);

  return {
    label,
    benchmarkTonnesPerDay: benchmark,
    achievedTonnesPerDay: Math.round(achieved.tonnesPerDay * 10) / 10,
    shortfallTonnesPerDay: Math.round(shortfall * 10) / 10,
    shortfallPct: Math.round((shortfall / benchmark) * 1000) / 10,
    // Negative "lost" hours mean the terminal BEAT the benchmark; reported as
    // zero lost rather than as a negative deduction.
    hoursLost: Math.max(0, Math.round(hoursLost.toNumber() * 100) / 100),
    source,
  };
}

export function attributeInefficiency(input: AttributionInput): EfficiencyAttribution {
  const { achieved, demurrageRatePerDay, currency } = input;

  const contractual =
    input.contractualTonnesPerDay && input.contractualTonnesPerDay > 0
      ? compare(
          "Charterparty stipulated rate",
          input.contractualTonnesPerDay,
          achieved,
          "cp_terms"
        )
      : null;

  const market =
    input.marketTonnesPerDay && input.marketTonnesPerDay > 0
      ? compare(
          input.marketScope === "terminal"
            ? `Market median at ${input.marketLabel ?? "this terminal"}`
            : `Market median at ${input.marketLabel ?? "this port"}`,
          input.marketTonnesPerDay,
          achieved,
          `cross-tenant aggregate, n=${input.marketSampleSize ?? "?"}, scope=${input.marketScope ?? "port"}`
        )
      : null;

  // The contractual comparison is the operative one — it is the rate the
  // parties actually agreed. The market figure is context.
  const primary = contractual ?? market;
  const hoursLost = primary?.hoursLost ?? 0;

  const shortfallValue = new Decimal(hoursLost)
    .div(24)
    .mul(demurrageRatePerDay)
    .toDecimalPlaces(2)
    .toNumber();

  // A basis converts lost time into deductible time — and only up to the time
  // actually lost, so a broad clause cannot deduct more than the shortfall.
  const basis = input.deductionBasis ?? null;
  const deductibleHours = basis
    ? Math.min(basis.hours ?? hoursLost, hoursLost)
    : 0;

  let attributedTo: FaultParty;
  if (!primary || hoursLost === 0) attributedTo = "neither";
  else if (basis?.kind === "owner_fault") attributedTo = "owner";
  else if (basis?.kind === "cp_clause") attributedTo = "neither";
  else attributedTo = "unattributed";

  const evidence: Array<{ clause_ref: string; finding: string }> = [];
  const caveats: string[] = [];

  if (contractual) {
    evidence.push({
      clause_ref: "CP-LAYTIME-RATE",
      finding:
        `Stipulated ${contractual.benchmarkTonnesPerDay.toLocaleString("en-US")} MT/day; ` +
        `achieved ${contractual.achievedTonnesPerDay.toLocaleString("en-US")} MT/day ` +
        `(${contractual.shortfallPct > 0 ? "+" : ""}${contractual.shortfallPct}%) over ` +
        `${achieved.hoursUsed.toFixed(1)}h of ${achieved.basis} working time.`,
    });
  }
  if (market) {
    evidence.push({
      clause_ref: "MARKET-BENCHMARK",
      finding:
        `Market median ${market.benchmarkTonnesPerDay.toLocaleString("en-US")} MT/day ` +
        `(${market.source}); this call ran ${market.shortfallPct}% against it.`,
    });
  }

  let statement: string;
  if (!primary) {
    statement = "No benchmark rate was available, so the call's efficiency cannot be assessed.";
  } else if (hoursLost === 0) {
    statement =
      `The terminal met or beat the ${primary.label.toLowerCase()} ` +
      `(${primary.achievedTonnesPerDay.toLocaleString("en-US")} MT/day against ` +
      `${primary.benchmarkTonnesPerDay.toLocaleString("en-US")}). No time was lost to slow working.`;
  } else if (basis?.kind === "owner_fault") {
    statement =
      `${hoursLost.toFixed(1)}h were lost against the ${primary.label.toLowerCase()}, and ` +
      `${deductibleHours.toFixed(1)}h of that is attributed to the vessel (${basis.reference}). ` +
      `Time lost through the owner's own fault does not count against laytime, so it is deductible.`;
  } else if (basis?.kind === "cp_clause") {
    statement =
      `${hoursLost.toFixed(1)}h were lost against the ${primary.label.toLowerCase()}, and ` +
      `${deductibleHours.toFixed(1)}h of that is excepted under ${basis.reference}.`;
  } else {
    // The important one, and the default.
    statement =
      `${hoursLost.toFixed(1)}h were lost against the ${primary.label.toLowerCase()}, worth ` +
      `${currency} ${shortfallValue.toLocaleString("en-US")} at the demurrage rate. This is NOT ` +
      `a deduction: a stipulated rate derives the laytime allowance rather than warranting the ` +
      `terminal's performance, so slow working by the charterer's terminal is the charterer's ` +
      `risk and is what demurrage prices. It is a measured negotiating position — to convert it ` +
      `into deductible time you need a basis: a finding of owner's fault, or a charterparty ` +
      `clause that excepts it.`;

    caveats.push(
      "Deducting a rate shortfall without a basis would double-count the stipulated rate — once in the laytime allowance derived from it, and again as a credit."
    );
  }

  if (!achieved.quantity.confident) {
    caveats.push(
      `The cargo quantity was read as ${achieved.quantity.tonnes.toLocaleString("en-US")} MT from "${achieved.quantity.raw}", but the description contained more than one figure. Confirm it before relying on the rate.`
    );
  }
  if (achieved.basis === "gross") {
    caveats.push(
      "Measured on GROSS time, which includes weather and shifting. A charterparty rate quoted per weather working day should be compared against the net rate instead."
    );
  }
  if (input.marketUnavailableReason) {
    caveats.push(`Market comparison unavailable: ${input.marketUnavailableReason}`);
  }
  if (input.marketFellBackToPortReason) {
    caveats.push(input.marketFellBackToPortReason);
  }

  // VERIFIED AGAINST THE ENGINE, not assumed. Explicit EXCEPTED_PERIOD events
  // are honoured on every CP form and days basis EXCEPT GENCON 94 + SHINC,
  // where `isExceptedHour` folds agreed exceptions in with Sundays and holidays
  // and the SHINC rule then counts them. ASBATANKVOY has its own branch and is
  // unaffected. Reporting deductible hours that the calculation then ignores
  // would be worse than reporting none, so it is called out here rather than
  // fixed in the engine — changing gencon94.ts would alter the 500-case corpus
  // and the published WASM root.
  if (
    deductibleHours > 0 &&
    (input.cpForm ?? "GENCON94") === "GENCON94" &&
    input.daysBasis === "SHINC"
  ) {
    caveats.push(
      `ENGINE LIMITATION: under GENCON 94 with a SHINC basis, an agreed excepted period is not excluded from laytime — the SHINC rule ("Sundays and holidays included") currently absorbs it. These ${deductibleHours.toFixed(1)}h will NOT reduce the calculation until that is addressed. Every other CP form and days basis applies the deduction correctly.`
    );
  }

  return {
    achieved,
    contractual,
    market,
    marketUnavailableReason: input.marketUnavailableReason ?? null,
    attributedTo,
    deductibleHours: Math.round(deductibleHours * 100) / 100,
    deductionBasis: basis,
    shortfallValue,
    currency,
    statement,
    evidence,
    caveats,
  };
}

/**
 * Turns deductible hours into events the ENGINE already understands.
 *
 * EXCEPTED_PERIOD, not a new engine concept: an excepted period is excluded
 * under every days basis, which is correct for time that does not count at all
 * (owner's fault, or an express exception). Emitting events rather than
 * changing `gencon94.ts` is what keeps the 500-case corpus and the published
 * WASM root valid — the same reason the WWD resolver emits WEATHER_DELAY pairs.
 *
 * Returns an empty array when there is no basis, so a shortfall alone can never
 * silently alter a calculation.
 */
export function deductionEvents(
  attribution: EfficiencyAttribution,
  anchorISO: string
): Array<{ id: string; occurred_at: string; event_type: string }> {
  if (attribution.deductibleHours <= 0 || !attribution.deductionBasis) return [];

  const start = Date.parse(anchorISO);
  if (Number.isNaN(start)) return [];
  const end = start + attribution.deductibleHours * 3_600_000;

  return [
    {
      id: "terminal-fault-start",
      occurred_at: new Date(start).toISOString(),
      event_type: "EXCEPTED_PERIOD_START",
    },
    {
      id: "terminal-fault-end",
      occurred_at: new Date(end).toISOString(),
      event_type: "EXCEPTED_PERIOD_END",
    },
  ];
}
