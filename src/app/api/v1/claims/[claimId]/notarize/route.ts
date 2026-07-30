import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { resolveCaller } from "@/lib/api/caller";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { loadClaimSnapshotInputs } from "@/lib/legal/notary-server";
import {
  buildAuditDossier,
  canonicalJson,
  generateCryptographicSnapshot,
  sha256Hex,
  SNAPSHOT_ALGO,
  type SnapshotLedger,
} from "@/lib/legal/prosecution";
import { buildMrvLedgerEntry } from "@/lib/compliance/carbon";
import type { CalculationTotals, CpTerms } from "@/lib/laytime/types";

const NotarizeSchema = z.object({
  // Also ledger an MRV/ETS emissions entry derived from the delay hours.
  includeMrv: z.boolean().default(false),
  // Freeze the claim record after notarization (claims.is_locked).
  lock: z.boolean().default(false),
});

// Immutable time-proof snapshot: Merkle-notarizes the claim's confirmed
// timeline, hour-by-hour breakdown and CP clause configuration into the
// append-only compliance_ledger, and returns the audit dossier. Everything
// hashed is exactly what the database holds at this instant — the snapshot
// is evidence of record integrity, not a recomputation.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();

    const parsed = NotarizeSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = await createClient();
    // Ownership is checked here, then the ledger is assembled by the SHARED
    // loader. This route used to duplicate that assembly verbatim, which meant
    // two code paths could disagree about what a snapshot commits to — and they
    // did the moment the derivation record was added: this one kept producing
    // pre-derivation roots while the sweep produced new ones for the same claim.
    const { data: owner } = await supabase
      .from("claims")
      .select("id, company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!owner || owner.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

    const asOf = new Date().toISOString();
    const { claim, ledger, calculationComputedAt } = await loadClaimSnapshotInputs(
      claimId,
      supabase,
      asOf,
    );
    const snapshot = generateCryptographicSnapshot(claimId, ledger);

    const { data: entry, error: entryErr } = await supabase
      .from("compliance_ledger")
      .insert({
        claim_id: claimId,
        entry_kind: "time_proof",
        cryptographic_signature: snapshot.merkleRoot,
        signature_algo: SNAPSHOT_ALGO,
        details: {
          as_of: asOf,
          leaf_count: snapshot.leafCount,
          leaves: snapshot.leaves,
          calculation_computed_at: calculationComputedAt,
        },
        recorded_by: auth.userId,
      })
      .select("id")
      .single();
    if (entryErr || !entry) throw new Error(`PERSIST_FAILED: ${entryErr?.message}`);

    let mrvEntryId: string | null = null;
    if (parsed.data.includeMrv) {
      const mrv = buildMrvLedgerEntry({
        // Already computed by the shared loader; recomputing it here is how the
        // two paths would drift apart again.
        delayHours: ledger.totals.time_on_demurrage_hours,
      });
      const { data: mrvRow, error: mrvErr } = await supabase
        .from("compliance_ledger")
        .insert({
          claim_id: claimId,
          entry_kind: "mrv_ets",
          mrv_co2_tonnes: mrv.mrv_co2_tonnes,
          scope3_co2_tonnes: mrv.scope3_co2_tonnes,
          eua_liability_eur: mrv.eua_liability_eur,
          details: { ...mrv.details, evidence: mrv.evidence },
          cryptographic_signature: sha256Hex(`mrv_ets|${claimId}|${canonicalJson(mrv)}`),
          signature_algo: "sha256-canonical-v1",
          recorded_by: auth.userId,
        })
        .select("id")
        .single();
      if (mrvErr || !mrvRow) throw new Error(`PERSIST_FAILED: ${mrvErr?.message}`);
      mrvEntryId = mrvRow.id;
    }

    if (parsed.data.lock) {
      const { error: lockErr } = await supabase
        .from("claims")
        .update({ is_locked: true })
        .eq("id", claimId);
      if (lockErr) throw new Error(`PERSIST_FAILED: ${lockErr.message}`);
    }

    return NextResponse.json(
      {
        entryId: entry.id,
        mrvEntryId,
        merkleRoot: snapshot.merkleRoot,
        leafCount: snapshot.leafCount,
        locked: parsed.data.lock,
        dossier: buildAuditDossier(snapshot, {
          vessel: claim.vessel,
          voyageRef: claim.voyage_ref,
          port: claim.port,
        }),
      },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "v1/claims/notarize/POST", {
      NO_CALCULATION: 409,
      NO_CONFIRMED_EVENTS: 409,
    });
  }
}

// The claim's compliance ledger — newest first.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const caller = await resolveCaller(req, "documents:read");
    const supabase = caller.client;

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, is_locked")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== caller.companyId) throw new Error("CLAIM_NOT_FOUND");

    const { data: entries } = await supabase
      .from("compliance_ledger")
      .select(
        "id, entry_kind, scope3_co2_tonnes, mrv_co2_tonnes, eua_liability_eur, cryptographic_signature, signature_algo, recorded_at"
      )
      .eq("claim_id", claimId)
      .order("recorded_at", { ascending: false })
      .limit(100);

    return NextResponse.json({ isLocked: claim.is_locked === true, entries: entries ?? [] });
  } catch (e) {
    return apiError(e, "v1/claims/notarize/GET");
  }
}
