import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import {
  buildEftiConsignment,
  EFTI_SCHEMA_VERSION,
  EFTI_SIGNATURE_ALGO,
} from "@/lib/interop/efti";
import { SNAPSHOT_ALGO } from "@/lib/legal/prosecution";
import type { EventTypeEnum } from "@/lib/laytime/types";

const EftiSchema = z.object({
  claimId: z.string().uuid(),
  includeLaytime: z.boolean().default(true),
});

// Federated eFTI node endpoint: packages the claim's verified voyage record
// into a signed, standardized consignment payload for port authorities and
// inland logistics providers. Owner-initiated export — the tenant generates
// the packet and forwards it through their own channel; every export is
// ledgered append-only (compliance_ledger, entry_kind 'efti_export') so
// there is a verifiable record of exactly what left the tenant and under
// which signature. When the claim has a notarized time-proof, its Merkle
// root anchors the packet to the immutable hourly record.
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();

    const parsed = EftiSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { claimId, includeLaytime } = parsed.data;

    const supabase = await createClient();
    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, vessel, vessel_imo, voyage_ref, port, cargo, counterparty_name")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const [{ data: events }, { data: calc }, { data: anchor }] = await Promise.all([
      supabase
        .from("sof_events")
        .select("event_type, occurred_at, ais_geofence_verified")
        .eq("claim_id", claimId)
        .in("status", ["accepted", "edited"])
        .order("occurred_at", { ascending: true }),
      supabase
        .from("laytime_calculations")
        .select("allowed_hours, used_hours, demurrage_amount, despatch_amount, currency")
        .eq("claim_id", claimId)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("compliance_ledger")
        .select("cryptographic_signature, signature_algo")
        .eq("claim_id", claimId)
        .eq("entry_kind", "time_proof")
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (!events || events.length === 0) throw new Error("NO_CONFIRMED_EVENTS");

    const consignment = buildEftiConsignment({
      claim: {
        id: claim.id,
        vessel: claim.vessel,
        vesselImo: claim.vessel_imo ?? null,
        voyageRef: claim.voyage_ref,
        port: claim.port,
        cargo: claim.cargo,
        counterpartyName: claim.counterparty_name ?? null,
      },
      events: events.map((e) => ({
        event_type: e.event_type as EventTypeEnum,
        occurred_at: e.occurred_at,
        ais_geofence_verified: e.ais_geofence_verified,
      })),
      totals:
        includeLaytime && calc
          ? {
              allowed_hours: calc.allowed_hours,
              used_hours: calc.used_hours,
              demurrage_amount: calc.demurrage_amount ?? 0,
              despatch_amount: calc.despatch_amount ?? 0,
              currency: calc.currency ?? "USD",
            }
          : null,
      anchorMerkleRoot:
        anchor?.signature_algo === SNAPSHOT_ALGO ? anchor.cryptographic_signature : null,
      generatedAt: new Date().toISOString(),
    });

    const { data: entry, error: entryErr } = await supabase
      .from("compliance_ledger")
      .insert({
        claim_id: claimId,
        entry_kind: "efti_export",
        cryptographic_signature: consignment.integrity.data_sha256,
        signature_algo: EFTI_SIGNATURE_ALGO,
        details: {
          schema: EFTI_SCHEMA_VERSION,
          generated_at: consignment.generated_at,
          milestone_count: consignment.port_call.milestones.length,
          anchored_merkle_root: consignment.integrity.anchored_merkle_root,
          includes_laytime_summary: consignment.laytime_summary !== null,
        },
        recorded_by: auth.userId,
      })
      .select("id")
      .single();
    if (entryErr || !entry) throw new Error(`PERSIST_FAILED: ${entryErr?.message}`);

    return NextResponse.json({ consignment, ledgerEntryId: entry.id }, { status: 201 });
  } catch (e) {
    return apiError(e, "v1/interoperability/efti/POST", {
      NO_CONFIRMED_EVENTS: 409,
      NO_EXPORTABLE_MILESTONES: 422,
    });
  }
}

// Export history for a claim (?claimId=…) — newest first.
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const claimId = req.nextUrl.searchParams.get("claimId");
    if (!claimId) {
      return NextResponse.json({ error: "VALIDATION_ERROR", details: "claimId is required" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const { data: exports } = await supabase
      .from("compliance_ledger")
      .select("id, cryptographic_signature, signature_algo, details, recorded_at")
      .eq("claim_id", claimId)
      .eq("entry_kind", "efti_export")
      .order("recorded_at", { ascending: false })
      .limit(50);

    return NextResponse.json({ exports: exports ?? [] });
  } catch (e) {
    return apiError(e, "v1/interoperability/efti/GET");
  }
}
