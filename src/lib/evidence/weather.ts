// Historical weather lookups for evidence verification, backed by the free
// Open-Meteo archive (ERA5 reanalysis) and geocoding APIs. No API key needed.
// Pure HTTP + parsing; persistence lives in verify.ts.

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const FETCH_TIMEOUT_MS = 10_000;

export interface PortLocation {
  lat: number;
  lon: number;
  label: string;
}

export interface HourlyWeatherWindow {
  // Parallel arrays as returned by Open-Meteo, already sliced to the window.
  times: string[];
  precipitationMm: Array<number | null>;
  windSpeedKn: Array<number | null>;
  windGustKn: Array<number | null>;
}

export async function geocodePort(portName: string): Promise<PortLocation | null> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(portName)}&count=1&language=en&format=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json: any = await res.json();
    const hit = json?.results?.[0];
    if (!hit || typeof hit.latitude !== "number" || typeof hit.longitude !== "number") {
      return null;
    }
    const label = [hit.name, hit.country].filter(Boolean).join(", ");
    return { lat: hit.latitude, lon: hit.longitude, label };
  } catch {
    return null;
  }
}

// Fetches hourly precipitation and wind for [startISO, endISO] at a location.
// Returns null when the archive has nothing for the range (e.g. the reanalysis
// lag of ~5 days, or a network failure) — callers must treat that as
// "unavailable", never as "no weather".
export async function fetchHourlyWeather(
  lat: number,
  lon: number,
  startISO: string,
  endISO: string
): Promise<HourlyWeatherWindow | null> {
  const startDate = startISO.slice(0, 10);
  const endDate = endISO.slice(0, 10);
  const url =
    `${ARCHIVE_URL}?latitude=${lat}&longitude=${lon}` +
    `&start_date=${startDate}&end_date=${endDate}` +
    `&hourly=precipitation,wind_speed_10m,wind_gusts_10m` +
    `&wind_speed_unit=kn&timezone=UTC`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json: any = await res.json();
    const hourly = json?.hourly;
    if (!hourly?.time?.length) return null;

    // Slice to the actual window (API returns whole days, UTC).
    const startMs = new Date(startISO).getTime();
    const endMs = new Date(endISO).getTime();
    const times: string[] = [];
    const precipitationMm: Array<number | null> = [];
    const windSpeedKn: Array<number | null> = [];
    const windGustKn: Array<number | null> = [];

    for (let i = 0; i < hourly.time.length; i++) {
      const t = new Date(`${hourly.time[i]}:00Z`).getTime();
      if (t >= startMs && t < endMs) {
        times.push(hourly.time[i]);
        precipitationMm.push(hourly.precipitation?.[i] ?? null);
        windSpeedKn.push(hourly.wind_speed_10m?.[i] ?? null);
        windGustKn.push(hourly.wind_gusts_10m?.[i] ?? null);
      }
    }

    if (times.length === 0) return null;
    // An all-null window means the archive hasn't caught up to these dates.
    const hasAnyReading = precipitationMm.some((v) => v !== null) ||
      windSpeedKn.some((v) => v !== null);
    if (!hasAnyReading) return null;

    return { times, precipitationMm, windSpeedKn, windGustKn };
  } catch {
    return null;
  }
}

// Thresholds for judging a claimed weather delay against the archive.
// CORROBORATE_*: conditions that plausibly stop cargo operations.
// CONTRADICT_*: ceilings below which "weather delay" is not credible.
// The gap between the two bands is deliberately inconclusive.
export const WEATHER_THRESHOLDS = {
  CORROBORATE_PRECIP_MM: 0.5,
  CORROBORATE_GUST_KN: 25,
  CORROBORATE_WIND_KN: 20,
  CONTRADICT_PRECIP_MM: 0.1,
  CONTRADICT_GUST_KN: 15,
} as const;

export type WeatherVerdict = "corroborated" | "contradicted" | "inconclusive";

export interface WeatherAssessment {
  verdict: WeatherVerdict;
  maxPrecipMm: number;
  maxWindKn: number;
  maxGustKn: number;
  hoursExamined: number;
}

export function assessWeatherWindow(window: HourlyWeatherWindow): WeatherAssessment {
  const max = (xs: Array<number | null>) =>
    xs.reduce<number>((acc, v) => (v !== null && v > acc ? v : acc), 0);

  const maxPrecipMm = max(window.precipitationMm);
  const maxWindKn = max(window.windSpeedKn);
  const maxGustKn = max(window.windGustKn);

  let verdict: WeatherVerdict = "inconclusive";
  if (
    maxPrecipMm >= WEATHER_THRESHOLDS.CORROBORATE_PRECIP_MM ||
    maxGustKn >= WEATHER_THRESHOLDS.CORROBORATE_GUST_KN ||
    maxWindKn >= WEATHER_THRESHOLDS.CORROBORATE_WIND_KN
  ) {
    verdict = "corroborated";
  } else if (
    maxPrecipMm <= WEATHER_THRESHOLDS.CONTRADICT_PRECIP_MM &&
    maxGustKn < WEATHER_THRESHOLDS.CONTRADICT_GUST_KN
  ) {
    verdict = "contradicted";
  }

  return {
    verdict,
    maxPrecipMm,
    maxWindKn,
    maxGustKn,
    hoursExamined: window.times.length,
  };
}
