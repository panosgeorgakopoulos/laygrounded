// SoF gap detection — the input side of auto-chasing.
//
// The single most common reason a claim sits uncomputed is not a disagreement
// about the rules; it is that nobody has the Statement of Facts yet, or the one
// they have is missing the milestone the calculation turns on. Today that is
// discovered when somebody opens the claim and finds it will not compute. This
// module finds it from the event set alone, so a sweep can ask the port agent
// for the missing pieces by name.
//
// Pure, and deliberately conservative: a voyage in progress is *supposed* to
// have no completion event, so a gap is only reported once the event set has
// gone quiet (`staleAfterHours`). Chasing an agent for a milestone that has not
// happened yet is how an automated chaser gets muted by its recipients.

export type GapKey =
  | "no_events"
  | "missing_nor"
  | "missing_berthing"
  | "missing_commencement"
  | "missing_completion"
  | "unpaired_weather"
  | "unpaired_shifting"
  | "unpaired_excepted";

export type GapSeverity = "blocking" | "material" | "minor";

export interface SofGap {
  key: GapKey;
  severity: GapSeverity;
  /** What is missing, in the operator's language. */
  label: string;
  /** What to ask the agent for — becomes the body of the chase request. */
  ask: string;
  /** ISO timestamp the gap hangs off, when there is one (e.g. an unclosed start). */
  since: string | null;
}

export interface SofGapInput {
  /** Confirmed (accepted/edited) events only. A suggested event is not a fact. */
  events: Array<{ event_type: string; occurred_at: string }>;
  /** ISO 8601. Injected — this module never reads a clock. */
  now: string;
  /**
   * How long the event set must have been quiet before an absent milestone
   * counts as missing rather than merely "not yet".
   */
  staleAfterHours?: number;
}

export interface SofGapReport {
  gaps: SofGap[];
  /** True when at least one gap prevents the engine from producing a figure. */
  blocking: boolean;
  /** Hours since the most recent confirmed event; null when there are none. */
  quietForHours: number | null;
  /**
   * Stable identity for this set of gaps. A sweep uses it to tell "the same
   * gap, still open" (do not chase again) from "a different gap" (worth a new
   * request). Order-independent, so re-running on reordered rows is identical.
   */
  signature: string;
}

/** Two days of silence. Shorter chases agents mid-operation; much longer and
 *  the claim is already drifting toward its time bar before anyone asks. */
export const DEFAULT_STALE_AFTER_HOURS = 48;

const MS_PER_HOUR = 3_600_000;

const COMPLETION = ["COMPLETED_LOADING", "COMPLETED_DISCHARGE"];
const COMMENCEMENT = ["COMMENCED_LOADING", "COMMENCED_DISCHARGE"];
const BERTHING = ["BERTHED", "ALL_FAST"];

/** Interruption events that must be closed by a matching end event. */
const PAIRS: Array<{ start: string; end: string; key: GapKey; label: string; ask: string }> = [
  {
    start: "WEATHER_DELAY",
    end: "WEATHER_DELAY_END",
    key: "unpaired_weather",
    label: "Weather stoppage never closed",
    ask: "the time cargo operations resumed after the weather stoppage",
  },
  {
    start: "SHIFTING",
    end: "SHIFTING_END",
    key: "unpaired_shifting",
    label: "Shifting never closed",
    ask: "the time the vessel was all fast after shifting",
  },
  {
    start: "EXCEPTED_PERIOD_START",
    end: "EXCEPTED_PERIOD_END",
    key: "unpaired_excepted",
    label: "Excepted period never closed",
    ask: "the time the excepted period ended",
  },
];

function msOf(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Unclosed interruption starts. Interruptions nest in practice (a second
 * weather stoppage can be logged before the first is closed), so ends are
 * matched against starts in chronological order and any surplus starts are the
 * gaps — the same pairing discipline the engine uses.
 */
function unpairedStarts(
  events: Array<{ event_type: string; occurred_at: string }>,
  startType: string,
  endType: string
): string[] {
  const starts = events
    .filter((e) => e.event_type === startType)
    .map((e) => e.occurred_at)
    .sort((a, b) => msOf(a) - msOf(b));
  const endCount = events.filter((e) => e.event_type === endType).length;
  return starts.slice(endCount);
}

export function detectSofGaps(input: SofGapInput): SofGapReport {
  const staleAfter = input.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS;
  const nowMs = msOf(input.now);
  const events = input.events;

  const latestMs = events.length
    ? Math.max(...events.map((e) => msOf(e.occurred_at)))
    : null;
  const quietForHours =
    latestMs === null ? null : Math.round(((nowMs - latestMs) / MS_PER_HOUR) * 100) / 100;
  const isStale = quietForHours !== null && quietForHours >= staleAfter;

  const gaps: SofGap[] = [];
  const has = (types: string[]) => events.some((e) => types.includes(e.event_type));

  if (events.length === 0) {
    gaps.push({
      key: "no_events",
      severity: "blocking",
      label: "No statement of facts on file",
      ask: "the signed Statement of Facts for this call",
      since: null,
    });
  } else {
    // NOR is reported missing regardless of staleness: without it the engine
    // throws rather than returning a figure, so there is nothing to wait for.
    if (!has(["NOR_TENDERED"])) {
      gaps.push({
        key: "missing_nor",
        severity: "blocking",
        label: "NOR not recorded",
        ask: "the date and time Notice of Readiness was tendered, and to whom",
        since: null,
      });
    }

    // The rest are only gaps once the record has gone quiet — a live voyage
    // legitimately has no completion event yet.
    if (isStale) {
      if (has(COMMENCEMENT) && !has(COMPLETION)) {
        const startedAt = events
          .filter((e) => COMMENCEMENT.includes(e.event_type))
          .map((e) => e.occurred_at)
          .sort((a, b) => msOf(a) - msOf(b))[0];
        gaps.push({
          key: "missing_completion",
          severity: "blocking",
          label: "Cargo operations never closed",
          ask: "the date and time cargo operations completed",
          since: startedAt ?? null,
        });
      }
      if (has(["NOR_TENDERED"]) && !has(COMMENCEMENT)) {
        gaps.push({
          key: "missing_commencement",
          severity: "material",
          label: "Cargo operations never started",
          ask: "the date and time cargo operations commenced",
          since: null,
        });
      }
      // Not blocking: the engine computes without it, but the NOR-to-berth
      // period is the most disputed stretch of any claim, so an absent
      // berthing time is worth asking for before the counterparty asks first.
      if (has(COMMENCEMENT) && !has(BERTHING)) {
        gaps.push({
          key: "missing_berthing",
          severity: "minor",
          label: "Berthing time not recorded",
          ask: "the date and time the vessel berthed and was all fast",
          since: null,
        });
      }
    }
  }

  // Unclosed interruptions are always reported: the engine runs them to the end
  // of the window, so an unpaired start silently inflates or deflates the
  // result rather than failing loudly. Staleness is irrelevant to that.
  for (const p of PAIRS) {
    for (const since of unpairedStarts(events, p.start, p.end)) {
      gaps.push({
        key: p.key,
        severity: "material",
        label: p.label,
        ask: p.ask,
        since,
      });
    }
  }

  // Order-independent signature: sorted "key@since" pairs. Two sweeps over the
  // same facts produce the same string even if the rows come back reordered.
  const signature = gaps
    .map((g) => `${g.key}@${g.since ?? "-"}`)
    .sort()
    .join("|");

  return {
    gaps,
    blocking: gaps.some((g) => g.severity === "blocking"),
    quietForHours,
    signature,
  };
}
