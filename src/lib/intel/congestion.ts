// Port waiting-time & congestion index — pure aggregation and privacy floors.
//
// Every claim in the system carries a NOR timestamp and a berthing timestamp.
// The gap between them is how long that vessel waited, and nobody publishes
// that: port authorities report throughput, not queues, and the commercial
// waiting-time series that exist are expensive and thin. It is a by-product we
// already hold, and it gets better with every claim.
//
// This module is the privacy boundary as much as the maths. The source view
// spans every tenant and carries company ids; nothing here may return one, and
// no cell may be published unless it is anonymous under BOTH floors below.
//
// Pure — the caller reads `port_congestion_stats` with the service-role client
// and passes rows in.

import { percentile } from "@/lib/oracle/pricing";

/**
 * Minimum voyages before a cell may be published.
 *
 * Below this a "median" is one or two voyages wearing a statistic's clothes,
 * and a reader who knows of a single call at that port can back out its wait.
 */
export const MIN_VOYAGES = 5;

/**
 * Minimum DISTINCT companies contributing to a cell.
 *
 * The floor that a voyage count cannot provide on its own: five voyages that
 * all belong to one charterer is that charterer's private operating data
 * republished with a port's name on it. Two companies is not enough either —
 * each can then subtract its own voyages to recover the other's.
 */
export const MIN_COMPANIES = 3;

export interface CongestionSample {
  portKey: string;
  portLabel: string;
  companyId: string;
  year: number;
  month: number;
  waitingHours: number;
  workingHours: number | null;
}

export type SuppressionReason = "too_few_voyages" | "too_few_companies";

export interface CongestionCell {
  portKey: string;
  portLabel: string;
  year: number;
  month: number;
  /** Null whenever the cell is suppressed — a count is still information. */
  voyages: number | null;
  medianWaitingHours: number | null;
  p90WaitingHours: number | null;
  medianWorkingHours: number | null;
  suppressed: boolean;
  suppressionReason: SuppressionReason | null;
}

export type CongestionTrend = "rising" | "easing" | "steady" | "unknown";

export interface PortCongestionSummary {
  portKey: string;
  portLabel: string;
  /** Most recent publishable cell. Null when nothing at this port qualifies. */
  latest: CongestionCell | null;
  /** Publishable history, newest first. */
  history: CongestionCell[];
  trend: CongestionTrend;
  /** Latest median against the median of the preceding publishable cells. */
  changeVsPriorPct: number | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Chronological key, newest-first when sorted descending. */
function periodKey(year: number, month: number): number {
  return year * 12 + month;
}

/**
 * Groups samples into (port, year, month) cells and applies both privacy floors.
 *
 * Suppressed cells are RETAINED in the output rather than dropped, so a caller
 * can honestly say "this port has data but not enough to publish" instead of
 * silently implying the port has no traffic.
 */
export function buildCongestionCells(samples: CongestionSample[]): CongestionCell[] {
  const groups = new Map<string, CongestionSample[]>();
  for (const s of samples) {
    const key = `${s.portKey}|${s.year}|${s.month}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }

  const cells: CongestionCell[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0];
    const companies = new Set(bucket.map((s) => s.companyId));

    // Voyage count is checked first so the reason names the more basic failure
    // when a cell misses both floors.
    let reason: SuppressionReason | null = null;
    if (bucket.length < MIN_VOYAGES) reason = "too_few_voyages";
    else if (companies.size < MIN_COMPANIES) reason = "too_few_companies";

    if (reason) {
      cells.push({
        portKey: first.portKey,
        portLabel: first.portLabel,
        year: first.year,
        month: first.month,
        voyages: null,
        medianWaitingHours: null,
        p90WaitingHours: null,
        medianWorkingHours: null,
        suppressed: true,
        suppressionReason: reason,
      });
      continue;
    }

    const waits = bucket.map((s) => s.waitingHours).sort((a, b) => a - b);
    const works = bucket
      .map((s) => s.workingHours)
      .filter((h): h is number => h !== null && Number.isFinite(h))
      .sort((a, b) => a - b);

    cells.push({
      portKey: first.portKey,
      portLabel: first.portLabel,
      year: first.year,
      month: first.month,
      voyages: bucket.length,
      medianWaitingHours: round1(percentile(waits, 0.5)),
      p90WaitingHours: round1(percentile(waits, 0.9)),
      // Working hours are optional per voyage; the same floors already passed on
      // the cell, but a cell can still lack enough completions to be meaningful.
      medianWorkingHours: works.length >= MIN_VOYAGES ? round1(percentile(works, 0.5)) : null,
      suppressed: false,
      suppressionReason: null,
    });
  }

  return cells.sort(
    (a, b) =>
      periodKey(b.year, b.month) - periodKey(a.year, a.month) ||
      a.portKey.localeCompare(b.portKey),
  );
}

// Below this relative move, a change is noise rather than a trend worth naming.
const TREND_THRESHOLD_PCT = 10;

/**
 * Rolls cells up per port into the nowcast: latest publishable figure, the
 * publishable history, and whether waiting is rising or easing against it.
 */
export function summarizePorts(cells: CongestionCell[]): PortCongestionSummary[] {
  const byPort = new Map<string, CongestionCell[]>();
  for (const c of cells) {
    const bucket = byPort.get(c.portKey);
    if (bucket) bucket.push(c);
    else byPort.set(c.portKey, [c]);
  }

  const summaries: PortCongestionSummary[] = [];
  for (const [portKey, portCells] of byPort) {
    const ordered = [...portCells].sort(
      (a, b) => periodKey(b.year, b.month) - periodKey(a.year, a.month),
    );
    const publishable = ordered.filter((c) => !c.suppressed);
    const latest = publishable[0] ?? null;
    const prior = publishable.slice(1);

    let trend: CongestionTrend = "unknown";
    let changeVsPriorPct: number | null = null;

    if (latest?.medianWaitingHours != null && prior.length > 0) {
      const priorMedians = prior
        .map((c) => c.medianWaitingHours)
        .filter((h): h is number => h !== null)
        .sort((a, b) => a - b);

      if (priorMedians.length > 0) {
        const baselineMedian = percentile(priorMedians, 0.5);
        if (baselineMedian > 0) {
          const pct = ((latest.medianWaitingHours - baselineMedian) / baselineMedian) * 100;
          changeVsPriorPct = Math.round(pct);
          if (pct > TREND_THRESHOLD_PCT) trend = "rising";
          else if (pct < -TREND_THRESHOLD_PCT) trend = "easing";
          else trend = "steady";
        }
      }
    }

    summaries.push({
      portKey,
      portLabel: ordered[0].portLabel,
      latest,
      history: publishable,
      trend,
      changeVsPriorPct,
    });
  }

  // Busiest ports first — a congestion index is read for where the queues are.
  // Ports with nothing publishable sort last rather than disappearing.
  return summaries.sort((a, b) => {
    const aw = a.latest?.medianWaitingHours ?? -1;
    const bw = b.latest?.medianWaitingHours ?? -1;
    return bw - aw || a.portKey.localeCompare(b.portKey);
  });
}
