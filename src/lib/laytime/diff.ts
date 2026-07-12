// Scenario diffing for claim negotiations — the "redline for laytime".
// Pure TypeScript like the engine itself: takes a baseline event set plus a
// list of proposed amendments, runs the deterministic engine on both versions,
// and reports exactly how the money moves. No I/O.

import { Decimal } from "decimal.js";
import { recomputeLaytime } from "./gencon94";
import { CpTerms, LaytimeResult, SofEventInput, EventTypeEnum } from "./types";

export interface ProposalInput {
  id: string;
  action: "amend" | "add" | "remove";
  event_id: string | null;
  proposed_occurred_at: string | null;
  proposed_event_type: string | null;
}

export interface ScenarioDelta {
  used_hours: number;
  demurrage_amount: number;
  despatch_amount: number;
  // Positive = the amendments increase what the owner is owed;
  // negative = they move money toward the charterer.
  net_amount: number;
}

export interface ScenarioDiff {
  baseline: LaytimeResult | null;
  amended: LaytimeResult | null;
  baselineError: string | null;
  amendedError: string | null;
  delta: ScenarioDelta | null;
}

// Applies proposals to a copy of the baseline events. Unknown event_ids and
// malformed proposals are skipped rather than thrown — a stale proposal must
// never take down the comparison for everyone else.
export function applyProposals(
  events: SofEventInput[],
  proposals: ProposalInput[]
): SofEventInput[] {
  let amended = events.map((e) => ({ ...e }));

  for (const p of proposals) {
    if (p.action === "remove" && p.event_id) {
      amended = amended.filter((e) => e.id !== p.event_id);
    } else if (p.action === "amend" && p.event_id) {
      const target = amended.find((e) => e.id === p.event_id);
      if (target) {
        if (p.proposed_occurred_at) target.occurred_at = p.proposed_occurred_at;
        if (p.proposed_event_type) target.event_type = p.proposed_event_type as EventTypeEnum;
      }
    } else if (p.action === "add" && p.proposed_occurred_at && p.proposed_event_type) {
      amended.push({
        id: `proposal-${p.id}`,
        occurred_at: p.proposed_occurred_at,
        event_type: p.proposed_event_type as EventTypeEnum,
      });
    }
  }

  amended.sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );
  return amended;
}

function safeCompute(
  events: SofEventInput[],
  cpTerms: CpTerms
): { result: LaytimeResult | null; error: string | null } {
  try {
    return { result: recomputeLaytime(events, cpTerms), error: null };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// Net position from the owner's perspective: demurrage receivable minus
// despatch payable.
function netAmount(r: LaytimeResult): Decimal {
  return new Decimal(r.totals.demurrage_amount).minus(r.totals.despatch_amount);
}

export function diffScenarios(
  events: SofEventInput[],
  cpTerms: CpTerms,
  proposals: ProposalInput[]
): ScenarioDiff {
  const base = safeCompute(events, cpTerms);
  const amendedEvents = applyProposals(events, proposals);
  const amended = safeCompute(amendedEvents, cpTerms);

  let delta: ScenarioDelta | null = null;
  if (base.result && amended.result) {
    delta = {
      used_hours: new Decimal(amended.result.totals.used_hours)
        .minus(base.result.totals.used_hours)
        .toNumber(),
      demurrage_amount: new Decimal(amended.result.totals.demurrage_amount)
        .minus(base.result.totals.demurrage_amount)
        .toDecimalPlaces(2)
        .toNumber(),
      despatch_amount: new Decimal(amended.result.totals.despatch_amount)
        .minus(base.result.totals.despatch_amount)
        .toDecimalPlaces(2)
        .toNumber(),
      net_amount: netAmount(amended.result)
        .minus(netAmount(base.result))
        .toDecimalPlaces(2)
        .toNumber(),
    };
  }

  return {
    baseline: base.result,
    amended: amended.result,
    baselineError: base.error,
    amendedError: amended.error,
    delta,
  };
}
