import { createServiceRoleClient } from "@/lib/supabase/server";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import { CpTerms, LaytimeResult, SofEventInput } from "@/lib/laytime/types";

export async function recomputeLaytimeServerFn(
  claimId: string
): Promise<LaytimeResult> {
  const supabase = createServiceRoleClient();
  
  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("*")
    .eq("id", claimId)
    .single();
    
  if (claimErr || !claim) throw new Error("CLAIM_NOT_FOUND");

  const cpTerms: CpTerms | null = claim.cp_terms as any;
  if (!cpTerms) throw new Error("NO_CP_TERMS");

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

  const result = recomputeLaytime(sofInputs, cpTerms);

  await supabase.from("laytime_calculations").delete().eq("claim_id", claimId);
  await supabase.from("laytime_calculations").insert({
    claim_id: claimId,
    inputs: { cpTerms, events: sofInputs },
    breakdown: result.breakdown,
    used_hours: result.totals.used_hours,
    allowed_hours: result.totals.allowed_hours,
    demurrage_amount: result.totals.demurrage_amount,
    despatch_amount: result.totals.despatch_amount,
    currency: result.totals.currency,
  });

  let newStatus = claim.status;
  if (result.totals.demurrage_amount > 0) newStatus = "demurrage";
  else if (result.totals.despatch_amount > 0) newStatus = "despatch";
  else if (events && events.length > 0) newStatus = "in_progress";
  
  if (newStatus !== claim.status) {
    await supabase
      .from("claims")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", claimId);
  }

  return result;
}
