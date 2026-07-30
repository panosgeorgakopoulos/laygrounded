import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";

// Cargo weather profiles for the tenant.
//
// GET returns the curated globals with any tenant override merged in, so the
// settings screen can show one list rather than making an operator reason about
// two layers.
//
// PATCH writes a tenant-scoped OVERRIDE rather than editing the global. Globals
// are shared reference data: editing one in place would silently change every
// other tenant's calculations, which is the kind of change nobody would notice
// until a claim was already argued.

// Every threshold is tunable. A charterer whose contract says 0.4 mm/h cannot
// use a tool that insists on 0.2 — and the resolver now attributes each fired
// threshold to whoever set it, so a custom figure is disclosed rather than
// hidden. Traceability is what makes tuning safe to offer.
//
// `null` is a first-class value meaning INSENSITIVE, distinct from omitting the
// field (leave as-is) and from zero (stop on the first drop). The three cases
// are genuinely different and the schema keeps them apart.
const Threshold = z.number().finite().min(0).max(1000).nullable();

const PatchSchema = z.object({
  cargoKey: z.string().min(1).max(60),
  minStoppageMinutes: z.number().int().min(5).max(1440).optional(),
  precipMmPerHr: Threshold.optional(),
  windKn: Threshold.optional(),
  gustKn: Threshold.optional(),
});

interface Row {
  id: string;
  company_id: string | null;
  cargo_key: string;
  label: string;
  precip_mm_per_hr: number | null;
  wind_kn: number | null;
  gust_kn: number | null;
  min_stoppage_minutes: number;
  source_label: string;
  notes: string | null;
}

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("cargo_weather_profiles")
      .select(
        "id, company_id, cargo_key, label, precip_mm_per_hr, wind_kn, gust_kn, min_stoppage_minutes, source_label, notes"
      )
      .or(`company_id.eq.${auth.companyId},company_id.is.null`)
      .order("label");
    if (error) throw new Error(`PROFILE_QUERY_FAILED: ${error.message}`);

    const rows = (data ?? []) as Row[];
    const overrides = new Map(
      rows.filter((r) => r.company_id !== null).map((r) => [r.cargo_key, r])
    );

    // One row per cargo: the global, annotated with whether this tenant has
    // tuned it and what the shared baseline was before they did.
    const merged = rows
      .filter((r) => r.company_id === null)
      .map((g) => {
        const o = overrides.get(g.cargo_key);
        return {
          cargoKey: g.cargo_key,
          label: g.label,
          precipMmPerHr: o ? o.precip_mm_per_hr : g.precip_mm_per_hr,
          windKn: o ? o.wind_kn : g.wind_kn,
          gustKn: o ? o.gust_kn : g.gust_kn,
          minStoppageMinutes: o?.min_stoppage_minutes ?? g.min_stoppage_minutes,
          // The shared baseline, so the UI can show what a tuned figure departs
          // from and offer an honest reset.
          baseline: {
            precipMmPerHr: g.precip_mm_per_hr,
            windKn: g.wind_kn,
            gustKn: g.gust_kn,
            minStoppageMinutes: g.min_stoppage_minutes,
          },
          defaultMinStoppageMinutes: g.min_stoppage_minutes,
          overridden: !!o,
          overriddenDimensions: o
            ? ([
                o.precip_mm_per_hr !== g.precip_mm_per_hr ? "precipitation" : null,
                o.wind_kn !== g.wind_kn ? "wind" : null,
                o.gust_kn !== g.gust_kn ? "gust" : null,
              ].filter(Boolean) as string[])
            : [],
          sourceLabel: o?.source_label ?? g.source_label,
          notes: g.notes,
        };
      });

    return NextResponse.json({ profiles: merged });
  } catch (e) {
    return apiError(e, "settings/cargo-profiles/GET", { PROFILE_QUERY_FAILED: 503 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { cargoKey, ...patch } = parsed.data;

    // The override copies the global's thresholds so the resolver reads one
    // complete row. Copying rather than referencing is deliberate: a later
    // change to the shared baseline must not silently move a tenant's already
    // tuned profile underneath them.
    const { data: global } = await supabase
      .from("cargo_weather_profiles")
      .select("cargo_key, label, precip_mm_per_hr, wind_kn, gust_kn, min_temp_c, max_temp_c, min_stoppage_minutes, aliases")
      .is("company_id", null)
      .eq("cargo_key", cargoKey)
      .maybeSingle();
    if (!global) {
      return NextResponse.json({ error: "UNKNOWN_CARGO" }, { status: 404 });
    }

    // Any existing override is the base for a partial edit; otherwise the
    // global is. Editing one threshold must not silently reset the others a
    // tenant already tuned.
    const { data: existing } = await supabase
      .from("cargo_weather_profiles")
      .select("precip_mm_per_hr, wind_kn, gust_kn, min_stoppage_minutes")
      .eq("company_id", auth.companyId)
      .eq("cargo_key", cargoKey)
      .maybeSingle();

    const current = existing ?? {
      precip_mm_per_hr: global.precip_mm_per_hr,
      wind_kn: global.wind_kn,
      gust_kn: global.gust_kn,
      min_stoppage_minutes: global.min_stoppage_minutes,
    };

    // `undefined` means "leave alone"; an explicit null means "insensitive".
    const pick = <T,>(next: T | undefined, cur: T): T => (next === undefined ? cur : next);

    const row = {
      company_id: auth.companyId,
      cargo_key: global.cargo_key,
      label: global.label,
      precip_mm_per_hr: pick(patch.precipMmPerHr, current.precip_mm_per_hr),
      wind_kn: pick(patch.windKn, current.wind_kn),
      gust_kn: pick(patch.gustKn, current.gust_kn),
      min_temp_c: global.min_temp_c,
      max_temp_c: global.max_temp_c,
      aliases: global.aliases ?? [],
      min_stoppage_minutes: pick(patch.minStoppageMinutes, current.min_stoppage_minutes),
      source_label: `Tuned by your company (baseline: ${global.label})`,
      created_by: auth.userId,
      updated_at: new Date().toISOString(),
    };

    // If the result is identical to the baseline in every respect, drop the
    // override rather than keeping a row that claims to be a custom threshold
    // while changing nothing — the resolver would then wrongly announce
    // "tenant custom thresholds" over a figure that is purely ours.
    const identical =
      row.precip_mm_per_hr === global.precip_mm_per_hr &&
      row.wind_kn === global.wind_kn &&
      row.gust_kn === global.gust_kn &&
      row.min_stoppage_minutes === global.min_stoppage_minutes;

    if (identical) {
      const { error: delErr } = await supabase
        .from("cargo_weather_profiles")
        .delete()
        .eq("company_id", auth.companyId)
        .eq("cargo_key", cargoKey);
      if (delErr) throw new Error(`PROFILE_SAVE_FAILED: ${delErr.message}`);
      return NextResponse.json({ saved: true, cargoKey, reverted: true });
    }

    const { error } = await supabase
      .from("cargo_weather_profiles")
      .upsert(row, { onConflict: "company_id,cargo_key" });
    if (error) throw new Error(`PROFILE_SAVE_FAILED: ${error.message}`);

    return NextResponse.json({
      saved: true,
      cargoKey,
      profile: {
        precipMmPerHr: row.precip_mm_per_hr,
        windKn: row.wind_kn,
        gustKn: row.gust_kn,
        minStoppageMinutes: row.min_stoppage_minutes,
      },
    });
  } catch (e) {
    return apiError(e, "settings/cargo-profiles/PATCH", { PROFILE_SAVE_FAILED: 503 });
  }
}
