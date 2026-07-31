// The EU-ETS carbon liability addendum to a demurrage claim.
//
// ── WHO OWES THIS, AND WHY THE ANSWER IS NOT "THE CHARTERER" ───────────────
//
// Under the EU ETS as extended to shipping (Dir. 2003/87/EC as amended by
// 2023/959), the obligation to surrender allowances rests on the SHIPPING
// COMPANY — the owner, or whoever has assumed ISM responsibility for operating
// the vessel. It does not rest on the charterer. Article 3gc requires Member
// States to ensure the shipping company is entitled to reimbursement from the
// entity commercially responsible for the ship's operation, but that recovery
// is CONTRACTUAL: it happens through a charterparty clause, most commonly the
// BIMCO ETS Emission Scheme clause.
//
// So the same tonnage produces two different commercial facts:
//
//   clause present  -> a CHARTERER LIABILITY, recoverable alongside demurrage;
//   clause absent   -> an UNRECOVERED OWNER COST, which the owner eats;
//   not recorded    -> unknown, and stated as such rather than assumed either
//                      way. Defaulting to "charterer owes" would put a legally
//                      unsupported demand into a document sent to a
//                      counterparty; defaulting to "owner eats it" would
//                      understate a claim the owner may be entitled to make.
//
// This module produces the figure and the ALLOCATION BASIS together, so the
// number can never travel without the statement of who it falls on.
//
// Pure: no I/O, no clock. The caller supplies the price and the date.

import { Decimal } from "decimal.js";
import type { CarbonCostOfDelay } from "@/lib/compliance/emissions";
import type { DataProvenance } from "@/lib/risk/provenance";

export type LiabilityAllocation =
  | "charterer_liability"
  | "unrecovered_owner_cost"
  | "unallocated";

export interface EtsAddendumInput {
  claim: {
    id: string;
    vessel: string;
    voyageRef: string | null;
    port: string;
    cargo: string | null;
    charterer: string | null;
    owner: string | null;
  };
  /** The already-scoped carbon cost of the demurrage period. */
  carbonCost: CarbonCostOfDelay;
  /** Tri-state: null means nobody has recorded whether the CP has the clause. */
  hasBimcoEtsClause: boolean | null;
  euaPriceEur: number;
  euaPriceProvenance: DataProvenance;
  /** How the EEA determination was made, for the document's own record. */
  etsScopeBasis: string;
  issuedAtISO: string;
}

export interface AddendumLine {
  label: string;
  value: string;
  /** Set when the line is the money the addendum is actually about. */
  emphasis?: boolean;
}

export interface EtsAddendum {
  allocation: LiabilityAllocation;
  /** The heading a reader sees. Never "charterer liability" without a clause. */
  title: string;
  /** EUR. Zero when the berth is outside EU ETS scope. */
  amountEur: number;
  /** Whom the amount falls on, in plain words. */
  bearer: string;
  /** The legal basis for that allocation, stated on the document. */
  basis: string;
  /** Shown prominently when the CP offers no recovery route. */
  warning: string | null;
  lines: AddendumLine[];
  /** Everything a reader needs to challenge the figure. */
  footnotes: string[];
  /** False when any input is synthetic — the document must say so. */
  decisionGrade: boolean;
  issuedAt: string;
}

const eur = (n: number) =>
  `EUR ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number, dp = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export function buildEtsAddendum(input: EtsAddendumInput): EtsAddendum {
  const { carbonCost, hasBimcoEtsClause } = input;
  const amountEur = new Decimal(carbonCost.etsCostEur).toDecimalPlaces(2).toNumber();
  const inScope = carbonCost.etsScope.share > 0;

  const charterer = input.claim.charterer?.trim() || "the Charterer";
  const owner = input.claim.owner?.trim() || "the Owner";

  let allocation: LiabilityAllocation;
  let title: string;
  let bearer: string;
  let basis: string;
  let warning: string | null = null;

  if (!inScope) {
    // No liability exists at all, so there is nothing to allocate. Saying
    // "charterer owes EUR 0.00" would imply a claim that does not exist.
    allocation = "unallocated";
    title = "EU-ETS Carbon Liability — none arising";
    bearer = "No party";
    basis =
      "The berth is outside EU ETS scope, so the demurrage period's emissions carry no allowance-surrender obligation. " +
      carbonCost.etsScope.note;
  } else if (hasBimcoEtsClause === true) {
    allocation = "charterer_liability";
    title = "EU-ETS Carbon Liability — Charterer";
    bearer = charterer;
    basis =
      `The surrender obligation under Dir. 2003/87/EC Art. 3ga rests on ${owner} as the shipping company. ` +
      `The charterparty carries a BIMCO ETS Emission Scheme clause (or equivalent), under which the cost of ` +
      `allowances attributable to this delay is recoverable from ${charterer}.`;
  } else if (hasBimcoEtsClause === false) {
    allocation = "unrecovered_owner_cost";
    title = "EU-ETS Carbon Cost — unrecovered by Owner";
    bearer = owner;
    basis =
      `The surrender obligation under Dir. 2003/87/EC Art. 3ga rests on ${owner} as the shipping company. ` +
      `This charterparty carries NO ETS clause, so there is no contractual route to recover the cost from ` +
      `${charterer}. Art. 3gc requires Member States to ensure a right of reimbursement from the entity ` +
      `commercially responsible for the ship's operation, but that right is given effect through the contract.`;
    warning =
      `This charterparty has no BIMCO ETS clause, so ${eur(amountEur)} of allowance cost arising from this ` +
      `delay stays with ${owner}. Adding an ETS clause to future fixtures is what makes this recoverable.`;
  } else {
    allocation = "unallocated";
    title = "EU-ETS Carbon Liability — allocation not determined";
    bearer = "Not determined";
    basis =
      `The surrender obligation under Dir. 2003/87/EC Art. 3ga rests on ${owner} as the shipping company. ` +
      `Whether it is recoverable from ${charterer} depends on the charterparty carrying an ETS clause, which ` +
      `has not been recorded for this fixture. This addendum therefore states the amount without allocating it.`;
    warning =
      "The charterparty's ETS clause status has not been recorded, so this amount is NOT presented as a " +
      "charterer liability. Record the clause status to allocate it.";
  }

  const e = carbonCost.emissions;
  const lines: AddendumLine[] = [
    { label: "Demurrage period", value: `${num(e.delayHours, 1)} hours` },
    { label: "Fuel grade assumed", value: e.fuel },
    { label: "At-berth burn rate", value: `${num(e.fuelTonnesPerDay)} t/day` },
    { label: "Fuel consumed", value: `${num(e.fuelTonnes, 3)} t` },
    { label: "CO2 emitted (tank-to-wake)", value: `${num(e.co2Tonnes, 3)} tCO2` },
    {
      label: "EU-ETS chargeable share",
      value: `${Math.round(carbonCost.etsScope.share * 100)}% (${carbonCost.etsScope.phaseIn * 100}% phase-in)`,
    },
    { label: "EUA price applied", value: `${eur(input.euaPriceEur)} / tCO2` },
    { label: "Allowance cost", value: eur(amountEur), emphasis: true },
  ];

  if (carbonCost.demurrageAmount != null) {
    lines.push({
      label: "Demurrage claimed",
      value: `${carbonCost.currency ?? "USD"} ${num(carbonCost.demurrageAmount)}`,
    });
  }

  const footnotes: string[] = [
    carbonCost.etsScope.note,
    input.etsScopeBasis,
    input.euaPriceProvenance.label,
    "CO2 is computed from an assumed at-berth auxiliary and boiler burn rate, not from measured bunker data. " +
      "A verified figure requires the vessel's own consumption records (see the MRV report).",
    "NOx and SOx are reported for MARPOL Annex VI awareness and carry no allowance cost.",
  ];

  if (!carbonCost.etsScope.scopeCertain) {
    footnotes.unshift(
      "The port's EEA status could not be determined, so the amount above is POTENTIAL exposure if this is " +
        "an EEA call — not a settled liability."
    );
  }

  const decisionGrade =
    input.euaPriceProvenance.source !== "mock" && carbonCost.etsScope.scopeCertain;

  return {
    allocation,
    title,
    amountEur,
    bearer,
    basis,
    warning,
    lines,
    footnotes,
    decisionGrade,
    issuedAt: input.issuedAtISO,
  };
}
