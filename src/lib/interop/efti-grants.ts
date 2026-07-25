// eFTI federation — the server half: the grant token lifecycle and the loader
// that builds the full consignment for the authority endpoint.
//
// Mirrors rooms.ts (unguessable token, validated here; the authority never
// supplies a claim id) but stores only the token's SHA-256 hash, like the OAuth
// and Audit-API credentials. The pure scope filtering lives in efti-federation.ts.

import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex, SNAPSHOT_ALGO } from "@/lib/legal/prosecution";
import { buildEftiConsignment, type EftiConsignment } from "./efti";
import type { EventTypeEnum } from "@/lib/laytime/types";
import { normalizeScopes, type FederationScope } from "./efti-federation";

export const GRANT_TOKEN_BYTES = 24; // 192 bits, base64url → 32 chars
export const DEFAULT_GRANT_EXPIRY_DAYS = 30;

export function generateGrantToken(): string {
  return randomBytes(GRANT_TOKEN_BYTES).toString("base64url");
}
export function hashGrantToken(token: string): string {
  return sha256Hex(token);
}

export interface EftiGrant {
  id: string;
  claimId: string;
  authorityLabel: string;
  scopes: FederationScope[];
  expiresAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  createdAt: string;
}

function serialize(row: Record<string, unknown>): EftiGrant {
  return {
    id: row.id as string,
    claimId: row.claim_id as string,
    authorityLabel: (row.authority_label as string) ?? "",
    scopes: normalizeScopes(row.dataset_scope),
    expiresAt: row.expires_at as string,
    revokedAt: (row.revoked_at as string | null) ?? null,
    lastAccessedAt: (row.last_accessed_at as string | null) ?? null,
    accessCount: (row.access_count as number) ?? 0,
    createdAt: row.created_at as string,
  };
}

export async function createGrant(
  db: SupabaseClient,
  input: {
    claimId: string;
    companyId: string;
    authorityLabel: string;
    scopes: FederationScope[];
    createdBy: string;
    expiresAt: string;
  }
): Promise<{ grant: EftiGrant; token: string }> {
  const token = generateGrantToken();
  const { data, error } = await db
    .from("efti_grants")
    .insert({
      claim_id: input.claimId,
      company_id: input.companyId,
      authority_label: input.authorityLabel,
      dataset_scope: input.scopes,
      token_hash: hashGrantToken(token),
      created_by: input.createdBy,
      expires_at: input.expiresAt,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`PERSIST_FAILED: ${error?.message}`);
  return { grant: serialize(data as Record<string, unknown>), token };
}

export async function listGrants(
  db: SupabaseClient,
  companyId: string,
  claimId?: string
): Promise<EftiGrant[]> {
  let q = db
    .from("efti_grants")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (claimId) q = q.eq("claim_id", claimId);
  const { data } = await q;
  return (data ?? []).map((r) => serialize(r as Record<string, unknown>));
}

/** Revokes one grant, scoped to the company. Returns false if there was nothing live to revoke. */
export async function revokeGrant(
  db: SupabaseClient,
  companyId: string,
  grantId: string
): Promise<boolean> {
  const { data } = await db
    .from("efti_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", grantId)
    .eq("company_id", companyId)
    .is("revoked_at", null)
    .select("id");
  return (data?.length ?? 0) > 0;
}

export interface ResolvedGrant {
  grantId: string;
  claimId: string;
  companyId: string;
  scopes: FederationScope[];
}

/**
 * Authority side: validate a presented token → the grant and the claim id it
 * grants. Returns null for unknown, revoked or expired tokens (the route maps
 * that to 404 — never confirm a token exists). NEVER takes a claim id from the
 * caller. Bumps the access counters best-effort.
 */
export async function resolveGrant(
  db: SupabaseClient,
  token: string
): Promise<ResolvedGrant | null> {
  if (!token || token.length < 16 || token.length > 128) return null;
  const { data: grant } = await db
    .from("efti_grants")
    .select("id, claim_id, company_id, dataset_scope, expires_at, revoked_at, access_count")
    .eq("token_hash", hashGrantToken(token))
    .maybeSingle();

  if (!grant || grant.revoked_at) return null;
  if (new Date(grant.expires_at).getTime() < Date.now()) return null;

  // Best-effort access metering; never fail the request on it.
  void db
    .from("efti_grants")
    .update({
      last_accessed_at: new Date().toISOString(),
      access_count: (grant.access_count ?? 0) + 1,
    })
    .eq("id", grant.id);

  return {
    grantId: grant.id,
    claimId: grant.claim_id,
    companyId: grant.company_id,
    scopes: normalizeScopes(grant.dataset_scope),
  };
}

/**
 * Builds the FULL eFTI consignment for a claim (the authority endpoint then
 * scope-filters it). Mirrors the export route's loader. Throws CLAIM_NOT_FOUND /
 * NO_CONFIRMED_EVENTS / NO_EXPORTABLE_MILESTONES.
 */
export async function loadEftiConsignment(
  db: SupabaseClient,
  claimId: string
): Promise<EftiConsignment> {
  const { data: claim } = await db
    .from("claims")
    .select("id, vessel, vessel_imo, voyage_ref, port, cargo, counterparty_name")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) throw new Error("CLAIM_NOT_FOUND");

  const [{ data: events }, { data: calc }, { data: anchor }] = await Promise.all([
    db
      .from("sof_events")
      .select("event_type, occurred_at, ais_geofence_verified")
      .eq("claim_id", claimId)
      .in("status", ["accepted", "edited"])
      .order("occurred_at", { ascending: true }),
    db
      .from("laytime_calculations")
      .select("allowed_hours, used_hours, demurrage_amount, despatch_amount, currency")
      .eq("claim_id", claimId)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("compliance_ledger")
      .select("cryptographic_signature, signature_algo")
      .eq("claim_id", claimId)
      .eq("entry_kind", "time_proof")
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!events || events.length === 0) throw new Error("NO_CONFIRMED_EVENTS");

  return buildEftiConsignment({
    claim: {
      id: claim.id,
      vessel: claim.vessel,
      vesselImo: claim.vessel_imo ?? null,
      voyageRef: claim.voyage_ref,
      port: claim.port,
      cargo: claim.cargo,
      counterpartyName: claim.counterparty_name ?? null,
    },
    events: (events ?? []).map((e) => ({
      event_type: e.event_type as EventTypeEnum,
      occurred_at: e.occurred_at as string,
      ais_geofence_verified: e.ais_geofence_verified as boolean | null,
    })),
    totals: calc
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
}
