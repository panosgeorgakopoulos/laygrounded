// Time-bar tracking and claim-pack completeness.
//
// Most demurrage claims die procedurally, not on the merits: charterparties
// bar claims not presented with full supporting documents within a fixed
// window (commonly 90, sometimes 60 or even 30 days) after completion of
// discharge. This module turns that into a computed countdown plus a
// completeness checklist, from data the caller already has — pure functions,
// no I/O, mirroring the engine's style.

export type TimeBarState = "no_anchor" | "ok" | "warning" | "critical" | "expired";

export interface CompletenessItem {
  key: string;
  label: string;
  ok: boolean;
}

export interface TimeBarStatus {
  timeBarDays: number;
  // Completion of cargo operations — the clock's anchor. Null until a
  // completion event is confirmed.
  anchorEventAt: string | null;
  deadline: string | null;
  daysRemaining: number | null;
  state: TimeBarState;
  completeness: CompletenessItem[];
  complete: boolean;
}

export interface TimeBarInputs {
  timeBarDays: number;
  // Confirmed (accepted/edited) events only — a suggested event the owner
  // hasn't reviewed cannot anchor a legal deadline.
  events: Array<{ event_type: string; occurred_at: string }>;
  hasSofDocument: boolean;
  hasValidCpTerms: boolean;
  hasCalculation: boolean;
  now?: Date;
}

const WARNING_DAYS = 21;
const CRITICAL_DAYS = 7;
const MS_PER_DAY = 24 * 3600_000;

export function computeTimeBar(inputs: TimeBarInputs): TimeBarStatus {
  const now = inputs.now ?? new Date();

  const completions = inputs.events
    .filter(
      (e) =>
        e.event_type === "COMPLETED_DISCHARGE" || e.event_type === "COMPLETED_LOADING"
    )
    .map((e) => new Date(e.occurred_at))
    .filter((d) => !isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  const anchor = completions[completions.length - 1] ?? null;

  const hasNor = inputs.events.some((e) => e.event_type === "NOR_TENDERED");
  const completeness: CompletenessItem[] = [
    { key: "sof_document", label: "Statement of Facts uploaded", ok: inputs.hasSofDocument },
    { key: "nor_event", label: "NOR tendered event confirmed", ok: hasNor },
    { key: "completion_event", label: "Completion of cargo operations confirmed", ok: anchor !== null },
    { key: "cp_terms", label: "CP terms complete and valid", ok: inputs.hasValidCpTerms },
    { key: "calculation", label: "Laytime calculation computed", ok: inputs.hasCalculation },
  ];
  const complete = completeness.every((c) => c.ok);

  if (!anchor) {
    return {
      timeBarDays: inputs.timeBarDays,
      anchorEventAt: null,
      deadline: null,
      daysRemaining: null,
      state: "no_anchor",
      completeness,
      complete,
    };
  }

  const deadline = new Date(anchor.getTime() + inputs.timeBarDays * MS_PER_DAY);
  const daysRemaining = Math.floor((deadline.getTime() - now.getTime()) / MS_PER_DAY);

  let state: TimeBarState = "ok";
  if (daysRemaining < 0) state = "expired";
  else if (daysRemaining <= CRITICAL_DAYS) state = "critical";
  else if (daysRemaining <= WARNING_DAYS) state = "warning";

  return {
    timeBarDays: inputs.timeBarDays,
    anchorEventAt: anchor.toISOString(),
    deadline: deadline.toISOString(),
    daysRemaining,
    state,
    completeness,
    complete,
  };
}
