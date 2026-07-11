import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import { CpTerms, LaytimeResult, SofEventInput } from "@/lib/laytime/types";
import { z } from "zod";

const CpTermsSchema = z.object({
  laytime_allowed_hours: z.number().min(0),
  load_rate: z.number().min(0).optional(),
  discharge_rate: z.number().min(0).optional(),
  turn_time_hours: z.number().min(0),
  nor_variant: z.enum(["WIBON", "WIPON", "WICCON", "WIFPON"]),
  days_basis: z.enum(["SHINC", "SHEX", "SHEX-UU", "WWDSHEX-EIU", "SSHEX", "SSHEX-UU", "WWDSSHEX-EIU"]),
  demurrage_rate: z.number().min(0),
  despatch_rate: z.number().min(0),
  currency: z.string().length(3),
  port_timezone: z.string().optional()
});

export async function recomputeLaytimeServerFn(
  claimId: string,
  // Callers that run outside a user request (e.g. the demo seeder using the
  // service-role client) must pass their own client — the default cookie-based
  // RLS client has no authenticated user in that context and every query is
  // blocked by row-level security.
  client?: SupabaseClient
): Promise<LaytimeResult> {
  const supabase = client ?? (await createClient());

  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("*")
    .eq("id", claimId)
    .maybeSingle();
    
  if (claimErr || !claim) throw new Error("CLAIM_NOT_FOUND");

  const parsedCpTerms = CpTermsSchema.safeParse(claim.cp_terms);
  if (!parsedCpTerms.success) throw new Error("INVALID_CP_TERMS");
  const cpTerms: CpTerms = parsedCpTerms.data;

  const { data: events } = await supabase
    .from("sof_events")
    .select("*")
    .eq("claim_id", claimId)
    .in("status", ["accepted", "edited"])
    .order("occurred_at", { ascending: true });

  const sofInputs: SofEventInput[] = (events || []).map((e) => ({
    id: e.id,
    occurred_at: e.occurred_at,
    event_type: e.event_type as any,
  }));

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
  const { error: persistErr } = await supabase.from("laytime_calculations").upsert({
    claim_id: claimId,
    breakdown: result.breakdown,
    used_hours: result.totals.used_hours,
    allowed_hours: result.totals.allowed_hours,
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
  else if (events && events.length > 0) newStatus = "in_progress";

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
