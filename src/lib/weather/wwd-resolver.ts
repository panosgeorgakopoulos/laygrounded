// The Weather Working Day resolver.
//
// The #1 demurrage dispute is not arithmetic, it is "was it raining hard enough
// to stop work". Today that is settled by two parties reading the same Master's
// remark differently. This resolves it from measurements: hourly archive
// readings against a threshold profile for the cargo actually on board.
//
// DETERMINISTIC BY CONSTRUCTION — no model, no sampling, no clock. Given the
// same observations and the same profile it returns the same blocks forever,
// which is what lets the result survive arbitration, stay stable in the
// 500-case regression corpus, and recompute identically inside the WASM
// verifier a financing bank just ran.
//
// THREE RULES THAT DECIDE WHETHER THE OUTPUT IS HONEST:
//
//   1. A MISSING HOUR IS UNKNOWN, NEVER "no weather". Treating an absent
//      reading as workable would silently and systematically favour the
//      charterer, and nobody would ever see it happen. Gaps are reported, and
//      they interrupt a run rather than being bridged — we cannot assert
//      continuity across an hour we never observed.
//   2. A TEN-MINUTE SHOWER IS NOT A STOPPAGE. A weather working day means time
//      actually lost, so runs shorter than the profile's floor are discarded.
//   3. REPORT AGREEMENT, DO NOT OVERWRITE. The resolver never rewrites the
//      Master's record. It says where the data and the SoF agree, and where
//      each asserts something the other does not.
//
// A NULL threshold means the cargo is INSENSITIVE to that dimension. That is
// materially different from a very large number: steel does not care about rain
// at all, and encoding that as "999 mm/h" would be a lie that happens to work.

export type StoppageDimension = "precipitation" | "wind" | "gust" | "temperature";

/**
 * Whose threshold decided a stoppage.
 *
 * This exists for arbitration. When a counterparty disputes an excepted hour,
 * the first question is "on whose rules?" — a published LayGrounded baseline is
 * a very different thing to argue with than a threshold the claimant set for
 * themselves. The answer has to be in the output, not in a support ticket.
 */
export type ThresholdOrigin = "baseline" | "tenant";

export interface CargoWeatherProfile {
  cargoKey: string;
  label: string;
  /** Null = insensitive to this dimension. Not zero, and not a large sentinel. */
  precipMmPerHr: number | null;
  windKn: number | null;
  gustKn: number | null;
  minTempC: number | null;
  maxTempC: number | null;
  minStoppageMinutes: number;
  sourceLabel: string;
  /** Whether this profile as a whole is a tenant override or the shared baseline. */
  origin: ThresholdOrigin;
  /**
   * The dimensions a tenant actually changed.
   *
   * Per-dimension, not per-profile, because an override is rarely wholesale: a
   * charterer may negotiate a precipitation figure and leave the crane wind
   * limits at our baseline. Saying "tenant profile" over a block that fired on
   * an untouched wind threshold would misattribute it, and misattribution is
   * exactly what this field exists to prevent.
   */
  overriddenDimensions?: StoppageDimension[];
}

/** One hourly archive reading. Nulls are absent readings, not zeroes. */
export interface HourlyObservation {
  /** ISO 8601, the start of the hour the reading covers. */
  at: string;
  precipitationMm: number | null;
  windSpeedKn: number | null;
  windGustKn: number | null;
  temperatureC?: number | null;
}

export interface Interval {
  from: string;
  to: string;
}

/** One threshold that fired, and whose it was. */
export interface FiredThreshold {
  dimension: StoppageDimension;
  /** The value crossed. Null only for temperature, which is a range. */
  threshold: number | null;
  origin: ThresholdOrigin;
}

export interface ExceptedBlock {
  from: string;
  to: string;
  hours: number;
  /** Which thresholds fired across the run. Never empty. */
  dimensions: StoppageDimension[];
  /**
   * The thresholds behind this block, each attributed. A tribunal reading one
   * block should not have to cross-reference a profile to learn whose number
   * excluded the hour.
   */
  thresholdSources: FiredThreshold[];
  /** True when ANY threshold behind this block was set by the tenant. */
  usedTenantThreshold: boolean;
  peaks: {
    precipitationMm: number | null;
    windSpeedKn: number | null;
    windGustKn: number | null;
    temperatureC: number | null;
  };
  /** Human-readable, naming the threshold, the reading, and whose rule it was. */
  reason: string;
}

export interface WwdResolution {
  blocks: ExceptedBlock[];
  totalExceptedHours: number;
  /** Hours inside the window with no reading. Never assumed workable. */
  gaps: Interval[];
  gapHours: number;
  observedHours: number;
  /** How the measurements line up with what the SoF already claims. */
  agreement: {
    both: Interval[];
    /** The SoF claims weather here; the readings do not support it. */
    claimedOnly: Interval[];
    /** The readings show a stoppage here; the SoF does not claim it. */
    resolvedOnly: Interval[];
  };
  profile: {
    cargoKey: string;
    label: string;
    sourceLabel: string;
    origin: ThresholdOrigin;
    /** Dimensions the tenant set themselves. Empty on a pure baseline profile. */
    overriddenDimensions: StoppageDimension[];
  };
  /**
   * What the tenant's thresholds changed versus the published baseline. Null on
   * a baseline profile, or when no baseline was supplied to compare against.
   */
  baselineComparison: BaselineComparison | null;
  /** Anything a reader must know before relying on this. */
  warnings: string[];
}

export interface WwdResolverInput {
  /** The operational window to resolve over. */
  window: Interval;
  hourly: HourlyObservation[];
  profile: CargoWeatherProfile;
  /** Weather already claimed on the SoF, for the agreement report. */
  claimed?: Interval[];
  /**
   * The published baseline the tenant profile departs from.
   *
   * Supplying it makes the effect of tuning VISIBLE IN BOTH DIRECTIONS. Without
   * it, a threshold loosened until a stoppage disappears leaves no trace at all
   * — the result simply reports zero, and nothing says three hours were
   * suppressed. That is precisely the manipulation a counterparty would worry
   * about, so the comparison is computed rather than left to trust.
   */
  baselineProfile?: CargoWeatherProfile;
}

/** What the tenant's tuning changed, in hours. */
export interface BaselineComparison {
  baselineExceptedHours: number;
  tenantExceptedHours: number;
  /** Positive = tuning ADDED excepted time; negative = it REMOVED some. */
  deltaHours: number;
}

const MS_PER_HOUR = 3_600_000;

function ms(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new Error(`INVALID_TIMESTAMP: ${iso}`);
  return t;
}

const iso = (t: number) => new Date(t).toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Start of the clock hour containing `t`. */
function hourFloor(t: number): number {
  return Math.floor(t / MS_PER_HOUR) * MS_PER_HOUR;
}

interface HourVerdict {
  stopped: boolean;
  dimensions: StoppageDimension[];
  obs: HourlyObservation;
}

/**
 * Whether one hour stops work for this cargo.
 *
 * A null threshold short-circuits: the cargo is insensitive, so that dimension
 * cannot stop it however extreme the reading. A null READING is different — it
 * means we did not observe that dimension, so it cannot be used to assert a
 * stoppage either. Both nulls mean "no", for opposite reasons.
 */
export function evaluateHour(
  obs: HourlyObservation,
  profile: CargoWeatherProfile
): { stopped: boolean; dimensions: StoppageDimension[] } {
  const dimensions: StoppageDimension[] = [];

  if (profile.precipMmPerHr !== null && obs.precipitationMm !== null) {
    if (obs.precipitationMm >= profile.precipMmPerHr) dimensions.push("precipitation");
  }
  if (profile.windKn !== null && obs.windSpeedKn !== null) {
    if (obs.windSpeedKn >= profile.windKn) dimensions.push("wind");
  }
  if (profile.gustKn !== null && obs.windGustKn !== null) {
    if (obs.windGustKn >= profile.gustKn) dimensions.push("gust");
  }
  const temp = obs.temperatureC ?? null;
  if (temp !== null) {
    if (
      (profile.minTempC !== null && temp <= profile.minTempC) ||
      (profile.maxTempC !== null && temp >= profile.maxTempC)
    ) {
      dimensions.push("temperature");
    }
  }

  return { stopped: dimensions.length > 0, dimensions };
}

/** Whose rule governs one dimension, given which dimensions the tenant changed. */
export function originOf(
  dimension: StoppageDimension,
  profile: CargoWeatherProfile
): ThresholdOrigin {
  // A tenant profile that did not change THIS dimension is still running our
  // published number for it, and must say so.
  return profile.overriddenDimensions?.includes(dimension) ? "tenant" : "baseline";
}

/** Threshold value for a dimension, for attribution. */
function thresholdOf(
  dimension: StoppageDimension,
  profile: CargoWeatherProfile
): number | null {
  switch (dimension) {
    case "precipitation":
      return profile.precipMmPerHr;
    case "wind":
      return profile.windKn;
    case "gust":
      return profile.gustKn;
    case "temperature":
      return null; // a range, reported in the reason text instead
  }
}

const ORIGIN_TAG: Record<ThresholdOrigin, string> = {
  baseline: "LayGrounded baseline",
  tenant: "tenant custom threshold",
};

function describe(
  dimensions: StoppageDimension[],
  peaks: ExceptedBlock["peaks"],
  profile: CargoWeatherProfile,
  sources: FiredThreshold[]
): string {
  const tag = (d: StoppageDimension) =>
    `[${ORIGIN_TAG[sources.find((s) => s.dimension === d)?.origin ?? "baseline"]}]`;

  const parts: string[] = [];
  if (dimensions.includes("precipitation")) {
    parts.push(
      `precipitation peaked at ${peaks.precipitationMm} mm/h against a ${profile.precipMmPerHr} mm/h threshold ${tag("precipitation")}`
    );
  }
  if (dimensions.includes("wind")) {
    parts.push(
      `wind peaked at ${peaks.windSpeedKn} kn against a ${profile.windKn} kn threshold ${tag("wind")}`
    );
  }
  if (dimensions.includes("gust")) {
    parts.push(
      `gusts peaked at ${peaks.windGustKn} kn against a ${profile.gustKn} kn threshold ${tag("gust")}`
    );
  }
  if (dimensions.includes("temperature")) {
    parts.push(
      `temperature reached ${peaks.temperatureC} °C, outside the working range ${tag("temperature")}`
    );
  }
  return `Work stopped for ${profile.label}: ${parts.join("; ")}.`;
}

/** Merges touching/overlapping intervals so an agreement report has no duplicates. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .map((i) => ({ from: ms(i.from), to: ms(i.to) }))
    .filter((i) => i.to > i.from)
    .sort((a, b) => a.from - b.from);
  if (sorted.length === 0) return [];

  const out: Array<{ from: number; to: number }> = [sorted[0]];
  for (const cur of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (cur.from <= last.to) last.to = Math.max(last.to, cur.to);
    else out.push({ ...cur });
  }
  return out.map((i) => ({ from: iso(i.from), to: iso(i.to) }));
}

/** a ∩ b */
function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const from = Math.max(ms(x.from), ms(y.from));
      const to = Math.min(ms(x.to), ms(y.to));
      if (to > from) out.push({ from: iso(from), to: iso(to) });
    }
  }
  return mergeIntervals(out);
}

/** a \ b */
function subtract(a: Interval[], b: Interval[]): Interval[] {
  let cur = mergeIntervals(a).map((i) => ({ from: ms(i.from), to: ms(i.to) }));
  for (const cut of mergeIntervals(b)) {
    const c = { from: ms(cut.from), to: ms(cut.to) };
    const next: Array<{ from: number; to: number }> = [];
    for (const seg of cur) {
      if (c.to <= seg.from || c.from >= seg.to) {
        next.push(seg);
        continue;
      }
      if (c.from > seg.from) next.push({ from: seg.from, to: c.from });
      if (c.to < seg.to) next.push({ from: c.to, to: seg.to });
    }
    cur = next;
  }
  return cur.map((i) => ({ from: iso(i.from), to: iso(i.to) }));
}

export function resolveWeatherWorkingTime(input: WwdResolverInput): WwdResolution {
  const { profile } = input;
  const warnings: string[] = [];

  const windowFrom = hourFloor(ms(input.window.from));
  const windowTo = ms(input.window.to);

  // Index readings by the hour they cover, so a sparse or out-of-order feed is
  // handled the same as a dense one.
  const byHour = new Map<number, HourlyObservation>();
  for (const o of input.hourly) {
    byHour.set(hourFloor(ms(o.at)), o);
  }

  const verdicts: Array<HourVerdict | null> = [];
  const hourStarts: number[] = [];
  for (let t = windowFrom; t < windowTo; t += MS_PER_HOUR) {
    hourStarts.push(t);
    const obs = byHour.get(t);
    if (!obs) {
      verdicts.push(null); // gap — unknown, NOT workable
      continue;
    }
    const { stopped, dimensions } = evaluateHour(obs, profile);
    verdicts.push({ stopped, dimensions, obs });
  }

  // --- Gaps ---
  const gapIntervals: Interval[] = [];
  for (let i = 0; i < verdicts.length; i++) {
    if (verdicts[i] === null) {
      gapIntervals.push({
        from: iso(hourStarts[i]),
        to: iso(Math.min(hourStarts[i] + MS_PER_HOUR, windowTo)),
      });
    }
  }
  const gaps = mergeIntervals(gapIntervals);
  const gapHours = round2(
    gaps.reduce((s, g) => s + (ms(g.to) - ms(g.from)) / MS_PER_HOUR, 0)
  );
  const observedHours = verdicts.filter((v) => v !== null).length;

  if (gaps.length > 0) {
    warnings.push(
      `${gapHours}h of the window has no weather observation. Those hours are reported as gaps and are NOT treated as workable — a missing reading is unknown, not fair weather.`
    );
  }
  if (observedHours === 0) {
    warnings.push(
      "No observations at all cover this window, so no stoppage can be resolved either way."
    );
  }

  // --- Runs of stopped hours ---
  // A gap terminates a run: continuity across an unobserved hour cannot be
  // asserted, so two stoppages either side of a gap are two blocks, not one.
  const minHours = profile.minStoppageMinutes / 60;
  const blocks: ExceptedBlock[] = [];
  let runStart: number | null = null;
  let runDims = new Set<StoppageDimension>();
  let runPeaks = {
    precipitationMm: null as number | null,
    windSpeedKn: null as number | null,
    windGustKn: null as number | null,
    temperatureC: null as number | null,
  };
  let discardedShortRuns = 0;

  const closeRun = (endExclusive: number) => {
    if (runStart === null) return;
    const to = Math.min(endExclusive, windowTo);
    const hours = (to - runStart) / MS_PER_HOUR;
    if (hours + 1e-9 >= minHours) {
      const dims = [...runDims];
      const sources: FiredThreshold[] = dims.map((d) => ({
        dimension: d,
        threshold: thresholdOf(d, profile),
        origin: originOf(d, profile),
      }));
      blocks.push({
        from: iso(runStart),
        to: iso(to),
        hours: round2(hours),
        dimensions: dims,
        thresholdSources: sources,
        usedTenantThreshold: sources.some((s) => s.origin === "tenant"),
        peaks: { ...runPeaks },
        reason: describe(dims, runPeaks, profile, sources),
      });
    } else {
      discardedShortRuns += 1;
    }
    runStart = null;
    runDims = new Set();
    runPeaks = {
      precipitationMm: null,
      windSpeedKn: null,
      windGustKn: null,
      temperatureC: null,
    };
  };

  const bump = (cur: number | null, next: number | null | undefined) =>
    next === null || next === undefined ? cur : cur === null ? next : Math.max(cur, next);

  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i];
    if (v && v.stopped) {
      if (runStart === null) runStart = hourStarts[i];
      for (const d of v.dimensions) runDims.add(d);
      runPeaks.precipitationMm = bump(runPeaks.precipitationMm, v.obs.precipitationMm);
      runPeaks.windSpeedKn = bump(runPeaks.windSpeedKn, v.obs.windSpeedKn);
      runPeaks.windGustKn = bump(runPeaks.windGustKn, v.obs.windGustKn);
      runPeaks.temperatureC = bump(runPeaks.temperatureC, v.obs.temperatureC ?? null);
    } else {
      // Both a workable hour and a gap end the run.
      closeRun(hourStarts[i]);
    }
  }
  closeRun(windowTo);

  if (discardedShortRuns > 0) {
    warnings.push(
      `${discardedShortRuns} stoppage(s) shorter than the profile's ${profile.minStoppageMinutes}-minute floor were not excepted. Brief interruptions are not time lost under a weather working day.`
    );
  }

  const totalExceptedHours = round2(blocks.reduce((s, b) => s + b.hours, 0));

  // Stated up front, not buried. A counterparty reading this is entitled to
  // know that a figure rests on the claimant's own thresholds rather than a
  // published baseline, and to know exactly which ones.
  const tenantDims = profile.overriddenDimensions ?? [];
  let baselineComparison: BaselineComparison | null = null;

  if (tenantDims.length > 0) {
    // Re-run under the baseline to measure the effect. `baselineProfile` is
    // omitted on the inner call, so this cannot recurse.
    if (input.baselineProfile) {
      const asBaseline = resolveWeatherWorkingTime({
        window: input.window,
        hourly: input.hourly,
        profile: input.baselineProfile,
      });
      baselineComparison = {
        baselineExceptedHours: asBaseline.totalExceptedHours,
        tenantExceptedHours: totalExceptedHours,
        deltaHours: round2(totalExceptedHours - asBaseline.totalExceptedHours),
      };
    }

    const effect = baselineComparison
      ? baselineComparison.deltaHours === 0
        ? "They did not change the outcome: the published baseline yields the same excepted time."
        : baselineComparison.deltaHours > 0
          ? `They ADDED ${baselineComparison.deltaHours}h of excepted time versus the published baseline (${baselineComparison.baselineExceptedHours}h → ${baselineComparison.tenantExceptedHours}h).`
          : `They REMOVED ${Math.abs(baselineComparison.deltaHours)}h of excepted time versus the published baseline (${baselineComparison.baselineExceptedHours}h → ${baselineComparison.tenantExceptedHours}h).`
      : blocks.some((b) => b.usedTenantThreshold)
        ? "At least one excepted block was decided by a threshold set by this company rather than the published LayGrounded baseline."
        : "No excepted block here was decided by them.";

    warnings.push(
      `This result uses TENANT CUSTOM THRESHOLDS for: ${tenantDims.join(", ")}. ` +
        `${effect} Remaining dimensions use the LayGrounded baseline.`
    );
  }

  // --- Agreement with the SoF ---
  const resolvedIntervals = blocks.map((b) => ({ from: b.from, to: b.to }));
  const claimed = mergeIntervals(input.claimed ?? []);
  const agreement = {
    both: intersect(resolvedIntervals, claimed),
    claimedOnly: subtract(claimed, resolvedIntervals),
    resolvedOnly: subtract(resolvedIntervals, claimed),
  };

  return {
    blocks,
    totalExceptedHours,
    gaps,
    gapHours,
    observedHours,
    agreement,
    profile: {
      cargoKey: profile.cargoKey,
      label: profile.label,
      sourceLabel: profile.sourceLabel,
      origin: profile.origin,
      overriddenDimensions: profile.overriddenDimensions ?? [],
    },
    baselineComparison,
    warnings,
  };
}

/**
 * Turns resolved blocks into the engine's own event vocabulary.
 *
 * WEATHER_DELAY / WEATHER_DELAY_END pairs, deliberately NOT
 * EXCEPTED_PERIOD_START/END. An excepted period is excluded under EVERY days
 * basis including SHINC, but weather is only excepted under a weather-working
 * basis. Emitting excepted periods would exclude weather on a SHINC fixture and
 * silently override the charterparty the parties signed.
 *
 * Emitting weather-delay pairs leaves the engine's `days_basis` logic as the
 * final arbiter: the resolver supplies facts, the contract decides their effect.
 * It also means the engine needs no change and the regression corpus stays valid.
 */
export function blocksToSofEvents(
  blocks: ExceptedBlock[]
): Array<{ event_type: "WEATHER_DELAY" | "WEATHER_DELAY_END"; occurred_at: string; raw_text: string }> {
  const events: Array<{
    event_type: "WEATHER_DELAY" | "WEATHER_DELAY_END";
    occurred_at: string;
    raw_text: string;
  }> = [];
  for (const b of blocks) {
    events.push({ event_type: "WEATHER_DELAY", occurred_at: b.from, raw_text: b.reason });
    events.push({
      event_type: "WEATHER_DELAY_END",
      occurred_at: b.to,
      raw_text: `Weather stoppage ended (${b.hours}h).`,
    });
  }
  return events;
}
