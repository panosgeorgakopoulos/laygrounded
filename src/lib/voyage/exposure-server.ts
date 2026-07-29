// Database bridge for the live demurrage meter. All I/O lives here; the maths
// is in `exposure.ts` and stays pure.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadClaimComputationInputs } from "@/lib/laytime/recompute-server";
import {
  computeLiveExposure,
  exposureAlert,
  type ExposureAlert,
  type ExposureSnapshot,
} from "@/lib/voyage/exposure";

export interface ClaimExposure {
  claimId: string;
  vessel: string | null;
  voyageRef: string | null;
  port: string | null;
  snapshot: ExposureSnapshot;
  alert: ExposureAlert;
}

/**
 * Live exposure for one claim.
 *
 * `now` is a parameter rather than a call to the clock so a sweep prices every
 * claim at the same instant — otherwise two claims in one report are measured
 * seconds apart, and re-running the sweep can never reproduce its own output.
 */
export async function loadClaimExposure(
  claimId: string,
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<ClaimExposure> {
  const { claim, cpTerms, sofInputs } = await loadClaimComputationInputs(claimId, supabase);

  const snapshot = computeLiveExposure({
    events: sofInputs,
    terms: cpTerms,
    now: now.toISOString(),
    // No AIS-derived ETA is wired in yet. Passing null is deliberate: the pure
    // module refuses to invent a completion time, so the meter reports accrued
    // exposure only until a real ETA source is connected.
    projectedCompletionAt: null,
  });

  return {
    claimId,
    vessel: claim.vessel ?? null,
    voyageRef: claim.voyage_ref ?? null,
    port: claim.port ?? null,
    snapshot,
    alert: exposureAlert(snapshot),
  };
}

export interface ExposureBookOptions {
  /** Cap on claims priced per call. Each claim costs a handful of engine runs. */
  limit?: number;
}

const DEFAULT_BOOK_LIMIT = 50;

/**
 * Live exposure across a company's unsettled book, ordered most-exposed first.
 *
 * Scoped to unsettled claims because a settled voyage has no live exposure by
 * definition, and pricing one would put a moving number next to a closed claim.
 * Claims that fail to price are skipped rather than failing the whole sweep —
 * one malformed claim must not blank the console for the rest of the book.
 */
export async function loadCompanyExposure(
  companyId: string,
  supabase: SupabaseClient,
  opts: ExposureBookOptions = {}
): Promise<ClaimExposure[]> {
  const { data: claims, error } = await supabase
    .from("claims")
    .select("id")
    .eq("company_id", companyId)
    .is("settled_at", null)
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? DEFAULT_BOOK_LIMIT);

  if (error) throw new Error(`EXPOSURE_QUERY_FAILED: ${error.message}`);

  // One instant for the whole sweep — see loadClaimExposure.
  const now = new Date();
  const out: ClaimExposure[] = [];

  for (const c of claims ?? []) {
    try {
      const exposure = await loadClaimExposure(c.id, supabase, now);
      // A voyage that has not started, or one already closed out by a real
      // completion event, has nothing live to meter.
      if (exposure.snapshot.state === "not_started") continue;
      if (exposure.snapshot.state === "completed") continue;
      out.push(exposure);
    } catch {
      continue;
    }
  }

  // Most urgent first: on demurrage before running-but-tight, then by money
  // already exposed, then by how little laytime is left. Mirrors the console's
  // tiering rule — irreversibility outranks size.
  const rank: Record<string, number> = { demurrage_accruing: 2, laytime_running: 1 };
  out.sort((a, b) => {
    const byState = (rank[b.snapshot.state] ?? 0) - (rank[a.snapshot.state] ?? 0);
    if (byState !== 0) return byState;
    const byMoney = b.snapshot.accruedDemurrage - a.snapshot.accruedDemurrage;
    if (byMoney !== 0) return byMoney;
    return a.snapshot.remainingHours - b.snapshot.remainingHours;
  });

  return out;
}
