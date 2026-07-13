import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
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
    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, vessel, voyage_ref, port, cp_terms")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");
    if (!claim.cp_terms) throw new Error("NO_CP_TERMS");

    const [{ data: events }, { data: calc }] = await Promise.all([
      supabase
        .from("sof_events")
        .select("id, event_type, occurred_at")
        .eq("claim_id", claimId)
        .in("status", ["accepted", "edited"])
        .order("occurred_at", { ascending: true }),
      supabase
        .from("laytime_calculations")
        .select("breakdown, allowed_hours, used_hours, demurrage_amount, despatch_amount, currency, computed_at")
        .eq("claim_id", claimId)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (!calc) throw new Error("NO_CALCULATION");
    if (!events || events.length === 0) throw new Error("NO_CONFIRMED_EVENTS");

    const cpTerms = claim.cp_terms as CpTerms;
    const totals: CalculationTotals = {
      allowed_hours: calc.allowed_hours,
      used_hours: calc.used_hours,
      time_on_demurrage_hours: Math.max(calc.used_hours - calc.allowed_hours, 0),
      time_saved_hours: Math.max(calc.allowed_hours - calc.used_hours, 0),
      demurrage_amount: calc.demurrage_amount ?? 0,
      despatch_amount: calc.despatch_amount ?? 0,
      currency: calc.currency ?? cpTerms.currency,
    };

    const asOf = new Date().toISOString();
    const ledger: SnapshotLedger = {
      cpTerms,
      totals,
      breakdown: Array.isArray(calc.breakdown) ? calc.breakdown : [],
      events,
      asOf,
    };
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
          calculation_computed_at: calc.computed_at,
        },
        recorded_by: auth.userId,
      })
      .select("id")
      .single();
    if (entryErr || !entry) throw new Error(`PERSIST_FAILED: ${entryErr?.message}`);

    let mrvEntryId: string | null = null;
    if (parsed.data.includeMrv) {
      const mrv = buildMrvLedgerEntry({
        delayHours: Math.max(calc.used_hours - calc.allowed_hours, 0),
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
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, is_locked")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");

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
