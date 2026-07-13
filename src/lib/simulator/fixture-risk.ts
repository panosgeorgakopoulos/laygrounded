// Fixture Risk Simulator — pre-fixture laytime risk, priced from real weather.
//
// Before fixing, a chartering desk wants to know what a given set of laytime
// terms will actually cost at a given port in a given month. This module
// replays the last N years of ACTUAL historical weather (Open-Meteo ERA5
// archive) at the port: for each year it derives the hours cargo work would
// have stopped (same thresholds the evidence verifier uses), synthesizes the
// voyage timeline, and runs the deterministic engine under the hypothetical
// CP terms. The result is a real demurrage distribution — mean, median, P90 —
// not a guess.
//
// The weather fetch is I/O; everything else is pure and unit-tested.

import {
  fetchHourlyWeather,
  geocodePort,
  HourlyWeatherWindow,
  WEATHER_THRESHOLDS,
} from "@/lib/evidence/weather";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import { CpTerms, SofEventInput } from "@/lib/laytime/types";
import { Decimal } from "decimal.js";

const HOUR_MS = 3600_000;
// The engine caps at 1440 iterated hours; leave margin for turn time.
const MAX_TIMELINE_HOURS = 1200;

export interface FixtureRiskInputs {
  port: string;
  month: number; // 1-12
  opsDurationHours: number; // working cargo hours (stoppages extend the stay)
  cpTerms: CpTerms;
  yearsBack?: number; // default 8
}

export interface YearOutcome {
  year: number;
  stoppageHours: number;
  usedHours: number;
  demurrageAmount: number;
  despatchAmount: number;
  net: number;
}

export interface FixtureRiskReport {
  port: string;
  portLabel: string;
  lat: number;
  lon: number;
  month: number;
  opsDurationHours: number;
  yearsRequested: number;
  outcomes: YearOutcome[];
  skippedYears: number[];
  stats: {
    meanNet: number;
    medianNet: number;
    p90Net: number;
    meanStoppageHours: number;
    worstYear: number | null;
    bestYear: number | null;
    demurrageProbability: number; // share of years ending on demurrage
  };
  assumptions: string[];
}

// An hour stops cargo work when it would also corroborate a weather delay —
// one weather worldview across evidence verification and simulation.
export function deriveStoppageFlags(window: HourlyWeatherWindow): boolean[] {
  return window.times.map((_, i) => {
    const precip = window.precipitationMm[i] ?? 0;
    const gust = window.windGustKn[i] ?? 0;
    const wind = window.windSpeedKn[i] ?? 0;
    return (
      precip >= WEATHER_THRESHOLDS.CORROBORATE_PRECIP_MM ||
      gust >= WEATHER_THRESHOLDS.CORROBORATE_GUST_KN ||
      wind >= WEATHER_THRESHOLDS.CORROBORATE_WIND_KN
    );
  });
}

// Builds the voyage timeline for one historical year: NOR → berth → ops that
// pause during stoppage hours → completion once opsDurationHours of actual
// work are done. Flags beyond the array are treated as workable.
export function synthesizeVoyage(
  startISO: string,
  stoppageFlags: boolean[],
  opsDurationHours: number
): SofEventInput[] {
  const start = new Date(startISO);
  const at = (h: number) => new Date(start.getTime() + h * HOUR_MS).toISOString();

  const events: SofEventInput[] = [
    { id: "nor", occurred_at: at(0), event_type: "NOR_TENDERED" },
    { id: "fast", occurred_at: at(2), event_type: "ALL_FAST" },
    { id: "ops", occurred_at: at(3), event_type: "COMMENCED_LOADING" },
  ];

  const opsStartHour = 3;
  let worked = 0;
  let hour = opsStartHour;
  let weatherOpen = false;
  let pairIndex = 0;

  while (worked < opsDurationHours && hour < MAX_TIMELINE_HOURS) {
    const stopped = stoppageFlags[hour] === true;
    if (stopped && !weatherOpen) {
      events.push({ id: `w${pairIndex}s`, occurred_at: at(hour), event_type: "WEATHER_DELAY" });
      weatherOpen = true;
    } else if (!stopped && weatherOpen) {
      events.push({ id: `w${pairIndex}e`, occurred_at: at(hour), event_type: "WEATHER_DELAY_END" });
      weatherOpen = false;
      pairIndex++;
    }
    if (!stopped) worked++;
    hour++;
  }

  if (weatherOpen) {
    events.push({ id: `w${pairIndex}e`, occurred_at: at(hour), event_type: "WEATHER_DELAY_END" });
  }
  events.push({ id: "done", occurred_at: at(hour), event_type: "COMPLETED_LOADING" });
  return events;
}

export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const idx = (sortedAscending.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscending[lo];
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * (idx - lo);
}

export async function simulateFixtureRisk(
  inputs: FixtureRiskInputs
): Promise<FixtureRiskReport> {
  const yearsBack = Math.min(Math.max(inputs.yearsBack ?? 8, 3), 12);
  const location = await geocodePort(inputs.port);
  if (!location) throw new Error("PORT_NOT_FOUND");

  const lastFullYear = new Date().getUTCFullYear() - 1;
  const years = Array.from({ length: yearsBack }, (_, i) => lastFullYear - i);
  const mm = String(inputs.month).padStart(2, "0");
  // Window long enough to absorb stoppages: 2× ops duration + 5 days buffer.
  const windowHours = Math.min(inputs.opsDurationHours * 2 + 120, MAX_TIMELINE_HOURS);

  const outcomes: YearOutcome[] = [];
  const skippedYears: number[] = [];

  const results = await Promise.all(
    years.map(async (year) => {
      const startISO = `${year}-${mm}-05T06:00:00.000Z`;
      const endISO = new Date(
        new Date(startISO).getTime() + windowHours * HOUR_MS
      ).toISOString();
      const window = await fetchHourlyWeather(location.lat, location.lon, startISO, endISO);
      return { year, startISO, window };
    })
  );

  for (const { year, startISO, window } of results) {
    if (!window) {
      skippedYears.push(year);
      continue;
    }
    const flags = deriveStoppageFlags(window);
    const events = synthesizeVoyage(startISO, flags, inputs.opsDurationHours);
    let totals;
    try {
      totals = recomputeLaytime(events, inputs.cpTerms).totals;
    } catch {
      skippedYears.push(year);
      continue;
    }
    const stoppageHours = flags.filter(Boolean).length;
    outcomes.push({
      year,
      stoppageHours,
      usedHours: totals.used_hours,
      demurrageAmount: totals.demurrage_amount,
      despatchAmount: totals.despatch_amount,
      net: new Decimal(totals.demurrage_amount)
        .minus(totals.despatch_amount)
        .toDecimalPlaces(2)
        .toNumber(),
    });
  }

  const nets = outcomes.map((o) => o.net).sort((a, b) => a - b);
  const mean = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const worst = outcomes.reduce<YearOutcome | null>(
    (acc, o) => (acc === null || o.net > acc.net ? o : acc),
    null
  );
  const best = outcomes.reduce<YearOutcome | null>(
    (acc, o) => (acc === null || o.net < acc.net ? o : acc),
    null
  );

  return {
    port: inputs.port,
    portLabel: location.label,
    lat: location.lat,
    lon: location.lon,
    month: inputs.month,
    opsDurationHours: inputs.opsDurationHours,
    yearsRequested: yearsBack,
    outcomes: outcomes.sort((a, b) => b.year - a.year),
    skippedYears,
    stats: {
      meanNet: Math.round(mean(nets) * 100) / 100,
      medianNet: Math.round(percentile(nets, 0.5) * 100) / 100,
      p90Net: Math.round(percentile(nets, 0.9) * 100) / 100,
      meanStoppageHours: Math.round(mean(outcomes.map((o) => o.stoppageHours)) * 10) / 10,
      worstYear: worst?.year ?? null,
      bestYear: best?.year ?? null,
      demurrageProbability:
        outcomes.length === 0
          ? 0
          : Math.round(
              (outcomes.filter((o) => o.demurrageAmount > 0).length / outcomes.length) * 100
            ) / 100,
    },
    assumptions: [
      "Weather: Open-Meteo ERA5 reanalysis at the geocoded port position; work stops when precipitation ≥ 0.5 mm/h, gusts ≥ 25 kn, or wind ≥ 20 kn (same thresholds as evidence verification).",
      "Voyage template: NOR day 5 of the month 06:00 UTC, all fast +2h, ops commence +3h; cargo work pauses during stoppage hours.",
      `Cargo operations require ${inputs.opsDurationHours} working hours.`,
      "Day-of-week exceptions (SHEX/SSHEX) evaluated in UTC unless CP terms specify a port timezone.",
      "This is a planning estimate from historical weather, not a guarantee of future conditions.",
    ],
  };
}
