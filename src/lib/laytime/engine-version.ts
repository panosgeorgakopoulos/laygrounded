// One rule, applied everywhere: **absence is the v1 marker.**
//
// The engine carries two rule sets (see `EngineVersion` in the core package).
// Which one a claim uses is stored in `claims.engine_version` — a NOT NULL
// column with a CHECK, so it can never be missing or nonsense — and travels to
// the engine on `cpTerms.engine_version`.
//
// The column is the authority and the terms are the transport. That split
// matters: `cp_terms` is user-editable jsonb reachable from several routes, and
// a PATCH that dropped the key would silently move a claim back to v1, changing
// the money on a claim that may already have been served.
//
// `withEngineVersion` REMOVES the key for v1 rather than writing `1`. That is
// not tidiness. `cp_terms` is a leaf in the notarised Merkle snapshot, so adding
// a key to a legacy claim's terms would change its leaf hash and its root, and
// every RFC-3161 token already anchored over that root would stop verifying.
// The same reasoning already governs `SnapshotLedger.derivation`, whose absence
// is likewise load-bearing.

import type { CpTerms, EngineVersion } from "@/lib/laytime/types";

/** Reads the authoritative version off a claim row. Anything unexpected reads as 1. */
export function resolveClaimEngineVersion(claim: {
  engine_version?: number | null;
}): EngineVersion {
  return claim.engine_version === 2 ? 2 : 1;
}

/**
 * Stamps the rule set onto CP terms for the engine.
 *
 * v1 is expressed by the key's ABSENCE, so a legacy claim's terms come back
 * byte-identical to what is stored.
 */
export function withEngineVersion(terms: CpTerms, version: EngineVersion): CpTerms {
  if (version === 1) {
    const { engine_version: _drop, ...rest } = terms;
    return rest as CpTerms;
  }
  return { ...terms, engine_version: version };
}
