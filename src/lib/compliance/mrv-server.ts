// MRV reporting bridge: loads a company's voyages for a reporting period,
// builds the annual report, seals it, and appends the seal.
//
// The pure half (mrv.ts) owns the refusal rules; this half owns the DB. It
// loads only CONFIRMED events — an unreviewed extraction cannot evidence a
// regulatory figure — and carries each event's AIS verdict through, because
// that verdict is what decides whether a port call is independently
// corroborated or merely asserted by the Statement of Facts.
//
// Measured bunker data has no table in this system: it arrives per request
// and is the seam that turns NOT MONITORED rows into real ones. Nothing here
// invents it, and nothing falls back to the assumed at-berth burn rate.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  buildMrvAnnualReport,
  sealMrvReport,
  type MrvAnnualReport,
  type MrvSeal,
  type MrvVoyageInput,
} from "./mrv";
import type { EventTypeEnum } from "@/lib/laytime/types";

// Per-voyage monitoring data supplied by the caller for this run.
export type MrvVoyageOverride = Pick<
  MrvVoyageInput,
  "fuel" | "eeaPort" | "distanceNm" | "timeAtSeaHours" | "cargoTonnes"
>;

const COMPLETION: EventTypeEnum[] = ["COMPLETED_LOADING", "COMPLETED_DISCHARGE"];

export async function loadMrvVoyages(
  companyId: string,
  reportingPeriod: number,
  overrides: Record<string, MrvVoyageOverride>,
  client?: SupabaseClient
): Promise<MrvVoyageInput[]> {
  const supabase = client ?? (await createClient());

  // ets_applicable is the operator's existing judgement on whether the EU
  // carbon regime reaches this port call — the same question MRV scope asks.
  // Reuse it rather than demand the answer twice. It is nullable and unset by
  // default, and null means unknown: the report then declines to assert
  // scope either way instead of assuming (the port field is free text —
  // "Port Hedland, AU" is not an EEA call, and nothing derives that).
  const { data: claims } = await supabase
    .from("claims")
    .select("id, vessel, voyage_ref, port, vessel_imo, ets_applicable")
    .eq("company_id", companyId);
  const claimRows = claims ?? [];
  if (claimRows.length === 0) return [];

  const { data: events } = await supabase
    .from("sof_events")
    .select("claim_id, event_type, occurred_at, ais_geofence_verified")
    .in(
      "claim_id",
      claimRows.map((c) => c.id)
    )
    .in("status", ["accepted", "edited"])
    .order("occurred_at", { ascending: true });

  const byClaim = new Map<string, MrvVoyageInput["events"]>();
  for (const e of events ?? []) {
    const list = byClaim.get(e.claim_id) ?? [];
    list.push({
      event_type: e.event_type as EventTypeEnum,
      occurred_at: e.occurred_at as string,
      ais_geofence_verified: e.ais_geofence_verified as boolean | null,
    });
    byClaim.set(e.claim_id, list);
  }

  const voyages: MrvVoyageInput[] = [];
  for (const c of claimRows) {
    const evs = byClaim.get(c.id) ?? [];
    // A voyage belongs to the period by its cargo completion — the same
    // anchor the time bar and the ROI window use. No confirmed completion →
    // the voyage isn't in any period yet, rather than silently in this one.
    const completions = evs
      .filter((e) => COMPLETION.includes(e.event_type))
      .map((e) => new Date(e.occurred_at))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    const anchor = completions[completions.length - 1];
    if (!anchor || anchor.getUTCFullYear() !== reportingPeriod) continue;

    voyages.push({
      claimId: c.id,
      voyageRef: c.voyage_ref,
      vessel: c.vessel,
      vesselImo: c.vessel_imo ?? null,
      port: c.port,
      events: evs,
      // null (unset) stays undefined → reported as unknown scope, not false.
      eeaPort: c.ets_applicable ?? undefined,
      // A caller-supplied override wins: it carries the measured data.
      ...(overrides[c.id] ?? {}),
    });
  }
  return voyages;
}

export interface SealedMrvReport {
  report: MrvAnnualReport;
  seal: MrvSeal;
  id: string | null;
}

export async function generateAndSealMrvReport(opts: {
  companyId: string;
  companyName: string;
  reportingPeriod: number;
  overrides?: Record<string, MrvVoyageOverride>;
  userId?: string;
  client?: SupabaseClient;
  persist?: boolean;
}): Promise<SealedMrvReport> {
  const supabase = opts.client ?? (await createClient());
  const voyages = await loadMrvVoyages(
    opts.companyId,
    opts.reportingPeriod,
    opts.overrides ?? {},
    supabase
  );

  const report = buildMrvAnnualReport({
    companyName: opts.companyName,
    reportingPeriod: opts.reportingPeriod,
    voyages,
  });
  const seal = sealMrvReport(report);

  if (opts.persist === false) return { report, seal, id: null };

  // Append, never replace: an earlier seal is the only evidence of what the
  // book looked like then.
  const { data, error } = await supabase
    .from("mrv_reports")
    .insert({
      company_id: opts.companyId,
      reporting_period: opts.reportingPeriod,
      report,
      merkle_root: seal.merkleRoot,
      signature_algo: seal.algo,
      leaf_count: seal.leafCount,
      submittable: report.submittable,
      // verification_status is left to its column default: only an accredited
      // verifier can move it, and that does not happen in this system.
      generated_by: opts.userId ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`PERSIST_FAILED: ${error.message}`);

  return { report, seal, id: data.id };
}
