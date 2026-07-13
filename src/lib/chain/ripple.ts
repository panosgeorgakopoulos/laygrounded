// Charter-chain "ripple" engine: clones a claim one tier down the chain.
//
// The receiving tenant (e.g. a head charterer served with an owner's claim)
// generates a linked sub-claim against their own counterparty. Events are
// cloned onto a stub document owned by the sub-claim (never shared with the
// parent — a cross-claim document reference would let a parent deletion
// cascade into the sub-claim's events). Any event corroborated by independent
// evidence is cloned LOCKED with the evidence summary as its reason; the
// downstream party negotiates through the same claim rooms as everyone else
// but cannot touch the verified backbone.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";
import { CpTerms } from "@/lib/laytime/types";

export const MAX_CHAIN_DEPTH = 5;

export type SubClaimRole = "head_charterer" | "sub_charterer" | "receiver";

export interface SubClaimOptions {
  counterpartyName?: string | null;
  chainRole?: SubClaimRole;
  // Down-chain terms usually differ (back-to-back CPs with margin); only
  // these commercial knobs may be overridden — the event record may not.
  cpTermsOverrides?: Partial<
    Pick<
      CpTerms,
      "demurrage_rate" | "despatch_rate" | "laytime_allowed_hours" | "turn_time_hours"
    >
  >;
  createdBy?: string | null;
}

export interface SubClaimResult {
  subClaimId: string;
  chainDepth: number;
  totalEvents: number;
  lockedEvents: number;
  calcError: string | null;
}

export async function createSubClaim(
  supabase: SupabaseClient,
  parentClaimId: string,
  companyId: string,
  opts: SubClaimOptions = {}
): Promise<SubClaimResult> {
  // Ownership re-checked here even though routes check first — this function
  // runs on the service-role client and must not trust its caller blindly.
  const { data: parent, error: parentErr } = await supabase
    .from("claims")
    .select("*")
    .eq("id", parentClaimId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (parentErr || !parent) throw new Error("CLAIM_NOT_FOUND");

  const chainDepth = (parent.chain_depth ?? 0) + 1;
  if (chainDepth > MAX_CHAIN_DEPTH) throw new Error("CHAIN_TOO_DEEP");

  const [{ data: events }, { data: evidence }] = await Promise.all([
    supabase
      .from("sof_events")
      .select("id, occurred_at, event_type, raw_text, page, confidence, locked, locked_reason")
      .eq("claim_id", parentClaimId)
      .in("status", ["accepted", "edited"])
      .order("occurred_at", { ascending: true }),
    supabase
      .from("evidence_checks")
      .select("event_id, verdict, summary")
      .eq("claim_id", parentClaimId)
      .eq("verdict", "corroborated"),
  ]);
  if (!events || events.length === 0) throw new Error("NO_CONFIRMED_EVENTS");

  const corroboratedBy = new Map<string, string>();
  for (const c of evidence ?? []) {
    if (c.event_id) corroboratedBy.set(c.event_id, c.summary);
  }

  const cpTerms = {
    ...((parent.cp_terms as CpTerms | null) ?? {}),
    ...(opts.cpTermsOverrides ?? {}),
  };

  const { data: subClaim, error: claimErr } = await supabase
    .from("claims")
    .insert({
      company_id: companyId,
      vessel: parent.vessel,
      voyage_ref: parent.voyage_ref,
      port: parent.port,
      cargo: parent.cargo,
      cp_form: parent.cp_form,
      cp_terms: cpTerms,
      status: "draft",
      vessel_imo: parent.vessel_imo ?? null,
      counterparty_name: opts.counterpartyName ?? null,
      port_lat: parent.port_lat ?? null,
      port_lon: parent.port_lon ?? null,
      time_bar_days: parent.time_bar_days ?? 90,
      parent_claim_id: parentClaimId,
      chain_role: opts.chainRole ?? "sub_charterer",
      chain_depth: chainDepth,
      created_by: opts.createdBy ?? null,
    })
    .select("id")
    .single();
  if (claimErr || !subClaim) throw new Error(`PERSIST_FAILED: ${claimErr?.message}`);

  // Stub document (same pattern as manual event entry): the clones need a
  // parent row that lives and dies with the sub-claim.
  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({
      claim_id: subClaim.id,
      storage_path: `chain/${parentClaimId}`,
      mime: "chain",
      original_filename: `Chained from voyage ${parent.voyage_ref}`,
      extraction_status: "extracted",
    })
    .select("id")
    .single();
  if (docErr || !doc) throw new Error(`PERSIST_FAILED: ${docErr?.message}`);

  // Locks propagate: an event locked upstream stays locked downstream even
  // if the corroborating check predates this tier.
  const clones = events.map((e) => {
    const evidenceSummary = corroboratedBy.get(e.id);
    const locked = Boolean(evidenceSummary) || e.locked === true;
    return {
      claim_id: subClaim.id,
      document_id: doc.id,
      occurred_at: e.occurred_at,
      event_type: e.event_type,
      raw_text: e.raw_text,
      page: e.page ?? 1,
      bbox: { x: 0, y: 0, width: 0, height: 0 },
      confidence: e.confidence ?? 1.0,
      source: "chain",
      status: "accepted",
      locked,
      locked_reason: locked
        ? evidenceSummary ?? e.locked_reason ?? "Locked upstream in the charter chain."
        : null,
    };
  });

  const { error: eventsErr } = await supabase.from("sof_events").insert(clones);
  if (eventsErr) throw new Error(`PERSIST_FAILED: ${eventsErr.message}`);

  // Best-effort first calculation; a sub-claim that cannot compute yet (e.g.
  // CP term overrides pending) is still created.
  let calcError: string | null = null;
  try {
    await recomputeLaytimeServerFn(subClaim.id, supabase);
  } catch (e) {
    calcError = e instanceof Error ? e.message : String(e);
  }

  return {
    subClaimId: subClaim.id,
    chainDepth,
    totalEvents: clones.length,
    lockedEvents: clones.filter((c) => c.locked).length,
    calcError,
  };
}

export interface ChainNode {
  id: string;
  vessel: string;
  voyageRef: string;
  chainRole: string;
  chainDepth: number;
  counterpartyName: string | null;
  status: string;
  settledAmount: number | null;
  parentClaimId: string | null;
}

// The full chain visible to the caller: ancestors first, then the claim,
// then descendants breadth-first. Runs on the caller's RLS client, so tiers
// owned by other tenants simply don't appear.
export async function loadChain(
  supabase: SupabaseClient,
  claimId: string
): Promise<ChainNode[]> {
  const select =
    "id, vessel, voyage_ref, chain_role, chain_depth, counterparty_name, status, settled_amount, parent_claim_id";

  const byId = new Map<string, ChainNode>();
  const toNode = (c: any): ChainNode => ({
    id: c.id,
    vessel: c.vessel,
    voyageRef: c.voyage_ref,
    chainRole: c.chain_role ?? "owner",
    chainDepth: c.chain_depth ?? 0,
    counterpartyName: c.counterparty_name ?? null,
    status: c.status,
    settledAmount: c.settled_amount ?? null,
    parentClaimId: c.parent_claim_id ?? null,
  });

  const { data: self } = await supabase.from("claims").select(select).eq("id", claimId).maybeSingle();
  if (!self) throw new Error("CLAIM_NOT_FOUND");
  byId.set(self.id, toNode(self));

  // Walk up (bounded by MAX_CHAIN_DEPTH, so a cycle cannot spin forever).
  let cursor: string | null = self.parent_claim_id;
  for (let i = 0; cursor && i < MAX_CHAIN_DEPTH; i++) {
    const { data: parent } = await supabase.from("claims").select(select).eq("id", cursor).maybeSingle();
    if (!parent || byId.has(parent.id)) break;
    byId.set(parent.id, toNode(parent));
    cursor = parent.parent_claim_id;
  }

  // Walk down breadth-first.
  let frontier = [self.id];
  for (let i = 0; frontier.length > 0 && i < MAX_CHAIN_DEPTH; i++) {
    const { data: children } = await supabase.from("claims").select(select).in("parent_claim_id", frontier);
    frontier = [];
    for (const child of children ?? []) {
      if (byId.has(child.id)) continue;
      byId.set(child.id, toNode(child));
      frontier.push(child.id);
    }
  }

  return [...byId.values()].sort((a, b) => a.chainDepth - b.chainDepth);
}
