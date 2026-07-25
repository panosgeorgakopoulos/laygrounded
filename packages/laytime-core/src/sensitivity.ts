// Dispute sensitivity analysis — the claim's "attack surface".
//
// For every event on the timeline, simulate the amendments a counterparty
// would realistically argue (NOR accepted later, completion earlier, weather
// lasting longer) and the counters an owner could push (weather disproven by
// evidence, excepted periods struck out), then rank every point by how much
// money it moves. The output tells an owner where their claim is weakest
// BEFORE the charterer finds it — and which disputes are simply worthless.
//
// Pure TypeScript on top of the deterministic engine: every finding is an
// engine run, not an opinion.

import { Decimal } from "decimal.js";
import { recomputeLaytime } from "./gencon94";
import { CpTerms, EventTypeEnum, SofEventInput } from "./types";

export interface SensitivityFinding {
  id: string;
  category: "nor" | "completion" | "weather" | "shifting" | "excepted";
  // The argument in plain words, e.g. "NOR held invalid until 3h later".
  label: string;
  eventIds: string[];
  // Perturbed net − baseline net, owner's perspective (net = demurrage − despatch).
  deltaNet: number;
  perturbedNet: number;
}

export interface SensitivityReport {
  baselineNet: number;
  currency: string;
  computedPerturbations: number;
  // deltaNet < 0: points a counterparty can attack. Sorted worst-first.
  vulnerabilities: SensitivityFinding[];
  // deltaNet > 0: points the owner could push. Sorted best-first.
  opportunities: SensitivityFinding[];
  // The single most damaging concession — the claim's weakest point.
  maxSingleLoss: number;
}

const HOUR_MS = 3600_000;
const MIN_MATERIAL_DELTA = 0.005;

function net(events: SofEventInput[], cpTerms: CpTerms): Decimal | null {
  try {
    const r = recomputeLaytime(events, cpTerms);
    return new Decimal(r.totals.demurrage_amount).minus(r.totals.despatch_amount);
  } catch {
    return null;
  }
}

function shiftEvent(events: SofEventInput[], id: string, hours: number): SofEventInput[] {
  return events.map((e) =>
    e.id === id
      ? { ...e, occurred_at: new Date(new Date(e.occurred_at).getTime() + hours * HOUR_MS).toISOString() }
      : e
  );
}

function removeIds(events: SofEventInput[], ids: string[]): SofEventInput[] {
  return events.filter((e) => !ids.includes(e.id));
}

export interface EventPair {
  startId: string;
  endId: string | null; // open interval
}

// Pairs start/end events keeping their ids — mirrors the engine's interval
// pairing so perturbations hit exactly what the engine would exclude.
// Exported because the ROI report strikes individual disputed weather windows
// and must pair them the same way this module does; two pairing rules would
// mean two different answers to "what does this window cost?".
export function findPairs(
  events: SofEventInput[],
  startType: EventTypeEnum,
  endType: EventTypeEnum
): EventPair[] {
  const relevant = events
    .filter((e) => e.event_type === startType || e.event_type === endType)
    .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  const pairs: EventPair[] = [];
  let open: string | null = null;
  for (const e of relevant) {
    if (e.event_type === startType) {
      if (!open) open = e.id;
    } else if (open) {
      pairs.push({ startId: open, endId: e.id });
      open = null;
    }
  }
  if (open) pairs.push({ startId: open, endId: null });
  return pairs;
}

interface Candidate {
  category: SensitivityFinding["category"];
  label: string;
  eventIds: string[];
  events: SofEventInput[];
}

export function analyzeSensitivity(
  events: SofEventInput[],
  cpTerms: CpTerms
): SensitivityReport {
  const baseline = net(events, cpTerms);
  if (baseline === null) {
    // Baseline itself doesn't compute (no NOR etc.) — nothing to analyze.
    throw new Error("NO_NOR");
  }

  const candidates: Candidate[] = [];

  // --- NOR validity: charterer argues acceptance/validity N hours later ---
  const nor = events.find((e) => e.event_type === "NOR_TENDERED");
  if (nor) {
    for (const h of [1, 3, 6]) {
      candidates.push({
        category: "nor",
        label: `NOR held invalid until ${h}h later`,
        eventIds: [nor.id],
        events: shiftEvent(events, nor.id, h),
      });
    }
  }

  // --- Completion: charterer argues cargo work finished earlier ---
  for (const e of events) {
    if (e.event_type === "COMPLETED_LOADING" || e.event_type === "COMPLETED_DISCHARGE") {
      for (const h of [1, 3, 6]) {
        candidates.push({
          category: "completion",
          label: `Completion recorded ${h}h earlier`,
          eventIds: [e.id],
          events: shiftEvent(events, e.id, -h),
        });
      }
    }
  }

  // --- Weather: both directions ---
  for (const pair of findPairs(events, "WEATHER_DELAY", "WEATHER_DELAY_END")) {
    if (pair.endId) {
      for (const h of [3, 6]) {
        candidates.push({
          category: "weather",
          label: `Weather delay extended by ${h}h`,
          eventIds: [pair.endId],
          events: shiftEvent(events, pair.endId, h),
        });
      }
    }
    candidates.push({
      category: "weather",
      label: "Weather delay struck out (disproven by evidence)",
      eventIds: [pair.startId, pair.endId].filter(Boolean) as string[],
      events: removeIds(events, [pair.startId, pair.endId].filter(Boolean) as string[]),
    });
  }

  // --- Shifting: longer delay getting to berth / struck out ---
  for (const pair of findPairs(events, "SHIFTING", "SHIFTING_END")) {
    if (pair.endId) {
      candidates.push({
        category: "shifting",
        label: "Shifting prolonged by 2h",
        eventIds: [pair.endId],
        events: shiftEvent(events, pair.endId, 2),
      });
    }
    candidates.push({
      category: "shifting",
      label: "Shifting period struck out",
      eventIds: [pair.startId, pair.endId].filter(Boolean) as string[],
      events: removeIds(events, [pair.startId, pair.endId].filter(Boolean) as string[]),
    });
  }

  // --- Excepted periods (strikes, stoppages): extended / struck out ---
  for (const pair of findPairs(events, "EXCEPTED_PERIOD_START", "EXCEPTED_PERIOD_END")) {
    if (pair.endId) {
      candidates.push({
        category: "excepted",
        label: "Excepted period extended by 6h",
        eventIds: [pair.endId],
        events: shiftEvent(events, pair.endId, 6),
      });
    }
    candidates.push({
      category: "excepted",
      label: "Excepted period struck out",
      eventIds: [pair.startId, pair.endId].filter(Boolean) as string[],
      events: removeIds(events, [pair.startId, pair.endId].filter(Boolean) as string[]),
    });
  }

  // --- Evaluate every candidate against the engine ---
  const vulnerabilities: SensitivityFinding[] = [];
  const opportunities: SensitivityFinding[] = [];
  let counter = 0;

  for (const c of candidates) {
    counter++;
    const perturbed = net(c.events, cpTerms);
    if (perturbed === null) continue; // perturbation made the claim incomputable
    const delta = perturbed.minus(baseline);
    if (delta.abs().lessThan(MIN_MATERIAL_DELTA)) continue; // immaterial — dispute is worthless

    const finding: SensitivityFinding = {
      id: `s${counter}`,
      category: c.category,
      label: c.label,
      eventIds: c.eventIds,
      deltaNet: delta.toDecimalPlaces(2).toNumber(),
      perturbedNet: perturbed.toDecimalPlaces(2).toNumber(),
    };
    if (delta.isNegative()) vulnerabilities.push(finding);
    else opportunities.push(finding);
  }

  vulnerabilities.sort((a, b) => a.deltaNet - b.deltaNet);
  opportunities.sort((a, b) => b.deltaNet - a.deltaNet);

  return {
    baselineNet: baseline.toDecimalPlaces(2).toNumber(),
    currency: cpTerms.currency,
    computedPerturbations: counter,
    vulnerabilities,
    opportunities,
    maxSingleLoss: vulnerabilities[0]?.deltaNet ?? 0,
  };
}
