import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import { CpTerms, LaytimeResult, SofEventInput } from "@/lib/laytime/types";
import { resolveClaimEngineVersion, withEngineVersion } from "@/lib/laytime/engine-version";
import { withPortCalendar } from "@/lib/laytime/port-calendar-server";
import { z } from "zod";

// The single validator for a claim's charter-party terms. Exported so callers
// that write cp_terms (e.g. the MCP update_cp_terms tool) validate the whole
// object against exactly what the engine bridge will later accept — a partial
// amendment can never leave a claim with terms this schema would reject.
export const CpTermsSchema = z.object({
  cp_form: z.enum(["GENCON94", "ASBATANKVOY"]).optional(),
  // Accepted so a stored value survives a round trip, but NOT the authority:
  // `loadClaimComputationInputs` overwrites it from `claims.engine_version`.
  // Absent means 1 — see EngineVersion in the core package.
  engine_version: z.union([z.literal(1), z.literal(2)]).optional(),
  laytime_allowed_hours: z.number().min(0),
  load_rate: z.number().min(0).optional(),
  discharge_rate: z.number().min(0).optional(),
  turn_time_hours: z.number().min(0),
  nor_variant: z.enum(["WIBON", "WIPON", "WICCON", "WIFPON"]),
  days_basis: z.enum(["SHINC", "SHEX", "SHEX-UU", "WWDSHEX-EIU", "SSHEX", "SSHEX-UU", "WWDSSHEX-EIU"]),
  demurrage_rate: z.number().min(0),
  despatch_rate: z.number().min(0),
  currency: z.string().length(3),
  port_timezone: z.string().optional(),
  // Holidays are local calendar dates (YYYY-MM-DD), not instants — a holiday is
  // a day in the port's own reckoning. `source` is required for the same reason
  // it is required in the database: a calendar decides whether real money
  // counts, so an entry that cannot say where it came from does not belong in a
  // calculation.
  port_calendar: z
    .object({
      holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
      source: z.string().min(1),
    })
    .optional(),
});

// Loads everything the engine needs for a claim: the row itself, validated CP
// terms, and the confirmed (accepted/edited) events as engine inputs. Shared
// by recompute, the claim-room diff, and clause P&L counterfactuals.
export async function loadClaimComputationInputs(
  claimId: string,
  client?: SupabaseClient
): Promise<{ claim: any; cpTerms: CpTerms; sofInputs: SofEventInput[] }> {
  const supabase = client ?? (await createClient());

  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("*")
    .eq("id", claimId)
    .maybeSingle();

  if (claimErr || !claim) throw new Error("CLAIM_NOT_FOUND");

  const parsedCpTerms = CpTermsSchema.safeParse(claim.cp_terms);
  if (!parsedCpTerms.success) throw new Error("INVALID_CP_TERMS");

  // Attach the port's confirmed working calendar, when the company has one.
  // Applied here rather than at each call site so recompute, the claim-room
  // diff, clause P&L and the sensitivity analysis all cost the same holidays —
  // two paths disagreeing about which days count would be worse than neither
  // having a calendar at all. A claim with no calendar is returned unchanged.
  const withCalendar: CpTerms = await withPortCalendar(
    supabase,
    parsedCpTerms.data,
    claim.company_id,
    claim.port,
  );

  // THE COLUMN IS THE AUTHORITY on which rule set computes this claim, not the
  // jsonb blob — see `engine-version.ts` for why, and for why v1 is expressed by
  // the key's absence rather than by writing `1`.
  const cpTerms: CpTerms = withEngineVersion(withCalendar, resolveClaimEngineVersion(claim));

  const { data: events } = await supabase
    .from("sof_events")
    .select("*")
    .eq("claim_id", claimId)
    .in("status", ["accepted", "edited"])
    // The id tiebreak is not cosmetic: Postgres gives no ordering guarantee for
    // rows with equal `occurred_at`, and heap order can shift after any UPDATE,
    // so ordering on the timestamp alone let the same claim come back in
    // different orders on different days. The engine now imposes its own total
    // order regardless, but a stable query keeps what is stored, logged and
    // displayed consistent with what is computed.
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true });

  const sofInputs: SofEventInput[] = (events || []).map((e) => ({
    id: e.id,
    occurred_at: e.occurred_at,
    event_type: e.event_type as any,
  }));

  return { claim, cpTerms, sofInputs };
}

export async function recomputeLaytimeServerFn(
  claimId: string,
  // Callers that run outside a user request (e.g. the demo seeder using the
  // service-role client) must pass their own client — the default cookie-based
  // RLS client has no authenticated user in that context and every query is
  // blocked by row-level security.
  client?: SupabaseClient
): Promise<LaytimeResult> {
  const supabase = client ?? (await createClient());
  const { claim, cpTerms, sofInputs } = await loadClaimComputationInputs(claimId, supabase);

  // DEM-8: Validate chronological order of critical events
  const nor = sofInputs.find(e => e.event_type === "NOR_TENDERED");
  const allFast = sofInputs.find(e => e.event_type === "ALL_FAST");
  if (nor && allFast && new Date(allFast.occurred_at) < new Date(nor.occurred_at)) {
    throw new Error("CHRONOLOGY_ERROR: ALL_FAST cannot precede NOR_TENDERED");
  }

  const result = recomputeLaytime(sofInputs, cpTerms);

  // BL-1: Upsert instead of delete + insert. The persisted calculation is the
  // product's authoritative financial output, so a failed write must surface
  // loudly rather than being swallowed and leaving stale/absent totals.
  // Every total the engine produced, so the row can be reconstructed into a
  // faithful `LaytimeResult`. Storing a subset is what previously forced the
  // trade-finance package to publish named fields instead of a whole object.
  //
  // `demurrage_half_rate_hours` is written as NULL when the engine did not emit
  // it (GENCON 94). NULL and 0 mean different things here — see
  // `calculation-row.ts` — so it must not be coalesced on the way in either.
  const { error: persistErr } = await supabase.from("laytime_calculations").upsert({
    claim_id: claimId,
    breakdown: result.breakdown,
    used_hours: result.totals.used_hours,
    allowed_hours: result.totals.allowed_hours,
    time_on_demurrage_hours: result.totals.time_on_demurrage_hours,
    time_saved_hours: result.totals.time_saved_hours,
    demurrage_half_rate_hours: result.totals.demurrage_half_rate_hours ?? null,
    demurrage_amount: result.totals.demurrage_amount,
    despatch_amount: result.totals.despatch_amount,
    currency: result.totals.currency,
  }, { onConflict: "claim_id" });
  if (persistErr) {
    throw new Error(`PERSIST_FAILED: ${persistErr.message}`);
  }

  let newStatus = claim.status;
  if (result.totals.demurrage_amount > 0) newStatus = "demurrage";
  else if (result.totals.despatch_amount > 0) newStatus = "despatch";
  else if (sofInputs.length > 0) newStatus = "in_progress";

  if (newStatus !== claim.status) {
    const { error: statusErr } = await supabase
      .from("claims")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", claimId);
    if (statusErr) {
      throw new Error(`STATUS_UPDATE_FAILED: ${statusErr.message}`);
    }
  }

  return result;
}
