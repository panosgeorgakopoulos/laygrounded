import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { geocodePort, fetchHourlyWeather } from "@/lib/evidence/weather";
import {
  resolveWeatherWorkingTime,
  type CargoWeatherProfile,
  type HourlyObservation,
} from "@/lib/weather/wwd-resolver";
import {
  clientIp,
  hashIp,
  consumePublicQuota,
  PUBLIC_TOOL_DAILY_LIMIT,
} from "@/lib/tools/public-tools";

// Free Weather Dispute Checker — UNAUTHENTICATED.
//
// THE BOUNDARY: this route touches the pure resolver, the public weather
// archive, and the GLOBAL cargo profiles. It never reads a claim, a company, a
// calculation, or any tenant's own profile override. There is no claim id in
// its contract and no way to supply one.
//
// It runs the same engine the paid product runs, on the visitor's own dates.
// That is the point of the lead magnet: the output is not a teaser, it is the
// real answer for a window they care about — which is far more persuasive than
// a marketing page, and costs us two upstream calls.
const TOOL = "weather-checker";

/** Longest window a free query may cover. A month is plenty for one port call. */
const MAX_WINDOW_DAYS = 31;

const CheckSchema = z.object({
  port: z.string().min(2).max(120),
  // Coerced to a date so an out-of-range string fails here rather than at the
  // archive, where the error would be someone else's and much less clear.
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  cargoKey: z.string().min(1).max(60),
});

interface ProfileRow {
  cargo_key: string;
  label: string;
  precip_mm_per_hr: number | null;
  wind_kn: number | null;
  gust_kn: number | null;
  min_temp_c: number | null;
  max_temp_c: number | null;
  min_stoppage_minutes: number;
  source_label: string;
}

function toProfile(r: ProfileRow): CargoWeatherProfile {
  return {
    cargoKey: r.cargo_key,
    label: r.label,
    precipMmPerHr: r.precip_mm_per_hr,
    windKn: r.wind_kn,
    gustKn: r.gust_kn,
    minTempC: r.min_temp_c,
    maxTempC: r.max_temp_c,
    minStoppageMinutes: r.min_stoppage_minutes,
    sourceLabel: r.source_label,
    // The public tool queries `company_id is null` only, so a profile here can
    // never be a tenant override. Pinned rather than derived so that stays true.
    origin: "baseline",
    overriddenDimensions: [],
  };
}

export async function POST(req: NextRequest) {
  const parsed = CheckSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { port, start, end, cargoKey } = parsed.data;

  const from = new Date(start);
  const to = new Date(end);
  if (to <= from) {
    return NextResponse.json(
      { error: "INVALID_WINDOW", message: "The end date must be after the start date." },
      { status: 400 }
    );
  }
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > MAX_WINDOW_DAYS) {
    return NextResponse.json(
      {
        error: "WINDOW_TOO_LONG",
        message: `Free checks cover up to ${MAX_WINDOW_DAYS} days. Narrow the window to the port call you care about.`,
      },
      { status: 400 }
    );
  }
  // The ERA5 reanalysis lags real time; asking for tomorrow returns nothing and
  // looks like a broken tool rather than an honest limit.
  if (to.getTime() > Date.now()) {
    return NextResponse.json(
      {
        error: "FUTURE_WINDOW",
        message:
          "The weather archive only covers the past. This checks what actually happened, not a forecast.",
      },
      { status: 400 }
    );
  }

  const service = createServiceRoleClient();
  const ipHash = hashIp(clientIp(req.headers));

  // GLOBAL profiles only — `company_id is null`. A public visitor must never
  // see a tenant's tuned thresholds, which are competitively meaningful.
  const { data: profileRows } = await service
    .from("cargo_weather_profiles")
    .select(
      "cargo_key, label, precip_mm_per_hr, wind_kn, gust_kn, min_temp_c, max_temp_c, min_stoppage_minutes, source_label"
    )
    .is("company_id", null);

  const rows = (profileRows ?? []) as ProfileRow[];
  const profileRow = rows.find((r) => r.cargo_key === cargoKey);
  if (!profileRow) {
    return NextResponse.json(
      { error: "UNKNOWN_CARGO", available: rows.map((r) => r.cargo_key) },
      { status: 400 }
    );
  }

  // Quota is consumed HERE — after every cheap check has passed and immediately
  // before the first upstream call. Charging for a rejected request would burn
  // a visitor's free allowance on their own typo, which is both unfair and the
  // fastest way to lose the lead this page exists to capture.
  const quota = await consumePublicQuota(service, ipHash, TOOL);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: "QUOTA_EXCEEDED",
        message: `Free checks are limited to ${PUBLIC_TOOL_DAILY_LIMIT} per day. Get in touch for unlimited access across your whole book.`,
        used: quota.used,
        limit: quota.limit,
      },
      {
        status: 429,
        headers: { "Retry-After": String(quota.resetInSeconds) },
      }
    );
  }

  const location = await geocodePort(port);
  if (!location) {
    return NextResponse.json(
      {
        error: "PORT_NOT_FOUND",
        message: `We could not locate "${port}". Try the city name on its own.`,
      },
      { status: 404 }
    );
  }

  const window = { from: from.toISOString(), to: to.toISOString() };
  const hourlyWindow = await fetchHourlyWeather(
    location.lat,
    location.lon,
    window.from,
    window.to
  );
  if (!hourlyWindow) {
    return NextResponse.json(
      {
        error: "ARCHIVE_UNAVAILABLE",
        message:
          "The weather archive returned nothing for that window. Reanalysis data lags by about five days, so very recent dates may not be published yet.",
      },
      { status: 503 }
    );
  }

  const hourly: HourlyObservation[] = hourlyWindow.times.map((t, i) => ({
    at: new Date(`${t}:00Z`).toISOString(),
    precipitationMm: hourlyWindow.precipitationMm[i] ?? null,
    windSpeedKn: hourlyWindow.windSpeedKn[i] ?? null,
    windGustKn: hourlyWindow.windGustKn[i] ?? null,
  }));

  // No `claimed` intervals: a public visitor has no statement of facts to
  // compare against, so the agreement report is meaningless here and is not
  // fabricated to fill space.
  const resolution = resolveWeatherWorkingTime({
    window,
    hourly,
    profile: toProfile(profileRow),
  });

  return NextResponse.json({
    port: { query: port, resolved: location.label, lat: location.lat, lon: location.lon },
    window,
    profile: resolution.profile,
    thresholds: {
      precipMmPerHr: profileRow.precip_mm_per_hr,
      windKn: profileRow.wind_kn,
      gustKn: profileRow.gust_kn,
      minStoppageMinutes: profileRow.min_stoppage_minutes,
    },
    totalExceptedHours: resolution.totalExceptedHours,
    blocks: resolution.blocks,
    observedHours: resolution.observedHours,
    gapHours: resolution.gapHours,
    warnings: resolution.warnings,
    quota: { used: quota.used, limit: quota.limit },
  });
}

/** The cargo list, so the form can populate itself without a build-time copy. */
export async function GET() {
  const service = createServiceRoleClient();
  const { data } = await service
    .from("cargo_weather_profiles")
    .select("cargo_key, label, precip_mm_per_hr, wind_kn, gust_kn")
    .is("company_id", null)
    .order("label");
  return NextResponse.json({ cargoes: data ?? [] });
}
