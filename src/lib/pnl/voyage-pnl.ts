// Voyage P&L — the demurrage claim as one line in a complete voyage result.
//
// Everything else in this product prices a dispute. This prices the voyage: what
// the fixture actually earned, after freight, commissions, bunkers, port costs
// and — flowing in from the engine rather than being re-derived — demurrage and
// despatch.
//
// The directory is `pnl/`, not `analytics/`: `analytics/clause-pnl.ts` already
// exists and means something else (counterfactual clause analysis).
//
// Pure, like the engine: no I/O, no clock, decimal.js for every figure. The
// caller assembles the facts; this decides what they add up to.
//
// FIVE RULES, each of which is a way to be wrong that looks right:
//
//   1. Demurrage flows IN from `laytime_calculations`. It is never recomputed
//      here. A linked claim with no calculation is NAMED in the result, never
//      silently treated as zero — that would understate the voyage and nobody
//      would notice.
//   2. Commission on demurrage is a TERM, not an assumption. Whether address
//      commission bites on demurrage genuinely varies by charterparty, so
//      hard-coding either answer is wrong for half of all fixtures.
//   3. Currencies are never silently summed. Freight in USD and port
//      disbursements in BRL cannot be added without an explicit rate, so
//      off-currency lines are excluded from the totals and reported.
//   4. Perspective is explicit. On a time charter the owner EARNS hire and the
//      charterer PAYS it; identical inputs produce opposite signs.
//   5. TCE stays mathematically pure: (net revenue − voyage expenses) ÷ voyage
//      days. Bunkers on delivery/redelivery are a cash transfer between the
//      parties, not a voyage expense, so they sit outside it — folding them in
//      would distort the one number the market compares vessels on.

import Decimal from "decimal.js";

export type CharterType = "voyage" | "time";
export type Perspective = "owner" | "charterer";

/** Where a line came from, so every figure on the sheet is traceable. */
export type LineSource = "input" | "laytime_engine" | "derived";

/**
 * Which bucket a line falls in. Four, not two, and the distinctions are load-
 * bearing rather than presentational:
 *
 *   - `deduction` (commissions, despatch) reduces revenue.
 *   - `expense` (bunkers, port costs) is a voyage expense.
 *     Both are negative amounts, but TCE and "voyage expenses" mean different
 *     things by them, so a single "cost" bucket would force the totals to be
 *     recovered by matching on key names — which breaks the first time a key is
 *     renamed, and breaks silently, in money.
 *   - `transfer` (bunkers on delivery/redelivery) moves cash between the
 *     parties without the voyage earning or consuming anything. It belongs in
 *     the net result but NOT in TCE.
 */
export type LineKind = "revenue" | "deduction" | "expense" | "transfer";

export interface PnlLine {
  key: string;
  label: string;
  kind: LineKind;
  /** Always signed as it affects the result: positive earns, negative costs. */
  amount: number;
  currency: string;
  source: LineSource;
  /** True when the line is excluded from totals (off-currency). */
  excluded: boolean;
  note: string | null;
}

// === Inputs ===

export interface FreightTerms {
  basis: "per_mt" | "lumpsum";
  /** Freight rate per metric tonne. Required when basis is per_mt. */
  ratePerMt?: number;
  /** Lump-sum freight. Required when basis is lumpsum. */
  lumpsum?: number;
  /** Bill of lading quantity in metric tonnes. */
  quantityMt?: number;
  /** Cargo the charterer contracted for but did not supply. */
  deadfreightMt?: number;
}

export interface CommissionTerms {
  /** Address commission, returned to the charterer. Percent of freight. */
  addressPct: number;
  /** Brokerage. Percent of freight. */
  brokeragePct: number;
  /** Whether the above also bite on demurrage. See rule 2 — never defaulted. */
  onDemurrage: boolean;
}

export interface CostItem {
  label: string;
  amount: number;
  currency: string;
}

export interface BunkerLift {
  grade: string;
  tonnes: number;
  pricePerTonne: number;
  currency: string;
}

/** One port call's laytime outcome, as computed by the engine. */
export interface LaytimeOutcome {
  claimId: string;
  /** The calculation this came from, for traceability. Null is a bug upstream. */
  calculationId: string | null;
  demurrage: number;
  despatch: number;
  currency: string;
}

export interface OffHirePeriod {
  from: string;
  to: string;
  reason: string;
}

/**
 * Fuel on board at delivery or redelivery, settled between the parties.
 *
 * Not a consumption cost: the quantity is bought at an agreed price by whoever
 * takes the vessel over. See `TimeCharterTerms` for the direction of each.
 */
export interface BunkerSettlement {
  grade: string;
  tonnes: number;
  pricePerTonne: number;
  currency: string;
}

export interface TimeCharterTerms {
  hireRatePerDay: number;
  offHire: OffHirePeriod[];
  /** In lieu of hold cleaning. */
  ilohc?: number;
  /** Communication & victualling allowance, per 30 days. */
  cvePerMonth?: number;
  /**
   * Bunkers on delivery (BOD) — the fuel on board when the charterer takes the
   * vessel. The CHARTERER PAYS THE OWNER for it, so from the owner's side this
   * is cash in.
   */
  bunkersOnDelivery?: BunkerSettlement;
  /**
   * Bunkers on redelivery (BOR) — the fuel left aboard when the vessel comes
   * back. The OWNER PAYS THE CHARTERER for it, so from the owner's side this is
   * cash out. The opposite direction to BOD, which is the whole reason the two
   * are separate fields rather than one signed quantity.
   */
  bunkersOnRedelivery?: BunkerSettlement;
}

export interface VoyagePnlInput {
  charterType: CharterType;
  perspective: Perspective;
  /** Reporting currency. Lines in any other currency are excluded from totals. */
  currency: string;
  voyageStart: string | null;
  voyageEnd: string | null;
  freight?: FreightTerms;
  commissions: CommissionTerms;
  bunkers: BunkerLift[];
  portCosts: CostItem[];
  otherCosts: CostItem[];
  laytime: LaytimeOutcome[];
  /**
   * Claims linked to this voyage that have no calculation yet. Named so the
   * result can say the sheet is incomplete rather than quietly omitting them.
   */
  claimsAwaitingCalculation?: string[];
  timeCharter?: TimeCharterTerms;
}

// === Result ===

export interface VoyagePnlResult {
  lines: PnlLine[];
  /** Freight and hire earned, before commissions. */
  grossRevenue: number;
  /** Commissions and despatch — amounts that reduce revenue. */
  revenueDeductions: number;
  /** Bunkers, port disbursements, canal dues, other. Excludes transfers. */
  voyageExpenses: number;
  /** Cash transfers that are neither earned nor consumed (BOD/BOR). */
  transfers: number;
  /** grossRevenue − revenueDeductions − voyageExpenses + transfers. */
  netResult: number;
  currency: string;
  /** (net revenue − voyage expenses) ÷ voyage days. Null when undatable. */
  tcePerDay: number | null;
  voyageDays: number | null;
  /** Anything that makes the sheet incomplete or a figure unsafe to trust. */
  warnings: string[];
}

const MS_PER_DAY = 86_400_000;

const dec = (n: number) => new Decimal(n);

/**
 * Two decimal places, and never negative zero.
 *
 * Negating an empty total yields `-0`, which survives JSON and renders as
 * "-0" on a balance sheet. There is no such amount of money.
 */
const round2 = (d: Decimal) => {
  const n = d.toDecimalPlaces(2).toNumber();
  return n === 0 ? 0 : n;
};

function parseTime(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error(`INVALID_TIMESTAMP: ${iso}`);
  return t;
}

/**
 * Total off-hire days, with overlapping windows merged first.
 *
 * Without the merge a vessel logged off-hire twice for the same hours — which
 * happens whenever two causes are recorded for one stoppage — is credited
 * twice, and the charterer is under-billed for time the vessel really was off
 * hire.
 */
export function offHireDays(periods: OffHirePeriod[]): number {
  if (periods.length === 0) return 0;

  const spans = periods
    .map((p) => ({ from: parseTime(p.from), to: parseTime(p.to) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);

  if (spans.length === 0) return 0;

  const merged: Array<{ from: number; to: number }> = [spans[0]];
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (span.from <= last.to) {
      last.to = Math.max(last.to, span.to);
    } else {
      merged.push({ ...span });
    }
  }

  const ms = merged.reduce((sum, s) => sum + (s.to - s.from), 0);
  return round2(dec(ms).div(MS_PER_DAY));
}

/** Gross freight before commission, from either basis. */
function freightAmount(f: FreightTerms): Decimal {
  if (f.basis === "lumpsum") return dec(f.lumpsum ?? 0);
  return dec(f.ratePerMt ?? 0).mul(f.quantityMt ?? 0);
}

export function computeVoyagePnl(input: VoyagePnlInput): VoyagePnlResult {
  const lines: PnlLine[] = [];
  const warnings: string[] = [];
  const ccy = input.currency;
  // Owner earns freight/hire and pays despatch; the charterer is the mirror.
  const sign = input.perspective === "owner" ? 1 : -1;

  const push = (
    key: string,
    label: string,
    kind: LineKind,
    amount: Decimal,
    source: LineSource,
    currency = ccy,
    note: string | null = null
  ) => {
    const excluded = currency !== ccy;
    lines.push({
      key,
      label,
      kind,
      amount: round2(amount.mul(sign)),
      currency,
      source,
      excluded,
      note,
    });
  };

  // --- Revenue: freight (voyage charter) ---
  let grossFreight = dec(0);
  if (input.charterType === "voyage" && input.freight) {
    const f = input.freight;
    grossFreight = freightAmount(f);
    push(
      "freight",
      f.basis === "lumpsum"
        ? "Freight (lump sum)"
        : `Freight (${f.quantityMt ?? 0} MT x ${f.ratePerMt ?? 0})`,
      "revenue",
      grossFreight,
      "input"
    );

    if (f.deadfreightMt && f.deadfreightMt > 0) {
      // Deadfreight is charged at the freight rate on cargo the charterer
      // contracted for but did not supply. Lump-sum fixtures have no per-tonne
      // rate to charge it at, so it is refused rather than guessed.
      if (f.basis === "per_mt") {
        const dead = dec(f.ratePerMt ?? 0).mul(f.deadfreightMt);
        grossFreight = grossFreight.add(dead);
        push("deadfreight", `Deadfreight (${f.deadfreightMt} MT)`, "revenue", dead, "input");
      } else {
        warnings.push(
          "Deadfreight was supplied on a lump-sum fixture, which has no per-tonne rate to charge it at. It has been excluded."
        );
      }
    }
  }

  // --- Revenue: hire (time charter) ---
  let grossHire = dec(0);
  if (input.charterType === "time" && input.timeCharter) {
    const tc = input.timeCharter;
    if (!input.voyageStart || !input.voyageEnd) {
      warnings.push(
        "Time-charter hire needs both a start and an end date; no hire has been calculated."
      );
    } else {
      const totalDays = dec(parseTime(input.voyageEnd) - parseTime(input.voyageStart)).div(
        MS_PER_DAY
      );
      const off = dec(offHireDays(tc.offHire));
      const onHire = Decimal.max(totalDays.sub(off), 0);
      grossHire = onHire.mul(tc.hireRatePerDay);
      push(
        "hire",
        `Hire (${round2(onHire)} days on hire x ${tc.hireRatePerDay}/day)`,
        "revenue",
        grossHire,
        "derived",
        ccy,
        off.gt(0) ? `${round2(off)} days off hire deducted.` : null
      );
      if (off.gte(totalDays) && totalDays.gt(0)) {
        warnings.push("Off-hire covers the entire period; no hire is earned.");
      }
    }
    if (tc.ilohc) push("ilohc", "In lieu of hold cleaning", "revenue", dec(tc.ilohc), "input");
    if (tc.cvePerMonth && input.voyageStart && input.voyageEnd) {
      const months = dec(parseTime(input.voyageEnd) - parseTime(input.voyageStart))
        .div(MS_PER_DAY)
        .div(30);
      push("cve", "Communication & victualling", "revenue", months.mul(tc.cvePerMonth), "derived");
    }

    // --- Bunker settlement (BOD / BOR) ---
    // Both are `transfer`, which is what keeps them out of TCE. They are an
    // inventory settlement between the parties: no fuel was burned and no
    // freight was earned, so counting them as revenue or voyage expense would
    // move TCE without the voyage having performed any differently. That is the
    // one number the market compares vessels on, so it has to stay clean.
    if (tc.bunkersOnDelivery) {
      const b = tc.bunkersOnDelivery;
      push(
        "bunkers_on_delivery",
        `Bunkers on delivery ${b.grade} (${b.tonnes} MT x ${b.pricePerTonne})`,
        "transfer",
        dec(b.tonnes).mul(b.pricePerTonne),
        "input",
        b.currency,
        "Charterer buys the fuel on board at delivery — cash in to the owner."
      );
    }
    if (tc.bunkersOnRedelivery) {
      const b = tc.bunkersOnRedelivery;
      push(
        "bunkers_on_redelivery",
        `Bunkers on redelivery ${b.grade} (${b.tonnes} MT x ${b.pricePerTonne})`,
        "transfer",
        dec(b.tonnes).mul(b.pricePerTonne).neg(),
        "input",
        b.currency,
        "Owner buys back the fuel remaining at redelivery — cash out from the owner."
      );
    }
  }

  // --- Demurrage / despatch, from the engine ---
  let demurrageTotal = dec(0);
  for (const outcome of input.laytime) {
    const off = outcome.currency !== ccy;
    if (off) {
      warnings.push(
        `Claim ${outcome.claimId} settled in ${outcome.currency}, not the reporting currency ${ccy}; its demurrage and despatch are excluded from the totals.`
      );
    }
    if (outcome.demurrage > 0) {
      if (!off) demurrageTotal = demurrageTotal.add(outcome.demurrage);
      push(
        `demurrage:${outcome.claimId}`,
        "Demurrage earned",
        "revenue",
        dec(outcome.demurrage),
        "laytime_engine",
        outcome.currency,
        outcome.calculationId ? `Calculation ${outcome.calculationId}` : "No calculation reference"
      );
    }
    if (outcome.despatch > 0) {
      push(
        `despatch:${outcome.claimId}`,
        "Despatch allowed",
        "deduction",
        dec(outcome.despatch).neg(),
        "laytime_engine",
        outcome.currency,
        outcome.calculationId ? `Calculation ${outcome.calculationId}` : "No calculation reference"
      );
    }
  }

  // Rule 1: name the gap rather than let a missing calculation read as zero.
  for (const claimId of input.claimsAwaitingCalculation ?? []) {
    warnings.push(
      `Claim ${claimId} is linked to this voyage but has no laytime calculation yet, so no demurrage or despatch for it is included. The result is incomplete.`
    );
  }

  // --- Commissions ---
  // Rule 2: the commissionable base depends on the charterparty.
  const commissionBase = grossFreight
    .add(grossHire)
    .add(input.commissions.onDemurrage ? demurrageTotal : dec(0));

  const commissionNote = input.commissions.onDemurrage
    ? "Charged on freight/hire and demurrage, per the charterparty."
    : "Charged on freight/hire only; the charterparty does not extend it to demurrage.";

  if (input.commissions.addressPct > 0) {
    push(
      "address_commission",
      `Address commission (${input.commissions.addressPct}%)`,
      "deduction",
      commissionBase.mul(input.commissions.addressPct).div(100).neg(),
      "derived",
      ccy,
      commissionNote
    );
  }
  if (input.commissions.brokeragePct > 0) {
    push(
      "brokerage",
      `Brokerage (${input.commissions.brokeragePct}%)`,
      "deduction",
      commissionBase.mul(input.commissions.brokeragePct).div(100).neg(),
      "derived",
      ccy,
      commissionNote
    );
  }

  // --- Voyage expenses ---
  for (const b of input.bunkers) {
    push(
      `bunker:${b.grade}`,
      `Bunkers ${b.grade} (${b.tonnes} MT x ${b.pricePerTonne})`,
      "expense",
      dec(b.tonnes).mul(b.pricePerTonne).neg(),
      "input",
      b.currency
    );
  }
  for (const [i, p] of input.portCosts.entries()) {
    push(`port:${i}`, p.label, "expense", dec(p.amount).neg(), "input", p.currency);
  }
  for (const [i, o] of input.otherCosts.entries()) {
    push(`other:${i}`, o.label, "expense", dec(o.amount).neg(), "input", o.currency);
  }

  // --- Totals ---
  // Off-currency lines are carried for display but never summed (rule 3).
  const counted = lines.filter((l) => !l.excluded);
  const offCurrency = lines.filter((l) => l.excluded);
  if (offCurrency.length > 0) {
    const currencies = [...new Set(offCurrency.map((l) => l.currency))].join(", ");
    warnings.push(
      `${offCurrency.length} line(s) are in ${currencies} rather than ${ccy} and are excluded from every total. Supply them in ${ccy}, or convert them at a rate you can evidence.`
    );
  }

  const sumWhere = (pred: (l: PnlLine) => boolean) =>
    counted.filter(pred).reduce((acc, l) => acc.add(l.amount), dec(0));

  // Buckets come off `kind`, never off key names — see the LineKind comment.
  const grossRevenue = sumWhere((l) => l.kind === "revenue");
  const deductionLines = sumWhere((l) => l.kind === "deduction"); // already negative
  const expenseLines = sumWhere((l) => l.kind === "expense"); // already negative
  const transferLines = sumWhere((l) => l.kind === "transfer");

  const netResult = grossRevenue.add(deductionLines).add(expenseLines).add(transferLines);

  // --- TCE (rule 5) ---
  let voyageDays: number | null = null;
  let tcePerDay: number | null = null;
  if (input.voyageStart && input.voyageEnd) {
    const days = dec(parseTime(input.voyageEnd) - parseTime(input.voyageStart)).div(MS_PER_DAY);
    if (days.gt(0)) {
      voyageDays = round2(days);
      // Net revenue less voyage expenses, over voyage days. Transfers are
      // excluded on purpose: they are cash moving between the parties, not
      // something the voyage earned or consumed.
      tcePerDay = round2(grossRevenue.add(deductionLines).add(expenseLines).div(days));
    } else {
      warnings.push("Voyage end is not after voyage start, so TCE cannot be computed.");
    }
  } else {
    warnings.push("Voyage start and end dates are needed to compute TCE.");
  }

  return {
    lines,
    grossRevenue: round2(grossRevenue),
    revenueDeductions: round2(deductionLines.neg()),
    voyageExpenses: round2(expenseLines.neg()),
    transfers: round2(transferLines),
    netResult: round2(netResult),
    currency: ccy,
    tcePerDay,
    voyageDays,
    warnings,
  };
}
