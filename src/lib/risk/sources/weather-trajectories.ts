// The two weather pools: forecast ensemble members and historical years.
//
// Both resolve to the same thing — a list of physically-consistent hourly
// series, each of which is one possible world. What differs is where a world
// comes from: an ensemble member is a perturbed forecast of the actual coming
// weather, a climatology trajectory is what genuinely happened in that calendar
// window in a past year.
//
// Each series is reduced to stoppage flags using the CARGO's thresholds via
// `evaluateHour`, so grain and steel see different weather from the same data —
// the same resolver the WWD feature uses, not a second opinion.
//
// I/O lives here; the simulation itself never fetches anything.

import type { CargoWeatherProfile, HourlyObservation } from "@/lib/weather/wwd-resolver";
import { evaluateHour } from "@/lib/weather/wwd-resolver";
import { fetchHourlyWeather } from "@/lib/evidence/weather";
import type { StoppageTrajectory } from "@/lib/risk/trial";

const ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble";
const FETCH_TIMEOUT_MS = 20_000;

/**
 * GFS ensemble: 30 members, and — verified against the live API — the members
 * carry non-null values across the full 14-day window.
 *
 * This is not the default by accident. ICON's members go null after roughly
 * 5.5 days while still returning 336 timestamps, so a naive integration gets a
 * fortnight-shaped array that is two-thirds empty and silently simulates
 * "no weather" for the tail.
 */
export const DEFAULT_ENSEMBLE_MODEL = "gfs_seamless";
export const ENSEMBLE_FORECAST_DAYS = 14;

/** Hours needed to cover queueing plus cargo work plus stoppages. */
export function windowHoursFor(opsDurationHours: number): number {
  return Math.min(opsDurationHours * 2 + 120, 1200);
}

interface EnsembleResponse {
  hourly?: Record<string, Array<number | null> | string[]>;
}

/**
 * Fetches ensemble members as stoppage trajectories.
 *
 * Returns an empty array rather than throwing: no forecast is a legitimate
 * state (beyond the horizon, or the API is down) and the caller falls back to
 * climatology, which it has anyway.
 */
export async function fetchEnsembleTrajectories(
  lat: number,
  lon: number,
  profile: CargoWeatherProfile,
  model: string = DEFAULT_ENSEMBLE_MODEL
): Promise<{ trajectories: StoppageTrajectory[]; referenceStartISO: string | null; model: string }> {
  const url =
    `${ENSEMBLE_URL}?latitude=${lat}&longitude=${lon}` +
    `&hourly=precipitation,wind_speed_10m,wind_gusts_10m,temperature_2m` +
    `&models=${encodeURIComponent(model)}&wind_speed_unit=kn` +
    `&forecast_days=${ENSEMBLE_FORECAST_DAYS}&timezone=UTC`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { trajectories: [], referenceStartISO: null, model };
    const json = (await res.json()) as EnsembleResponse;
    const hourly = json?.hourly;
    const times = hourly?.time as string[] | undefined;
    if (!times?.length) return { trajectories: [], referenceStartISO: null, model };

    // Member numbering is consistent across variables, so enumerate from one.
    const memberIds = Object.keys(hourly!)
      .filter((k) => k.startsWith("wind_gusts_10m_member"))
      .map((k) => k.replace("wind_gusts_10m_member", ""))
      .sort();

    const trajectories: StoppageTrajectory[] = [];
    for (const id of memberIds) {
      const precip = hourly![`precipitation_member${id}`] as Array<number | null> | undefined;
      const wind = hourly![`wind_speed_10m_member${id}`] as Array<number | null> | undefined;
      const gust = hourly![`wind_gusts_10m_member${id}`] as Array<number | null> | undefined;
      const temp = hourly![`temperature_2m_member${id}`] as Array<number | null> | undefined;
      if (!gust && !wind && !precip) continue;

      const observations: HourlyObservation[] = times.map((t, i) => ({
        at: `${t}:00Z`,
        precipitationMm: precip?.[i] ?? null,
        windSpeedKn: wind?.[i] ?? null,
        windGustKn: gust?.[i] ?? null,
        temperatureC: temp?.[i] ?? null,
      }));

      // A member whose readings run out partway is truncated at that point
      // rather than padded with `false`. Padding would assert "no weather"
      // where the model simply stopped — the same "a gap is UNKNOWN, never no
      // weather" rule the evidence verifier follows.
      const lastReading = observations.reduce(
        (last, o, i) =>
          o.precipitationMm !== null || o.windSpeedKn !== null || o.windGustKn !== null ? i : last,
        -1
      );
      if (lastReading < 24) continue;

      trajectories.push({
        kind: "ensemble",
        id: `member${id}`,
        flags: observations
          .slice(0, lastReading + 1)
          .map((o) => evaluateHour(o, profile).stopped),
      });
    }

    return { trajectories, referenceStartISO: `${times[0]}:00Z`, model };
  } catch {
    return { trajectories: [], referenceStartISO: null, model };
  }
}

/**
 * Historical years for the same calendar window, as trajectories.
 *
 * WHOLE YEARS, not resampled hours. Weather is strongly autocorrelated: a storm
 * is three bad days, not seventy-two independently bad hours. Sampling hours
 * independently from a marginal distribution would produce a demurrage
 * distribution far too narrow and far too optimistic in the tail, because the
 * long stoppages that actually generate demurrage would essentially never
 * assemble themselves by chance.
 */
export async function fetchClimatologyTrajectories(
  lat: number,
  lon: number,
  profile: CargoWeatherProfile,
  anchorISO: string,
  windowHours: number,
  yearsBack = 8
): Promise<StoppageTrajectory[]> {
  const anchor = new Date(anchorISO);
  const lastFullYear = anchor.getUTCFullYear() - 1;
  const years = Array.from({ length: yearsBack }, (_, i) => lastFullYear - i);

  const fetched = await Promise.all(
    years.map(async (year) => {
      const start = new Date(anchor);
      start.setUTCFullYear(year);
      const end = new Date(start.getTime() + windowHours * 3_600_000);
      const window = await fetchHourlyWeather(
        lat,
        lon,
        start.toISOString(),
        end.toISOString()
      );
      return { year, window };
    })
  );

  const trajectories: StoppageTrajectory[] = [];
  for (const { year, window } of fetched) {
    if (!window) continue;
    const observations: HourlyObservation[] = window.times.map((t, i) => ({
      at: `${t}:00Z`,
      precipitationMm: window.precipitationMm[i],
      windSpeedKn: window.windSpeedKn[i],
      windGustKn: window.windGustKn[i],
      temperatureC: null,
    }));
    trajectories.push({
      kind: "climatology",
      id: String(year),
      flags: observations.map((o) => evaluateHour(o, profile).stopped),
    });
  }
  return trajectories;
}
