// CSV export of a claim, for the owner.
//
// A SUBROUTE RATHER THAN A METHOD ON `/export`. That endpoint already exists
// and already means something: `POST /export` builds the PDF + XLSX claim pack
// and returns JSON with URLs to them. Hanging a file download off its GET would
// give one path two unrelated representations, and the workspace's existing
// "Export" button posts to it — a change there is a change to shipped
// behaviour for the sake of a URL.
//
// Note the pack ALREADY produces an XLSX. This is not a duplicate of it: the
// pack is a rendered document set, assembled server-side and stored, meant to
// be attached to a claim submission. This is the raw tabular data, streamed,
// meant to be opened and pivoted. Operators want both and use them differently.
//
// Any member of the owning company may export, viewers included. A viewer is
// defined as someone who may see claims, calculations and evidence; a CSV is
// those facts in a different container, and gating it higher would mean a role
// could read a figure on screen but not take it into a meeting.

import { NextRequest, NextResponse } from "next/server";
import { requireOwnedClaim } from "@/lib/audit/claim-access";
import { readVerifierManifest } from "@/lib/finance/verifier-manifest";
import { resolveClaimEngineVersion } from "@/lib/laytime/engine-version";
import { claimToCsv, csvFileBody, csvFilename } from "@/lib/export-csv";
import { apiError } from "@/lib/api-errors";

interface ClaimRow {
  id: string;
  company_id: string;
  vessel: string;
  voyage_ref: string;
  port: string;
  cargo: string;
  cp_form: string | null;
  engine_version: number | null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const { claim, supabase } = await requireOwnedClaim<ClaimRow>(
      claimId,
      "id, company_id, vessel, voyage_ref, port, cargo, cp_form, engine_version",
      req
    );

    // Confirmed events only, matching the engine and the shared statement: a
    // `suggested` row is an unreviewed machine extraction, and exporting it
    // beside confirmed evidence in one undifferentiated list invites somebody
    // to rely on it.
    const { data: events } = await supabase
      .from("sof_events")
      .select("occurred_at, event_type, raw_text, source, status")
      .eq("claim_id", claimId)
      .in("status", ["accepted", "edited"])
      .order("occurred_at", { ascending: true });

    const { data: calculation } = await supabase
      .from("laytime_calculations")
      .select("*")
      .eq("claim_id", claimId)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const engineVersion = resolveClaimEngineVersion(claim);
    const manifest = readVerifierManifest(engineVersion);

    const csv = claimToCsv({
      header: {
        vessel: claim.vessel ?? "",
        voyageRef: claim.voyage_ref ?? "",
        port: claim.port ?? "",
        cargo: claim.cargo ?? "",
        cpForm: claim.cp_form,
        engineVersion,
        // Empty when the build artefact is absent, never a placeholder that
        // could be mistaken for a real fingerprint.
        conformanceRoot: manifest.conformanceRoot || null,
        generatedAt: new Date().toISOString(),
      },
      totals: calculation
        ? {
            allowed_hours: calculation.allowed_hours ?? 0,
            used_hours: calculation.used_hours ?? 0,
            time_on_demurrage_hours: calculation.time_on_demurrage_hours ?? 0,
            time_saved_hours: calculation.time_saved_hours ?? 0,
            ...(typeof calculation.demurrage_half_rate_hours === "number"
              ? { demurrage_half_rate_hours: calculation.demurrage_half_rate_hours }
              : {}),
            demurrage_amount: calculation.demurrage_amount ?? 0,
            despatch_amount: calculation.despatch_amount ?? 0,
            currency: calculation.currency ?? "USD",
          }
        : null,
      breakdown: Array.isArray(calculation?.breakdown) ? calculation.breakdown : [],
      events: (events ?? []).map((e) => ({
        occurredAt: e.occurred_at,
        eventType: e.event_type,
        rawText: e.raw_text,
        source: e.source,
        status: e.status,
      })),
    });

    return new NextResponse(csvFileBody(csv), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(
          [claim.vessel, claim.voyage_ref],
          "laytime"
        )}"`,
        "Cache-Control": "no-store, private",
      },
    });
  } catch (e) {
    return apiError(e, "claims/export/csv/GET");
  }
}
