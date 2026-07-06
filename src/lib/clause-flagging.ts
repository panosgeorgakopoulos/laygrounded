// Clause flagging engine for LayGrounded.
// Second LLM-equivalent pass over accepted sof_events for a claim.
// Maps ambiguous events to clause_flags rows per the spec's trigger rules.
// Bundles GENCON 94 clause reference text server-side (no network fetch).

import { db } from "@/lib/db";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import { CpTerms, SofEventInput } from "@/lib/laytime/types";

// === Bundled GENCON 94 reference text (server-side, no network) ===
export const GENCON94_REFERENCE: Record<string, string> = {
  "GENCON94-6":
    "Clause 6 — Commenc of Laytime. Laytime shall commence at the time the Notice of Readiness is accepted, plus any agreed turn time.",
  "GENCON94-6c":
    "Clause 6(c) — Notice of Readiness at anchorage. WIBON: NOR valid before berthing; shifting thereafter counts as laytime. Other variants exclude shifting.",
  "GENCON94-7":
    "Clause 7 — Laytime calculation. Time used for loading/discharge is counted from commencement to completion.",
  "GENCON94-7(b)":
    "Clause 7(b) — SHINC. Sundays and holidays included in laytime.",
  "GENCON94-7(c)":
    "Clause 7(c) — SHEX. Sundays and holidays excepted from laytime unless used.",
  "GENCON94-7(d)":
    "Clause 7(d) — SHEX-UU. Sundays and holidays excepted unless used: when hatch open and operations ongoing, time counts.",
  "GENCON94-8":
    "Clause 8 — Demurrage. Once allowed laytime is exhausted, demurrage runs continuously at the agreed rate per day, pro rata for part of a day. Weather, weekends, shifting do not interrupt demurrage.",
};

// === Flag trigger rules (per spec) ===
type Severity = "info" | "warning" | "critical";

interface FlagRule {
  clauseRef: string;
  severity: Severity;
  note: string;
  eventId: string;
}

// Detect: NOR_TENDERED at anchorage, not berth → GENCON94-6c, severity info.
function detectNorAtAnchorage(
  events: Array<{ id: string; eventType: string; occurredAt: Date }>,
  norVariant: string
): FlagRule[] {
  const nor = events.find((e) => e.eventType === "NOR_TENDERED");
  if (!nor) return [];
  // If a SHIFTING or BERTHED event follows NOR before ALL_FAST, NOR was at anchorage.
  const allFast = events.find((e) => e.eventType === "ALL_FAST");
  const shifting = events.find((e) => e.eventType === "SHIFTING");
  const berthed = events.find((e) => e.eventType === "BERTHED");
  const atAnchorage =
    (shifting && allFast && shifting.occurredAt < allFast.occurredAt) ||
    (berthed && allFast && berthed.occurredAt < allFast.occurredAt) ||
    !allFast;
  if (!atAnchorage) return [];
  return [
    {
      clauseRef: "GENCON94-6c",
      severity: "info",
      note: `NOR tendered at anchorage (not berth). Variant: ${norVariant}. Berthing required before operations can begin.`,
      eventId: nor.id,
    },
  ];
}

// Detect: SHIFTING between NOR_TENDERED and ALL_FAST → GENCON94-6c, warning.
function detectShiftingBeforeAllFast(
  events: Array<{ id: string; eventType: string; occurredAt: Date }>
): FlagRule[] {
  const nor = events.find((e) => e.eventType === "NOR_TENDERED");
  const allFast = events.find((e) => e.eventType === "ALL_FAST");
  const shifting = events.find(
    (e) =>
      e.eventType === "SHIFTING" &&
      nor &&
      allFast &&
      e.occurredAt > nor.occurredAt &&
      e.occurredAt < allFast.occurredAt
  );
  if (!shifting) return [];
  return [
    {
      clauseRef: "GENCON94-6c",
      severity: "warning",
      note: "Shifting between NOR and ALL_FAST — verify whether time counts under the agreed NOR variant.",
      eventId: shifting.id,
    },
  ];
}

// Detect: COMMENCED_LOADING on Sunday/Holiday → GENCON94-7, warning.
function detectSundayLoading(
  events: Array<{ id: string; eventType: string; occurredAt: Date }>
): FlagRule[] {
  const flags: FlagRule[] = [];
  for (const e of events) {
    if (e.eventType !== "COMMENCED_LOADING" && e.eventType !== "COMMENCED_DISCHARGE") continue;
    const day = e.occurredAt.getUTCDay();
    if (day === 0) {
      flags.push({
        clauseRef: "GENCON94-7",
        severity: "warning",
        note: `${e.eventType.replace(/_/g, " ")} commenced on Sunday — verify SHEX/SHEX-UU treatment.`,
        eventId: e.id,
      });
    }
  }
  return flags;
}

// Detect: used_hours >= allowed_hours → GENCON94-8, critical.
function detectOnDemurrage(
  events: Array<{ id: string; eventType: string; occurredAt: Date }>,
  cpTerms: CpTerms
): FlagRule[] {
  const sofInputs: SofEventInput[] = events.map((e) => ({
    id: e.id,
    occurred_at: e.occurredAt.toISOString(),
    event_type: e.eventType as any,
  }));
  try {
    const result = recomputeLaytime(sofInputs, cpTerms);
    if (result.totals.used_hours >= cpTerms.laytime_allowed_hours) {
      // Attach to NOR event (or first event) — flag refers to whole claim.
      const nor = events.find((e) => e.eventType === "NOR_TENDERED");
      return [
        {
          clauseRef: "GENCON94-8",
          severity: "critical",
          note: `On demurrage — used ${result.totals.used_hours.toFixed(1)}h exceeds allowed ${cpTerms.laytime_allowed_hours}h. Demurrage amount: ${result.totals.currency} ${result.totals.demurrage_amount.toFixed(2)}.`,
          eventId: nor?.id ?? events[0]?.id,
        },
      ];
    }
  } catch {
    // ignore
  }
  return [];
}

// Detect: WEATHER_DELAY active simultaneously with HATCH_OPEN + active loading → critical.
function detectWeatherHatchConflict(
  events: Array<{ id: string; eventType: string; occurredAt: Date }>
): FlagRule[] {
  const weather = events.filter((e) => e.eventType === "WEATHER_DELAY");
  const hatchOpen = events.find((e) => e.eventType === "HATCH_OPEN");
  const hatchClose = events.find((e) => e.eventType === "HATCH_CLOSE");
  const commencedL = events.find((e) => e.eventType === "COMMENCED_LOADING");
  const completedL = events.find((e) => e.eventType === "COMPLETED_LOADING");
  if (!weather.length || !hatchOpen || !commencedL) return [];
  const openEnd = hatchClose ? hatchClose.occurredAt : new Date(8.64e15);
  const loadEnd = completedL ? completedL.occurredAt : new Date(8.64e15);
  for (const w of weather) {
    const wEnd = new Date(w.occurredAt.getTime() + 2 * 3600_000); // assume 2h weather duration
    const weatherDuringHatchAndLoading =
      w.occurredAt >= hatchOpen.occurredAt &&
      w.occurredAt < openEnd &&
      w.occurredAt >= commencedL.occurredAt &&
      w.occurredAt < loadEnd;
    if (weatherDuringHatchAndLoading) {
      return [
        {
          clauseRef: "GENCON94-6c",
          severity: "critical",
          note: "Conflicting facts: weather delay reported while hatch open and loading active — verify whether work actually stopped.",
          eventId: w.id,
        },
      ];
    }
  }
  return [];
}

// === Public entrypoint ===
export async function flagClauses(claimId: string, cpTerms: CpTerms) {
  // Fetch accepted events for the claim.
  const events = await db.sofEvent.findMany({
    where: { claimId, status: { in: ["accepted", "edited"] } },
    orderBy: { occurredAt: "asc" },
  });
  if (events.length === 0) return [];

  // Clear previous flags (re-flag from scratch each time).
  await db.clauseFlag.deleteMany({
    where: { eventId: { in: events.map((e) => e.id) } },
  });

  const typedEvents = events.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    occurredAt: e.occurredAt,
  }));

  // Apply all rules.
  const rules: FlagRule[] = [
    ...detectNorAtAnchorage(typedEvents, cpTerms.nor_variant),
    ...detectShiftingBeforeAllFast(typedEvents),
    ...detectSundayLoading(typedEvents),
    ...detectOnDemurrage(typedEvents, cpTerms),
    ...detectWeatherHatchConflict(typedEvents),
  ];

  // Write flags.
  const created = [];
  for (const r of rules) {
    const flag = await db.clauseFlag.create({
      data: {
        eventId: r.eventId,
        clauseRef: r.clauseRef,
        severity: r.severity,
        note: r.note,
      },
    });
    created.push(flag);
  }
  return created;
}
