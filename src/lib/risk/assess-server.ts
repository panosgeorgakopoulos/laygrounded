// Resolving the real world into simulation inputs, then persisting the result.
//
// This is the I/O half of the pre-arrival risk engine. It geocodes the port,
// resolves the cargo's weather thresholds, fetches the forecast ensemble and
// the historical years, asks the AIS adapter for the queue, and hands all of it
// to the pure simulator. Nothing statistical happens here, and nothing here
// happens inside `simulate()`.
//
// The split is what makes a stored assessment auditable: everything this
// function resolved is written to `pre_arrival_risks.inputs`, so replaying is a
// pure function call with no network and no clock.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { geocodePort } from "@/lib/evidence/weather";
import { resolveCargoProfile } from "@/lib/weather/wwd-server";
import { canonicalJson } from "@/lib/legal/prosecution";
import type { CpTerms } from "@/lib/laytime/types";
import {
  ensembleWeight,
  horizonMode,
  leadTimeHours,
  describeHorizon,
  type HorizonMode,
} from "@/lib/risk/horizon";
import {
  fetchClimatologyTrajectories,
  fetchEnsembleTrajectories,
  windowHoursFor,
} from "@/lib/risk/sources/weather-trajectories";
import { selectCongestionAdapter } from "@/lib/risk/sources/resolve-congestion";
import type { PortCongestionSnapshot } from "@/lib/risk/sources/ais-congestion";
import {
  isDecisionGrade,
  provenanceCaveats,
  type DataProvenance,
  type DimensionProvenance,
} from "@/lib/risk/provenance";
import { simulate, DEFAULT_TRIALS, type SimulationResult } from "@/lib/risk/simulate";
import type { StoppageTrajectory, TrialInputs } from "@/lib/risk/trial";

export interface AssessRequest {
  vessel: string;
  voyageRef?: string | null;
  port: string;
  cargo: string;
  etaISO: string;
  cpTerms: CpTerms;
  opsDurationHours: number;
  operation?: "loading" | "discharge";
  berthToOpsHours?: number;
  /** Triangular ETA error in hours; defaults to −12 / 0 / +48. */
  etaErrorHours?: { min: number; mode: number; max: number };
  /** Waiting-hours override when the desk knows better than the feed. */
  assumedWaitingHours?: number[] | null;
  seed?: string;
  trials?: number;
  antithetic?: boolean;
  claimId?: string | null;
}

export interface AssessResult {
  simulation: SimulationResult;
  provenance: DimensionProvenance;
  decisionGrade: boolean;
  caveats: string[];
  horizon: { leadTimeHours: number; mode: HorizonMode; ensembleWeight: number; description: string };
  inputs: PersistedInputs;
  inputsDigest: string;
  portLabel: string;
}

/**
 * Exactly what a replay needs — and nothing that would make a replay disagree.
 *
 * Trajectories are stored as run-length-encoded flags: a fortnight of hourly
 * booleans across 30 members compresses to a few hundred integers, and weather
 * is autocorrelated so the runs are long. Storing raw readings instead would
 * make the row large enough that nobody would keep it, which would defeat the
 * point of storing it at all.
 */
export interface PersistedInputs {
  cpTerms: CpTerms;
  opsDurationHours: number;
  berthToOpsHours: number;
  operation: "loading" | "discharge";
  /**
   * The geocoded port position.
   *
   * Recorded so a stored assessment can later be placed in a weather system for
   * portfolio risk, without re-geocoding (which could resolve differently and
   * silently move the voyage). Optional because rows written before this field
   * existed do not carry it — the portfolio route reports those as skipped
   * rather than defaulting them to (0, 0), which would put every legacy voyage
   * in the Gulf of Guinea and invent a correlation between them.
   *
   * Adding it does not invalidate older digests: `digestInputs` runs over the
   * stored object, so a row without a position still verifies against its own
   * recorded digest.
   */
  position?: { lat: number; lon: number };
  referenceStartISO: string;
  etaISO: string;
  etaErrorHours: { min: number; mode: number; max: number };
  waitingHoursSorted: number[];
  ensembleWeight: number;
  cargoProfile: {
    cargoKey: string;
    label: string;
    precipMmPerHr: number | null;
    windKn: number | null;
    gustKn: number | null;
    minTempC: number | null;
    maxTempC: number | null;
    sourceLabel: string;
    origin: string;
  };
  trajectories: Array<{ kind: "ensemble" | "climatology"; id: string; runs: number[] }>;
}

/** Run-length encoding of a boolean series, starting with a run of `false`. */
export function encodeRuns(flags: boolean[]): number[] {
  const runs: number[] = [];
  let current = false;
  let count = 0;
  for (const f of flags) {
    if (f === current) {
      count++;
    } else {
      runs.push(count);
      current = f;
      count = 1;
    }
  }
  if (count > 0) runs.push(count);
  return runs;
}

export function decodeRuns(runs: number[]): boolean[] {
  const flags: boolean[] = [];
  let value = false;
  for (const run of runs) {
    for (let i = 0; i < run; i++) flags.push(value);
    value = !value;
  }
  return flags;
}

export function digestInputs(inputs: PersistedInputs): string {
  return createHash("sha256").update(canonicalJson(inputs), "utf8").digest("hex");
}

export interface ReplayVerdict {
  reproduced: boolean;
  inputsIntact: boolean;
  /** Paths whose values genuinely differ. Empty when `reproduced`. */
  differences: string[];
}

/**
 * Re-runs a stored assessment and reports whether it reproduces.
 *
 * COMPARE CANONICALLY, NEVER WITH `JSON.stringify`. Postgres `jsonb` does not
 * preserve key order, so a stored distribution read back has its keys in a
 * different order than a freshly computed one and a string comparison reports
 * every honest replay as a divergence. This cost a debugging round when the
 * end-to-end check first ran; the same trap already bit the trade-finance
 * verifier, which is why `canonicalJson` sorts keys.
 *
 * Provided as a function rather than left to each caller so nobody has to
 * rediscover that.
 */
export function verifyReplay(
  storedInputs: PersistedInputs,
  storedDigest: string,
  storedResult: unknown,
  options: { seed: string; trials: number; antithetic: boolean }
): ReplayVerdict {
  const inputsIntact = digestInputs(storedInputs) === storedDigest;
  const replay = simulate(inputsToTrialInputs(storedInputs), options);

  const differences: string[] = [];
  const walk = (fresh: unknown, stored: unknown, path: string): void => {
    if (fresh === null || typeof fresh !== "object") {
      if (fresh !== stored) {
        differences.push(`${path}: recomputed ${JSON.stringify(fresh)}, stored ${JSON.stringify(stored)}`);
      }
      return;
    }
    if (Array.isArray(fresh)) {
      if (!Array.isArray(stored) || fresh.length !== stored.length) {
        differences.push(`${path}: array length differs`);
        return;
      }
      fresh.forEach((v, i) => walk(v, stored[i], `${path}[${i}]`));
      return;
    }
    const s = (stored ?? {}) as Record<string, unknown>;
    const f = fresh as Record<string, unknown>;
    for (const key of new Set([...Object.keys(f), ...Object.keys(s)])) {
      walk(f[key], s[key], `${path}.${key}`);
    }
  };
  walk(replay.distribution, storedResult, "distribution");

  return {
    reproduced:
      inputsIntact &&
      differences.length === 0 &&
      canonicalJson(replay.distribution) === canonicalJson(storedResult),
    inputsIntact,
    differences,
  };
}

/** Rebuilds simulator inputs from a persisted row — the replay path. */
export function inputsToTrialInputs(inputs: PersistedInputs): TrialInputs {
  const trajectories: StoppageTrajectory[] = inputs.trajectories.map((t) => ({
    kind: t.kind,
    id: t.id,
    flags: decodeRuns(t.runs),
  }));
  return {
    cpTerms: inputs.cpTerms,
    opsDurationHours: inputs.opsDurationHours,
    berthToOpsHours: inputs.berthToOpsHours,
    referenceStartISO: inputs.referenceStartISO,
    etaISO: inputs.etaISO,
    etaErrorHours: inputs.etaErrorHours,
    waitingHoursSorted: inputs.waitingHoursSorted,
    ensemblePool: trajectories.filter((t) => t.kind === "ensemble"),
    climatologyPool: trajectories.filter((t) => t.kind === "climatology"),
    ensembleWeight: inputs.ensembleWeight,
    operation: inputs.operation,
  };
}

const DEFAULT_ETA_ERROR = { min: -12, mode: 0, max: 48 };

export async function assessPreArrivalRisk(
  db: SupabaseClient,
  companyId: string,
  req: AssessRequest,
  now: Date = new Date()
): Promise<AssessResult> {
  const nowISO = now.toISOString();
  const operation = req.operation ?? "loading";
  const berthToOpsHours = req.berthToOpsHours ?? 1;
  const etaErrorHours = req.etaErrorHours ?? DEFAULT_ETA_ERROR;

  const location = await geocodePort(req.port);
  if (!location) throw new Error("PORT_NOT_FOUND");

  const { profile } = await resolveCargoProfile(db, companyId, req.cargo);

  const lead = leadTimeHours(nowISO, req.etaISO);
  const weight = ensembleWeight(lead);
  const windowHours = windowHoursFor(req.opsDurationHours);

  // ── Weather ────────────────────────────────────────────────────────────────
  // Both pools are fetched whenever the blend needs both. Climatology is always
  // fetched: it is the fallback if the ensemble is unavailable, and a fixture
  // beyond the horizon has nothing else.
  const wantsEnsemble = weight > 0;
  const [ensemble, climatology] = await Promise.all([
    wantsEnsemble
      ? fetchEnsembleTrajectories(location.lat, location.lon, profile)
      : Promise.resolve({ trajectories: [], referenceStartISO: null, model: "" }),
    fetchClimatologyTrajectories(
      location.lat,
      location.lon,
      profile,
      req.etaISO,
      windowHours
    ),
  ]);

  if (ensemble.trajectories.length === 0 && climatology.length === 0) {
    throw new Error("WEATHER_UNAVAILABLE");
  }

  // Trajectories from both pools must share an origin instant or the arrival
  // offset would index them differently. The ensemble's own start is used when
  // present; otherwise climatology windows are anchored on the ETA.
  const referenceStartISO = ensemble.referenceStartISO ?? req.etaISO;

  // An ensemble that came back empty cannot be blended into, whatever the
  // horizon says. Re-deriving the weight here rather than trusting the horizon
  // keeps the persisted `ensembleWeight` equal to the one actually simulated.
  const effectiveWeight = ensemble.trajectories.length > 0 ? weight : 0;

  const weatherProvenance: DataProvenance =
    ensemble.trajectories.length > 0
      ? {
          source: "live",
          provider: `open-meteo/${ensemble.model}`,
          observedAt: referenceStartISO,
          label:
            `Open-Meteo ${ensemble.model} ensemble, ${ensemble.trajectories.length} members` +
            (climatology.length > 0 ? `, blended with ${climatology.length} historical years` : ""),
        }
      : {
          source: "public_archive",
          provider: "open-meteo/era5",
          observedAt: null,
          label: `ERA5 reanalysis, ${climatology.length} historical years for this calendar window`,
          ...(wantsEnsemble
            ? {
                unavailableReason:
                  "The forecast ensemble was requested for this lead time but returned no usable " +
                  "members, so the simulation ran on climatology alone.",
              }
            : {}),
        };

  // ── Congestion ─────────────────────────────────────────────────────────────
  let waitingHoursSorted: number[] = [];
  let congestionProvenance: DataProvenance;

  if (req.assumedWaitingHours && req.assumedWaitingHours.length > 0) {
    waitingHoursSorted = [...req.assumedWaitingHours].sort((a, b) => a - b);
    congestionProvenance = {
      source: "assumption",
      provider: "user",
      observedAt: null,
      label: `${waitingHoursSorted.length} waiting-hour figures supplied by the requester`,
    };
  } else {
    const { adapter, reason } = selectCongestionAdapter(process.env);
    let snapshot: PortCongestionSnapshot | null = null;
    if (adapter) snapshot = await adapter.fetchSnapshot(req.port);

    if (snapshot && snapshot.waitingHoursSorted.length > 0) {
      waitingHoursSorted = snapshot.waitingHoursSorted;
      congestionProvenance = snapshot.provenance;
    } else {
      // No queue data is NOT a free berth. Refusing here rather than defaulting
      // to zero is the difference between "we could not measure this" and a
      // silently optimistic exposure figure.
      throw new Error(
        `CONGESTION_UNAVAILABLE: ${
          reason ??
          (adapter
            ? `The ${adapter.id} provider returned no waiting times for ${req.port}.`
            : "No congestion provider is available.")
        } Supply assumedWaitingHours to run on a stated assumption instead.`
      );
    }
  }

  const provenance: DimensionProvenance = {
    weather: weatherProvenance,
    congestion: congestionProvenance,
    cargoThresholds: {
      source: profile.origin === "tenant" ? "own_book" : "public_archive",
      provider: profile.origin === "tenant" ? "tenant-profile" : "laygrounded-baseline",
      observedAt: null,
      label: `${profile.label} — ${profile.sourceLabel}`,
    },
    eta: {
      source: "assumption",
      provider: "user",
      observedAt: null,
      label: `ETA ${req.etaISO} ±(${etaErrorHours.min}h, ${etaErrorHours.max}h)`,
    },
  };

  const inputs: PersistedInputs = {
    cpTerms: req.cpTerms,
    opsDurationHours: req.opsDurationHours,
    berthToOpsHours,
    operation,
    position: { lat: location.lat, lon: location.lon },
    referenceStartISO,
    etaISO: req.etaISO,
    etaErrorHours,
    waitingHoursSorted,
    ensembleWeight: effectiveWeight,
    cargoProfile: {
      cargoKey: profile.cargoKey,
      label: profile.label,
      precipMmPerHr: profile.precipMmPerHr,
      windKn: profile.windKn,
      gustKn: profile.gustKn,
      minTempC: profile.minTempC,
      maxTempC: profile.maxTempC,
      sourceLabel: profile.sourceLabel,
      origin: profile.origin,
    },
    trajectories: [...ensemble.trajectories, ...climatology].map((t) => ({
      kind: t.kind,
      id: t.id,
      runs: encodeRuns(t.flags),
    })),
  };

  const seed = req.seed?.trim() || defaultSeed(req, nowISO);
  const simulation = simulate(inputsToTrialInputs(inputs), {
    seed,
    trials: req.trials ?? DEFAULT_TRIALS,
    antithetic: req.antithetic,
  });

  const decisionGrade = isDecisionGrade(provenance);

  return {
    simulation,
    provenance,
    decisionGrade,
    caveats: [
      ...provenanceCaveats(provenance),
      "Cargo work is modelled as pausing during stoppage hours and resuming after; " +
        "shift patterns and gang availability are not modelled.",
      "This is a probabilistic planning estimate, not a forecast of what will happen.",
    ],
    horizon: {
      leadTimeHours: lead,
      mode: horizonMode(lead),
      ensembleWeight: effectiveWeight,
      description: describeHorizon(lead),
    },
    inputs,
    inputsDigest: digestInputs(inputs),
    portLabel: location.label,
  };
}

/**
 * A stable default seed.
 *
 * Derived from the voyage and the hour of the request rather than randomly, so
 * two assessments of the same voyage in the same hour agree — a desk refreshing
 * a page should not watch the P90 twitch. Still varies across hours, so a later
 * reassessment is an independent sample rather than a rerun.
 */
export function defaultSeed(
  req: Pick<AssessRequest, "vessel" | "port" | "etaISO" | "voyageRef">,
  nowISO: string
): string {
  return [
    req.vessel.trim().toLowerCase(),
    req.voyageRef?.trim().toLowerCase() ?? "",
    req.port.trim().toLowerCase(),
    req.etaISO,
    nowISO.slice(0, 13),
  ].join("|");
}

export async function persistAssessment(
  db: SupabaseClient,
  companyId: string,
  userId: string | null,
  req: AssessRequest,
  assessment: AssessResult
): Promise<string> {
  const { data, error } = await db
    .from("pre_arrival_risks")
    .insert({
      company_id: companyId,
      claim_id: req.claimId ?? null,
      vessel: req.vessel,
      voyage_ref: req.voyageRef ?? null,
      port: req.port,
      cargo: req.cargo,
      eta: req.etaISO,
      operation: req.operation ?? "loading",
      seed: assessment.simulation.seed,
      trials: assessment.simulation.trials,
      antithetic: assessment.simulation.antithetic,
      inputs: assessment.inputs,
      inputs_digest: assessment.inputsDigest,
      provenance: assessment.provenance,
      decision_grade: assessment.decisionGrade,
      result: assessment.simulation.distribution,
      demurrage_probability: assessment.simulation.distribution.demurrageProbability.value,
      expected_exposure: assessment.simulation.distribution.expectedExposure.value,
      p90_exposure: assessment.simulation.distribution.percentiles.p90.value,
      currency: req.cpTerms.currency,
      lead_time_hours: assessment.horizon.leadTimeHours,
      horizon_mode: assessment.horizon.mode,
      created_by: userId,
    })
    .select("id")
    .single();

  if (error) throw new Error(`PERSIST_FAILED: ${error.message}`);
  return data.id as string;
}
