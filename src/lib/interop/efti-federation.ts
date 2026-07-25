// eFTI federation — the pure half: permissioned, scope-filtered sharing of a
// claim's eFTI consignment with an external authority.
//
// The export (efti.ts) produces the FULL consignment. Federation restricts it
// to what a specific grant permits — "share the transport milestones with the
// port authority, but not our commercial laytime outcome" — and RE-SIGNS the
// subset, so the packet the authority receives verifies on its own and cannot
// be confused with the full export. Authority-agnostic by design: scopes are a
// generic dataset vocabulary, not a specific platform's profile.
//
// Pure module: no I/O. The grant lifecycle and loading live in efti-grants.ts.

import { canonicalJson, sha256Hex } from "@/lib/legal/prosecution";
import type { EftiConsignment } from "./efti";

export const FEDERATION_SCOPES = ["transport", "consignment", "milestones", "laytime"] as const;
export type FederationScope = (typeof FEDERATION_SCOPES)[number];

// Minimum Viable Standard Dataset: the basic carriage metadata a transport
// authority needs, WITHOUT the commercial laytime outcome. The safe default.
export const MVSD_SCOPES: FederationScope[] = ["transport", "consignment", "milestones"];

export const FEDERATION_SIGNATURE_ALGO = "sha256-canonical-federation-v1";

export const SCOPE_LABELS: Record<FederationScope, string> = {
  transport: "Transport movement (vessel, IMO, voyage)",
  consignment: "Consignment (cargo, counterparty)",
  milestones: "Port-call milestones",
  laytime: "Laytime outcome (commercial)",
};

/** Keep only recognised scopes, deduped and sorted; anything else is dropped. */
export function normalizeScopes(raw: unknown): FederationScope[] {
  const known = new Set<string>(FEDERATION_SCOPES);
  const arr = Array.isArray(raw) ? raw : [];
  const valid = arr.filter((s): s is FederationScope => typeof s === "string" && known.has(s));
  return [...new Set(valid)].sort();
}

export interface ScopedEftiConsignment {
  schema: string;
  regulation: string;
  generated_at: string;
  claim_ref: string;
  scopes: FederationScope[];
  transport_movement: EftiConsignment["transport_movement"] | null;
  consignment: EftiConsignment["consignment"] | null;
  port_call: EftiConsignment["port_call"] | null;
  laytime_summary: EftiConsignment["laytime_summary"];
  integrity: {
    algo: string;
    data_sha256: string;
    anchored_merkle_root: string | null;
    anchor_algo: string | null;
  };
}

function scopedSignature(unsigned: Omit<ScopedEftiConsignment, "integrity">): string {
  return sha256Hex(`efti-federation|${unsigned.claim_ref}|${canonicalJson(unsigned)}`);
}

/**
 * Restrict a full consignment to what a grant's scopes permit and RE-SIGN it.
 * Non-granted sections become null — the authority sees exactly what was agreed,
 * and the signature covers the scope list, so neither the data nor the scope can
 * be altered without detection.
 */
export function scopeConsignment(
  full: EftiConsignment,
  scopes: FederationScope[]
): ScopedEftiConsignment {
  const granted = new Set(scopes);
  const unsigned: Omit<ScopedEftiConsignment, "integrity"> = {
    schema: full.schema,
    regulation: full.regulation,
    generated_at: full.generated_at,
    claim_ref: full.claim_ref,
    scopes: [...scopes].sort(),
    transport_movement: granted.has("transport") ? full.transport_movement : null,
    consignment: granted.has("consignment") ? full.consignment : null,
    port_call: granted.has("milestones") ? full.port_call : null,
    laytime_summary: granted.has("laytime") ? full.laytime_summary : null,
  };
  return {
    ...unsigned,
    integrity: {
      algo: FEDERATION_SIGNATURE_ALGO,
      data_sha256: scopedSignature(unsigned),
      anchored_merkle_root: full.integrity.anchored_merkle_root,
      anchor_algo: full.integrity.anchor_algo,
    },
  };
}

/** Recomputes the signature; false means the shared packet was altered. */
export function verifyScopedConsignment(c: ScopedEftiConsignment): boolean {
  const { integrity, ...unsigned } = c;
  return integrity.data_sha256 === scopedSignature(unsigned);
}
