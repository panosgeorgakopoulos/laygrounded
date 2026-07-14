// Autonomous agent-to-agent micro-negotiation.
//
// Two strategy personas — an owner agent and a charterer agent — play out up
// to MAX_NEGOTIATION_ROUNDS of rapid-fire concession trading over the claim's
// dispute agenda and produce a SettlementMatrix recommending the financial
// middle ground for one-click human approval.
//
// Deliberately NOT two live LLMs in a sandbox: money must not move on
// sampled text. The "agents" are deterministic concession strategies whose
// every position is an engine number:
//   * the dispute agenda comes from sensitivity.ts — each agenda item is a
//     perturbation the counterparty would realistically argue, priced by a
//     real engine run (deltaNet, owner's perspective);
//   * evidence verdicts decide items outright: a contradicted event forces
//     the side relying on it to yield (facts are not concessions and do not
//     consume goodwill budget), while a corroborated event kills the attack
//     against it;
//   * remaining items are traded cheapest-first, alternating turns, each side
//     capped by its maxConcessionUsd budget and its hard-stop categories
//     ("yield on weather, hold firm on NOR").
// Same inputs → same matrix, byte for byte. The route persists the matrix to
// autonomous_negotiation_rooms and gates execution behind a
// pending_human_reviews row — agents recommend, humans settle.
//
// Pure TypeScript: no I/O, no AI, no Supabase. All position arithmetic runs
// through decimal.js.

import { Decimal } from "decimal.js";
import { analyzeSensitivity, SensitivityFinding } from "@/lib/laytime/sensitivity";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";

export const MAX_NEGOTIATION_ROUNDS = 50;

// Sensitivity categories the agents trade over. CP-terms-level items (turn
// time, rates, days basis) are out of scope by design: the agents negotiate
// the event record under the agreed CP, they do not rewrite the CP.
export type NegotiationCategory = SensitivityFinding["category"];
export const NEGOTIATION_CATEGORIES: NegotiationCategory[] = [
  "nor",
  "completion",
  "weather",
  "shifting",
  "excepted",
];

export interface AgentLimits {
  // Cumulative value this agent may voluntarily trade away across all rounds
  // (claim currency). Evidence-forced adjustments do not count against it.
  maxConcessionUsd: number;
  // Categories this agent never concedes, voluntarily or otherwise —
  // evidence-forced items excepted (facts override instructions).
  hardStopClauses: NegotiationCategory[];
}

export interface EvidenceVerdictInput {
  eventId: string | null;
  verdict: "corroborated" | "contradicted" | "inconclusive" | "unavailable";
}

export interface ArbitrationInput {
  events: SofEventInput[];
  cpTerms: CpTerms;
  evidence: EvidenceVerdictInput[];
  ownerLimits: AgentLimits;
  chartererLimits: AgentLimits;
  maxRounds?: number; // 1..MAX_NEGOTIATION_ROUNDS, default MAX
}

export interface ConcessionRecord {
  round: number; // 0 = evidence-forced, pre-negotiation
  actor: "owner_agent" | "charterer_agent";
  category: NegotiationCategory;
  label: string;
  eventIds: string[];
  // Absolute value the concession moved toward the other side.
  amount: number;
  forcedByEvidence: boolean;
  rationale: string;
}

export interface HeldFirmRecord {
  actor: "owner_agent" | "charterer_agent";
  category: NegotiationCategory;
  label: string;
  reason:
    | "hard_stop"
    | "budget_exhausted"
    | "corroborated_evidence"
    | "contradicted_evidence"
    | "rounds_exhausted";
}

export interface SettlementMatrix {
  claimId: string;
  currency: string;
  // Engine baseline, owner's perspective (demurrage − despatch).
  baselineNet: number;
  ownerOpening: number;
  chartererOpening: number;
  ownerFinal: number;
  chartererFinal: number;
  gap: number;
  // Midpoint of the final positions — the number a human approves.
  recommendedSettlement: number;
  roundsCompleted: number;
  maxRounds: number;
  converged: boolean;
  // Deterministic heuristic in [0.05, 0.95]: how much of the opening gap the
  // agents managed to close. Not a statistical model — a ranking signal.
  settlementProbability: number;
  disputedValue: number;
  concessions: ConcessionRecord[];
  heldFirm: HeldFirmRecord[];
}

const d = (n: number | Decimal) => new Decimal(n);
const money = (x: Decimal) => x.toDecimalPlaces(2).toNumber();

// Convergence tolerance: positions this close are "a phone call apart".
export function settlementTolerance(baselineNet: number): Decimal {
  return Decimal.max(d(100), d(baselineNet).abs().mul(0.005));
}

type ItemFate = "tradeable" | "decided" | "dead_corroborated" | "dead_contradicted";

interface AgendaItem {
  finding: SensitivityFinding;
  // Who benefits when the item is applied: charterer_attack lowers net
  // (deltaNet < 0), owner_push raises it (deltaNet > 0).
  side: "charterer_attack" | "owner_push";
  fate: ItemFate;
  open: boolean;
}

// Evidence triage for one finding. Verdicts attach to event ids; a finding
// inherits the strongest verdict among the events it perturbs.
//   contradicted + strike-out finding → decided: the record is disproven, so
//     the perturbation that removes it stands as fact;
//   contradicted + shift/extension finding → dead: nobody can argue MORE of
//     an event the archive says never happened;
//   corroborated → dead: the record stands, the argument fails;
//   otherwise → tradeable.
// The strike-out detection leans on sensitivity.ts's stable "struck out"
// label wording; autonomous.test.ts pins that contract.
function triage(
  finding: SensitivityFinding,
  verdictsByEvent: Map<string, EvidenceVerdictInput["verdict"]>
): ItemFate {
  let contradicted = false;
  let corroborated = false;
  for (const id of finding.eventIds) {
    const v = verdictsByEvent.get(id);
    if (v === "contradicted") contradicted = true;
    if (v === "corroborated") corroborated = true;
  }
  if (corroborated) return "dead_corroborated";
  if (contradicted) {
    return finding.label.toLowerCase().includes("struck out") ? "decided" : "dead_contradicted";
  }
  return "tradeable";
}

function rationaleFor(item: AgendaItem, forced: boolean): string {
  if (forced) {
    return item.side === "charterer_attack"
      ? `Independent evidence contradicts the recorded event — the owner agent yields "${item.finding.label}" as established fact, outside its goodwill budget.`
      : `Independent evidence contradicts the recorded event — the charterer agent accepts "${item.finding.label}" as established fact, outside its goodwill budget.`;
  }
  return item.side === "charterer_attack"
    ? `Owner agent accepts the counterparty argument "${item.finding.label}" — unverified by evidence and cheap relative to the remaining gap.`
    : `Charterer agent accepts the owner position "${item.finding.label}" — unverified by evidence and cheap relative to the remaining gap.`;
}

// Deterministic ordering: cheapest first, ties broken by the stable finding
// id sensitivity.ts assigns in generation order.
function sortPool(pool: AgendaItem[]): AgendaItem[] {
  return [...pool].sort((a, b) => {
    const byValue = Math.abs(a.finding.deltaNet) - Math.abs(b.finding.deltaNet);
    return byValue !== 0 ? byValue : a.finding.id.localeCompare(b.finding.id);
  });
}

export function executeAgenticArbitration(
  claimId: string,
  input: ArbitrationInput
): SettlementMatrix {
  const maxRounds = input.maxRounds ?? MAX_NEGOTIATION_ROUNDS;
  if (
    !Number.isFinite(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > MAX_NEGOTIATION_ROUNDS ||
    input.ownerLimits.maxConcessionUsd < 0 ||
    input.chartererLimits.maxConcessionUsd < 0
  ) {
    throw new Error("INVALID_LIMITS");
  }

  // The dispute agenda: every priced perturbation on this claim.
  const report = analyzeSensitivity(input.events, input.cpTerms);
  const baseline = d(report.baselineNet);

  const verdictsByEvent = new Map<string, EvidenceVerdictInput["verdict"]>();
  for (const ev of input.evidence) {
    if (!ev.eventId) continue;
    // Strongest verdict wins when an event was checked more than once.
    const prev = verdictsByEvent.get(ev.eventId);
    if (prev === "contradicted" || prev === "corroborated") continue;
    verdictsByEvent.set(ev.eventId, ev.verdict);
  }

  const agenda: AgendaItem[] = [
    ...report.vulnerabilities.map<AgendaItem>((f) => ({
      finding: f,
      side: "charterer_attack",
      fate: triage(f, verdictsByEvent),
      open: true,
    })),
    ...report.opportunities.map<AgendaItem>((f) => ({
      finding: f,
      side: "owner_push",
      fate: triage(f, verdictsByEvent),
      open: true,
    })),
  ];

  const concessions: ConcessionRecord[] = [];
  const heldFirm: HeldFirmRecord[] = [];

  // Openings: each agent anchors at its best non-dead case, ignoring the
  // other side's arguments — classic anchoring.
  let ownerAsk = baseline;
  let chartererOffer = baseline;
  for (const item of agenda) {
    if (item.fate === "dead_corroborated" || item.fate === "dead_contradicted") {
      item.open = false;
      heldFirm.push({
        actor: item.side === "charterer_attack" ? "owner_agent" : "charterer_agent",
        category: item.finding.category,
        label: item.finding.label,
        reason: item.fate === "dead_corroborated" ? "corroborated_evidence" : "contradicted_evidence",
      });
      continue;
    }
    if (item.side === "owner_push") ownerAsk = ownerAsk.plus(item.finding.deltaNet);
    else chartererOffer = chartererOffer.plus(item.finding.deltaNet);
  }
  const ownerOpening = ownerAsk;
  const chartererOpening = chartererOffer;

  // Round 0: evidence-decided items are applied to the yielding side's
  // position immediately. Facts, not goodwill — budgets untouched.
  for (const item of agenda) {
    if (!item.open || item.fate !== "decided") continue;
    item.open = false;
    const delta = d(item.finding.deltaNet);
    if (item.side === "charterer_attack") ownerAsk = ownerAsk.plus(delta);
    else chartererOffer = chartererOffer.plus(delta);
    concessions.push({
      round: 0,
      actor: item.side === "charterer_attack" ? "owner_agent" : "charterer_agent",
      category: item.finding.category,
      label: item.finding.label,
      eventIds: item.finding.eventIds,
      amount: money(delta.abs()),
      forcedByEvidence: true,
      rationale: rationaleFor(item, true),
    });
  }

  const tolerance = settlementTolerance(report.baselineNet);
  const disputedValue = agenda
    .filter((i) => i.fate === "tradeable")
    .reduce((acc, i) => acc.plus(d(i.finding.deltaNet).abs()), d(0));

  // A concession by either side removes the item from the shared agenda:
  //   * owner concedes a charterer_attack (accepts it: ask += negative delta)
  //     or withdraws an owner_push (ask −= positive delta);
  //   * charterer concedes an owner_push (accepts it: offer += positive
  //     delta) or withdraws nothing of its own — dropping its own attack
  //     raises the offer by |delta|.
  // Either way the actor's position moves toward the other side by |delta|.
  const ownerBudget = d(input.ownerLimits.maxConcessionUsd);
  const chartererBudget = d(input.chartererLimits.maxConcessionUsd);
  let ownerSpent = d(0);
  let chartererSpent = d(0);
  const ownerStops = new Set(input.ownerLimits.hardStopClauses);
  const chartererStops = new Set(input.chartererLimits.hardStopClauses);

  let rounds = 0;
  let converged = ownerAsk.minus(chartererOffer).lte(tolerance);

  while (!converged && rounds < maxRounds) {
    // Charterer responds to the owner's demand, so it moves on odd rounds.
    const actorIsCharterer = rounds % 2 === 0;
    const stops = actorIsCharterer ? chartererStops : ownerStops;
    const budget = actorIsCharterer ? chartererBudget : ownerBudget;
    const spent = actorIsCharterer ? chartererSpent : ownerSpent;

    const pool = sortPool(
      agenda.filter((i) => i.open && i.fate === "tradeable" && !stops.has(i.finding.category))
    );
    const pick = pool.find((i) => spent.plus(d(i.finding.deltaNet).abs()).lte(budget));

    if (!pick) {
      // This side cannot move. If the other side is also stuck, negotiation
      // is over; otherwise skip the turn and let the other side keep moving.
      const otherStops = actorIsCharterer ? ownerStops : chartererStops;
      const otherBudget = actorIsCharterer ? ownerBudget : chartererBudget;
      const otherSpent = actorIsCharterer ? ownerSpent : chartererSpent;
      const otherPool = sortPool(
        agenda.filter((i) => i.open && i.fate === "tradeable" && !otherStops.has(i.finding.category))
      );
      const otherCanMove = otherPool.some((i) =>
        otherSpent.plus(d(i.finding.deltaNet).abs()).lte(otherBudget)
      );
      if (!otherCanMove) break;
      rounds++;
      continue;
    }

    rounds++;
    pick.open = false;
    const value = d(pick.finding.deltaNet).abs();
    if (actorIsCharterer) {
      chartererSpent = chartererSpent.plus(value);
      chartererOffer = chartererOffer.plus(value); // moves up toward the owner
    } else {
      ownerSpent = ownerSpent.plus(value);
      ownerAsk = ownerAsk.minus(value); // moves down toward the charterer
    }
    concessions.push({
      round: rounds,
      actor: actorIsCharterer ? "charterer_agent" : "owner_agent",
      category: pick.finding.category,
      label: pick.finding.label,
      eventIds: pick.finding.eventIds,
      amount: money(value),
      forcedByEvidence: false,
      rationale: rationaleFor(pick, false),
    });

    converged = ownerAsk.minus(chartererOffer).lte(tolerance);
  }

  // Anything still open explains why the gap did not fully close.
  for (const item of agenda) {
    if (!item.open || item.fate !== "tradeable") continue;
    const yieldingActor = item.side === "charterer_attack" ? "owner_agent" : "charterer_agent";
    const stops = yieldingActor === "owner_agent" ? ownerStops : chartererStops;
    const budget = yieldingActor === "owner_agent" ? ownerBudget : chartererBudget;
    const spent = yieldingActor === "owner_agent" ? ownerSpent : chartererSpent;
    let reason: HeldFirmRecord["reason"];
    if (stops.has(item.finding.category)) reason = "hard_stop";
    else if (spent.plus(d(item.finding.deltaNet).abs()).gt(budget)) reason = "budget_exhausted";
    else reason = "rounds_exhausted";
    heldFirm.push({
      actor: yieldingActor,
      category: item.finding.category,
      label: item.finding.label,
      reason,
    });
  }

  const gap = ownerAsk.minus(chartererOffer);
  const recommended = ownerAsk.plus(chartererOffer).div(2);

  // Probability heuristic: share of the opening gap the agents closed,
  // mapped into [0.05, 0.95].
  const openingGap = ownerOpening.minus(chartererOpening);
  let closedShare: Decimal;
  if (openingGap.lte(0)) closedShare = d(1);
  else closedShare = Decimal.max(d(0), Decimal.min(d(1), d(1).minus(Decimal.max(gap, d(0)).div(openingGap))));
  const probability = d(0.05).plus(closedShare.mul(0.9)).toDecimalPlaces(4).toNumber();

  return {
    claimId,
    currency: input.cpTerms.currency,
    baselineNet: report.baselineNet,
    ownerOpening: money(ownerOpening),
    chartererOpening: money(chartererOpening),
    ownerFinal: money(ownerAsk),
    chartererFinal: money(chartererOffer),
    gap: money(gap),
    recommendedSettlement: money(recommended),
    roundsCompleted: rounds,
    maxRounds,
    converged,
    settlementProbability: probability,
    disputedValue: money(disputedValue),
    concessions,
    heldFirm,
  };
}
