import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { geocodePort, fetchHourlyWeather } from "@/lib/evidence/weather";
import {
  resolveWeatherWorkingTime,
  type CargoWeatherProfile,
  type HourlyObservation,
} from "@/lib/weather/wwd-resolver";
import { renderWeatherReportPdf } from "@/lib/tools/weather-report-pdf";
import {
  clientIp,
  hashIp,
  consumePublicQuota,
  isPlausibleWorkEmail,
  isConsumerDomain,
  PUBLIC_TOOL_DAILY_LIMIT,
} from "@/lib/tools/public-tools";

// The gated artefact: a PDF report, in exchange for an email.
//
// THE SUMMARY ON SCREEN STAYS FREE. Only the document costs an address. A
// visitor who just wants to know whether it rained gets their answer; a visitor
// who wants something to forward to a counterparty is the one worth talking to.
//
// THE REPORT IS REGENERATED SERVER-SIDE from the query, never rendered from
// figures the client posts back. Two reasons, and the second matters more:
// a caller could otherwise mint an official-looking LayGrounded document
// asserting any number they liked, and the whole product claim is that these
// figures are reproducible rather than asserted. Regenerating costs one archive
// call and keeps the document honest.
//
// It carries its OWN daily counter rather than sharing the checker's. Sharing
// would mean a visitor who used all three checks could never download the
// report they just looked at — while leaving it uncounted would turn it into an
// uncapped free weather API with a PDF wrapper.
const TOOL = "weather-checker-pdf";
const MAX_WINDOW_DAYS = 31;

const ReportSchema = z.object({
  email: z.string().min(5).max(254),
  port: z.string().min(2).max(120),
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

const fail = (status: number, error: string, message: string) =>
  NextResponse.json({ error, message }, { status });

export async function POST(req: NextRequest) {
  const parsed = ReportSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { email, port, start, end, cargoKey } = parsed.data;

  if (!isPlausibleWorkEmail(email)) {
    return fail(400, "INVALID_EMAIL", "That does not look like an email address.");
  }

  const from = new Date(start);
  const to = new Date(end);
  if (to <= from) return fail(400, "INVALID_WINDOW", "The end date must be after the start date.");
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_WINDOW_DAYS) {
    return fail(400, "WINDOW_TOO_LONG", `Reports cover up to ${MAX_WINDOW_DAYS} days.`);
  }
  if (to.getTime() > Date.now()) {
    return fail(400, "FUTURE_WINDOW", "The weather archive only covers the past.");
  }

  const service = createServiceRoleClient();
  const ipHash = hashIp(clientIp(req.headers));

  // Global profiles only — a public caller never sees a tenant's tuning.
  const { data: profileRows } = await service
    .from("cargo_weather_profiles")
    .select(
      "cargo_key, label, precip_mm_per_hr, wind_kn, gust_kn, min_temp_c, max_temp_c, min_stoppage_minutes, source_label"
    )
    .is("company_id", null);
  const profileRow = ((profileRows ?? []) as ProfileRow[]).find((r) => r.cargo_key === cargoKey);
  if (!profileRow) return fail(400, "UNKNOWN_CARGO", "That cargo profile is not available.");

  // Quota after the cheap checks, before the first upstream call.
  const quota = await consumePublicQuota(service, ipHash, TOOL);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: "QUOTA_EXCEEDED",
        message: `Free reports are limited to ${PUBLIC_TOOL_DAILY_LIMIT} per day.`,
      },
      { status: 429, headers: { "Retry-After": String(quota.resetInSeconds) } }
    );
  }

  const location = await geocodePort(port);
  if (!location) return fail(404, "PORT_NOT_FOUND", `We could not locate "${port}".`);

  const window = { from: from.toISOString(), to: to.toISOString() };
  const hourlyWindow = await fetchHourlyWeather(
    location.lat,
    location.lon,
    window.from,
    window.to
  );
  if (!hourlyWindow) {
    return fail(
      503,
      "ARCHIVE_UNAVAILABLE",
      "The weather archive returned nothing for that window."
    );
  }

  const hourly: HourlyObservation[] = hourlyWindow.times.map((t, i) => ({
    at: new Date(`${t}:00Z`).toISOString(),
    precipitationMm: hourlyWindow.precipitationMm[i] ?? null,
    windSpeedKn: hourlyWindow.windSpeedKn[i] ?? null,
    windGustKn: hourlyWindow.windGustKn[i] ?? null,
  }));

  const profile: CargoWeatherProfile = {
    cargoKey: profileRow.cargo_key,
    label: profileRow.label,
    precipMmPerHr: profileRow.precip_mm_per_hr,
    windKn: profileRow.wind_kn,
    gustKn: profileRow.gust_kn,
    minTempC: profileRow.min_temp_c,
    maxTempC: profileRow.max_temp_c,
    minStoppageMinutes: profileRow.min_stoppage_minutes,
    sourceLabel: profileRow.source_label,
  };

  const resolution = resolveWeatherWorkingTime({ window, hourly, profile });

  // The lead is recorded before the document is handed over, but a failed write
  // must not deny the download — losing a row is our problem, making someone
  // re-type an email to get a file they already earned is theirs.
  await service
    .from("public_tool_leads")
    .insert({
      email: email.trim(),
      tool: TOOL,
      context: {
        port,
        cargoKey,
        start: window.from,
        end: window.to,
        totalExceptedHours: resolution.totalExceptedHours,
        consumerDomain: isConsumerDomain(email),
      },
      ip_hash: ipHash,
    })
    .then(undefined, () => undefined);

  const pdf = await renderWeatherReportPdf({
    port: { query: port, resolved: location.label, lat: location.lat, lon: location.lon },
    window,
    thresholds: {
      precipMmPerHr: profileRow.precip_mm_per_hr,
      windKn: profileRow.wind_kn,
      gustKn: profileRow.gust_kn,
      minStoppageMinutes: profileRow.min_stoppage_minutes,
    },
    resolution,
    requestedBy: email.trim(),
    generatedAt: new Date(),
  });

  const slug = port.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="weather-report-${slug}-${window.from.slice(0, 10)}.pdf"`,
      "Cache-Control": "no-store, private",
    },
  });
}
