// Claim rooms: shared negotiation surfaces for counterparties.
//
// A room is reached through an unguessable share token, not a Supabase
// session, so all room reads/writes go through the service-role client after
// the token is validated here. Every helper narrows strictly to the one claim
// the share grants — nothing here may ever accept a claim id from the guest.

import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { loadClaimComputationInputs } from "@/lib/laytime/recompute-server";
import { diffScenarios, ProposalInput, ScenarioDiff } from "@/lib/laytime/diff";
import { CpTerms } from "@/lib/laytime/types";

export const SHARE_TOKEN_BYTES = 24; // 192 bits, base64url → 32 chars
export const DEFAULT_SHARE_EXPIRY_DAYS = 30;
// Cap pending proposals per share so a guest cannot flood the owner.
export const MAX_PENDING_PROPOSALS_PER_SHARE = 50;

export function generateShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

export interface ResolvedShare {
  share: {
    id: string;
    claim_id: string;
    counterparty_label: string;
    expires_at: string;
    created_at: string;
  };
  claim: {
    id: string;
    vessel: string;
    voyage_ref: string;
    port: string;
    cargo: string;
    cp_terms: unknown;
    status: string;
  };
}

// Validates a share token and loads the claim it grants access to.
// Returns null for unknown, revoked, or expired tokens — callers translate
// that to a 404 (never a 403: don't confirm that a token exists).
export async function resolveShare(
  token: string,
  client?: SupabaseClient
): Promise<ResolvedShare | null> {
  if (!token || token.length < 16 || token.length > 128) return null;
  const supabase = client ?? createServiceRoleClient();

  const { data: share } = await supabase
    .from("claim_shares")
    .select("id, claim_id, counterparty_label, expires_at, revoked_at, created_at")
    .eq("token", token)
    .maybeSingle();

  if (!share || share.revoked_at) return null;
  if (new Date(share.expires_at).getTime() < Date.now()) return null;

  const { data: claim } = await supabase
    .from("claims")
    .select("id, vessel, voyage_ref, port, cargo, cp_terms, status")
    .eq("id", share.claim_id)
    .maybeSingle();

  if (!claim) return null;

  return {
    share: {
      id: share.id,
      claim_id: share.claim_id,
      counterparty_label: share.counterparty_label,
      expires_at: share.expires_at,
      created_at: share.created_at,
    },
    claim,
  };
}

export interface RoomEvent {
  id: string;
  occurredAt: string;
  eventType: string;
  rawText: string;
  source: string;
}

export interface RoomProposal {
  id: string;
  action: "amend" | "add" | "remove";
  eventId: string | null;
  proposedOccurredAt: string | null;
  proposedEventType: string | null;
  note: string;
  proposedByLabel: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

export interface RoomView {
  room: { counterpartyLabel: string; expiresAt: string };
  claim: {
    vessel: string;
    voyageRef: string;
    port: string;
    cargo: string;
    cpTerms: CpTerms | null;
  };
  events: RoomEvent[];
  proposals: RoomProposal[];
  diff: ScenarioDiff | null;
}

// Assembles the full shared negotiation state for a validated share: claim
// summary, confirmed events, every proposal, and the redline diff with all
// pending proposals applied. Used by both the public API and the room page.
export async function loadRoomView(
  resolved: ResolvedShare,
  client?: SupabaseClient
): Promise<RoomView> {
  const supabase = client ?? createServiceRoleClient();
  const { share, claim } = resolved;

  const { data: events } = await supabase
    .from("sof_events")
    .select("id, occurred_at, event_type, raw_text, source, status")
    .eq("claim_id", claim.id)
    .in("status", ["accepted", "edited"])
    .order("occurred_at", { ascending: true });

  const { data: proposals } = await supabase
    .from("event_proposals")
    .select("*")
    .eq("claim_id", claim.id)
    .order("created_at", { ascending: true });

  let diff: ScenarioDiff | null = null;
  let cpTerms: CpTerms | null = null;
  try {
    const inputs = await loadClaimComputationInputs(claim.id, supabase);
    cpTerms = inputs.cpTerms;
    const pending: ProposalInput[] = (proposals || [])
      .filter((p) => p.status === "pending")
      .map((p) => ({
        id: p.id,
        action: p.action,
        event_id: p.event_id,
        proposed_occurred_at: p.proposed_occurred_at,
        proposed_event_type: p.proposed_event_type,
      }));
    diff = diffScenarios(inputs.sofInputs, cpTerms, pending);
  } catch {
    // Invalid/missing CP terms: the room still shows events and proposals.
  }

  return {
    room: {
      counterpartyLabel: share.counterparty_label,
      expiresAt: share.expires_at,
    },
    claim: {
      vessel: claim.vessel,
      voyageRef: claim.voyage_ref,
      port: claim.port,
      cargo: claim.cargo,
      cpTerms,
    },
    events: (events || []).map((e) => ({
      id: e.id,
      occurredAt: e.occurred_at,
      eventType: e.event_type,
      rawText: e.raw_text,
      source: e.source,
    })),
    proposals: (proposals || []).map((p) => ({
      id: p.id,
      action: p.action,
      eventId: p.event_id,
      proposedOccurredAt: p.proposed_occurred_at,
      proposedEventType: p.proposed_event_type,
      note: p.note,
      proposedByLabel: p.proposed_by_label,
      status: p.status,
      createdAt: p.created_at,
      decidedAt: p.decided_at,
    })),
    diff,
  };
}
