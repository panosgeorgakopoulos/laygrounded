// Notary bridge: assemble a claim's snapshot ledger, seal it, anchor it, and
// append it to compliance_ledger. Shared by the manual notarize route and the
// hourly sweep so both mean exactly the same thing by "time proof".
//
// Hourly cadence, but proofs only on CHANGE. Writing an identical root every
// hour would add 24 rows per claim per day that prove nothing new, and — once
// anchoring is on — spend a TSA request on each. Dedupe costs nothing in
// evidential terms: if the root is unchanged then the record is unchanged, so
// the previous proof already covers every instant up to now. An auditor
// asking "what was the state at 14:00?" takes the latest proof at or before
// 14:00, which is precisely what proofAsOf() returns.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  canonicalJson,
  generateCryptographicSnapshot,
  sha256Hex,
  SNAPSHOT_ALGO,
  type SnapshotLedger,
} from "@/lib/legal/prosecution";
import { type TimeProofSnapshot } from "./prosecution";
import { buildDerivationRecord } from "@/lib/legal/derivation";
import { resolveClaimEngineVersion, withEngineVersion } from "@/lib/laytime/engine-version";
import { canonicalEventOrder } from "@laygrounded/laytime-core/gencon94";
import type { SofEventInput } from "@/lib/laytime/types";
import { anchorMerkleRoot, type AnchorOutcome } from "./anchor";
import type { CalculationTotals, CpTerms } from "@/lib/laytime/types";

export interface ClaimSnapshotInputs {
  claim: { id: string; vessel: string; voyage_ref: string; port: string; cp_terms: CpTerms };
  calculationComputedAt: string | null;
  ledger: SnapshotLedger;
}

// Loads everything the notary hashes. Confirmed events only: an unreviewed
// extraction must never end up inside a legal fingerprint.
export async function loadClaimSnapshotInputs(
  claimId: string,
  supabase: SupabaseClient,
  asOf: string
): Promise<ClaimSnapshotInputs> {
  const { data: claim } = await supabase
    .from("claims")
    .select("id, company_id, vessel, voyage_ref, port, cp_terms, engine_version")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) throw new Error("CLAIM_NOT_FOUND");
  if (!claim.cp_terms) throw new Error("NO_CP_TERMS");

  const [{ data: events }, { data: calc }] = await Promise.all([
    supabase
      .from("sof_events")
      .select("id, event_type, occurred_at")
      .eq("claim_id", claimId)
      .in("status", ["accepted", "edited"])
      // Tiebreak on id: Postgres guarantees no order for equal timestamps, and
      // a proof must pin the ordering the engine actually used.
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true }),
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

  // The rule set that computed the figures being sealed, resolved from the
  // authoritative column. Stamped onto the terms only when it is 2 — a v1
  // claim's `cp_terms` leaf must hash exactly as it did before this mechanism
  // existed, or every root already anchored over it would stop verifying.
  const engineVersion = resolveClaimEngineVersion(claim);
  const cpTerms = withEngineVersion(claim.cp_terms as CpTerms, engineVersion);
  const totals: CalculationTotals = {
    allowed_hours: calc.allowed_hours,
    used_hours: calc.used_hours,
    time_on_demurrage_hours: Math.max(calc.used_hours - calc.allowed_hours, 0),
    time_saved_hours: Math.max(calc.allowed_hours - calc.used_hours, 0),
    demurrage_amount: calc.demurrage_amount ?? 0,
    despatch_amount: calc.despatch_amount ?? 0,
    currency: calc.currency ?? cpTerms.currency,
  };

  // The order the ENGINE would use, not the order the query returned. The
  // derivation record exists to pin how the figures were derived, so it has to
  // record the ordering that actually produced them.
  const orderedEvents = canonicalEventOrder(
    events.map((e) => ({
      id: e.id,
      occurred_at: e.occurred_at,
      event_type: e.event_type as SofEventInput["event_type"],
    })),
  );

  return {
    claim: claim as ClaimSnapshotInputs["claim"],
    // Returned so callers can record WHICH calculation was sealed without
    // re-querying — and so they cannot accidentally seal one snapshot while
    // citing another's timestamp.
    calculationComputedAt: (calc.computed_at as string) ?? null,
    ledger: {
      cpTerms,
      totals,
      breakdown: Array.isArray(calc.breakdown) ? calc.breakdown : [],
      events: orderedEvents.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        occurred_at: e.occurred_at,
      })),
      asOf,
      // Commits the proof to HOW the numbers were derived — which engine, which
      // timezone transitions, which event order — not merely to what they were.
      derivation: buildDerivationRecord(orderedEvents, cpTerms.port_timezone, engineVersion),
    },
  };
}

export interface NotarizeResult {
  claimId: string;
  snapshot: TimeProofSnapshot;
  anchor: AnchorOutcome;
  entryId: string | null;
  // True when the root matched the previous proof and nothing was written.
  unchanged: boolean;
  previousRoot: string | null;
}

// Fingerprint of the RECORD, deliberately excluding asOf.
//
// The Merkle root cannot answer "has anything changed?": its header leaf
// embeds as_of, so the root differs on every pass even when the claim is
// untouched. Deduping on the root therefore never fires — the hourly sweep
// would write 24 identical-in-substance proofs per claim per day and spend a
// TSA request on each. This hashes only what the record says, so "unchanged"
// means unchanged.
export function contentHashOf(ledger: SnapshotLedger): string {
  return sha256Hex(
    canonicalJson({
      cpTerms: ledger.cpTerms,
      totals: ledger.totals,
      breakdown: ledger.breakdown,
      events: ledger.events,
      clauseFlags: ledger.clauseFlags ?? [],
      // Included so a change in engine, timezone table or event ordering counts
      // as a change in the record. Without it the hourly sweep would treat a
      // re-derivation under a new engine as "unchanged" and never re-anchor it.
      derivation: ledger.derivation ?? null,
    })
  );
}

async function latestProof(
  supabase: SupabaseClient,
  claimId: string
): Promise<{ root: string; contentHash: string | null } | null> {
  const { data } = await supabase
    .from("compliance_ledger")
    .select("cryptographic_signature, details")
    .eq("claim_id", claimId)
    .eq("entry_kind", "time_proof")
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const details = (data.details ?? {}) as Record<string, unknown>;
  return {
    root: data.cryptographic_signature as string,
    // Proofs written before content hashing (including by the manual
    // notarize route) have none; those simply never dedupe, which errs
    // toward writing a proof rather than skipping a real change.
    contentHash: (details.content_hash as string) ?? null,
  };
}

// Snapshots one claim. `force` writes a proof even when the root is unchanged
// (the manual route's behaviour — an operator asking for a proof gets one);
// the sweep leaves it false so identical hours are not re-ledgered.
export async function notarizeClaim(opts: {
  claimId: string;
  client?: SupabaseClient;
  userId?: string | null;
  force?: boolean;
  anchor?: boolean;
  asOf?: string;
}): Promise<NotarizeResult> {
  const supabase = opts.client ?? (await createClient());
  const asOf = opts.asOf ?? new Date().toISOString();

  const { ledger } = await loadClaimSnapshotInputs(opts.claimId, supabase, asOf);
  const snapshot = generateCryptographicSnapshot(opts.claimId, ledger);
  const contentHash = contentHashOf(ledger);
  const previous = await latestProof(supabase, opts.claimId);
  const previousRoot = previous?.root ?? null;

  if (!opts.force && previous?.contentHash && previous.contentHash === contentHash) {
    return {
      claimId: opts.claimId,
      snapshot,
      anchor: {
        anchored: false,
        reason: "not_configured",
        detail: "Record unchanged since the last proof; no new proof written.",
      },
      entryId: null,
      unchanged: true,
      previousRoot,
    };
  }

  // Anchor before writing: the ledger row then records the anchor outcome
  // truthfully, including a refusal. Anchoring never blocks the proof — an
  // unanchored proof is still a valid integrity record.
  const anchor = opts.anchor === false
    ? ({ anchored: false, reason: "not_configured", detail: "Anchoring disabled for this run." } as const)
    : await anchorMerkleRoot(snapshot.merkleRoot);

  const { data: entry, error } = await supabase
    .from("compliance_ledger")
    .insert({
      claim_id: opts.claimId,
      entry_kind: "time_proof",
      cryptographic_signature: snapshot.merkleRoot,
      signature_algo: SNAPSHOT_ALGO,
      details: {
        as_of: asOf,
        leaf_count: snapshot.leafCount,
        leaves: snapshot.leaves,
        previous_root: previousRoot,
        // What the next sweep compares against to decide "changed?".
        content_hash: contentHash,
        // The anchor outcome verbatim — a refusal is recorded as a refusal,
        // so the dossier can state exactly what is and isn't proven.
        anchor,
      },
      recorded_by: opts.userId ?? null,
    })
    .select("id")
    .single();
  if (error || !entry) throw new Error(`PERSIST_FAILED: ${error?.message}`);

  return { claimId: opts.claimId, snapshot, anchor, entryId: entry.id, unchanged: false, previousRoot };
}

export interface NotarySweepReport {
  claimsScanned: number;
  proofsWritten: number;
  unchanged: number;
  anchored: number;
  anchorRefusals: number;
  skipped: Array<{ claimId: string; reason: string }>;
}

// The hourly pass. Only live claims: a settled claim's record is finished, and
// a locked one is frozen by definition, so re-proving either is noise.
export async function sweepNotary(opts: {
  client: SupabaseClient;
  companyId?: string;
  anchor?: boolean;
  asOf?: string;
}): Promise<NotarySweepReport> {
  const report: NotarySweepReport = {
    claimsScanned: 0,
    proofsWritten: 0,
    unchanged: 0,
    anchored: 0,
    anchorRefusals: 0,
    skipped: [],
  };

  let q = opts.client.from("claims").select("id").is("settled_at", null);
  if (opts.companyId) q = q.eq("company_id", opts.companyId);
  const { data: claims } = await q;

  for (const c of claims ?? []) {
    report.claimsScanned++;
    try {
      const r = await notarizeClaim({
        claimId: c.id,
        client: opts.client,
        anchor: opts.anchor,
        asOf: opts.asOf,
      });
      if (r.unchanged) {
        report.unchanged++;
        continue;
      }
      report.proofsWritten++;
      if (r.anchor.anchored) report.anchored++;
      else report.anchorRefusals++;
    } catch (e) {
      // A claim with no calculation or no confirmed events isn't notarizable
      // yet — that's expected, not a sweep failure.
      report.skipped.push({ claimId: c.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

export interface ProofRow {
  id: string;
  merkleRoot: string;
  algo: string;
  asOf: string;
  recordedAt: string;
  leaves: TimeProofSnapshot["leaves"];
  anchor: AnchorOutcome | null;
}

// The proof in force at an instant: the latest one recorded at or before it.
// Because the sweep dedupes unchanged roots, this is exactly the proof that
// describes the record's state at `at` — the previous proof stands until
// something changed.
export async function proofAsOf(
  supabase: SupabaseClient,
  claimId: string,
  at: Date
): Promise<ProofRow | null> {
  const { data } = await supabase
    .from("compliance_ledger")
    .select("id, cryptographic_signature, signature_algo, details, recorded_at")
    .eq("claim_id", claimId)
    .eq("entry_kind", "time_proof")
    .lte("recorded_at", at.toISOString())
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;

  const details = (data.details ?? {}) as Record<string, unknown>;
  return {
    id: data.id as string,
    merkleRoot: data.cryptographic_signature as string,
    algo: data.signature_algo as string,
    asOf: (details.as_of as string) ?? (data.recorded_at as string),
    recordedAt: data.recorded_at as string,
    leaves: (details.leaves as TimeProofSnapshot["leaves"]) ?? [],
    anchor: (details.anchor as AnchorOutcome) ?? null,
  };
}
