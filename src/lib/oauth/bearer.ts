// Bearer-token authentication for the MCP endpoint.
//
// This is the boundary between an access token and a tenant's claims. It runs
// on every MCP request, so — like the Audit API's key check (AD-035) — it
// resolves the token by its SHA-256 hash on the service role and returns a
// company-scoped context every downstream query is confined to.
//
// The token must clear four gates, and all four are failures a client is
// entitled to distinguish from "no token", so they carry a specific
// WWW-Authenticate error per RFC 6750 / RFC 9728:
//   1. present and well-formed,
//   2. live — not revoked, not expired,
//   3. audience-bound — its `resource` is THIS server (RFC 8707), so a token
//      minted for another MCP server the user also authorized cannot be
//      replayed here,
//   4. in scope — checked per tool, not here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256, parseScope } from "./tokens";

export interface McpCaller {
  tokenId: string;
  userId: string;
  companyId: string;
  scopes: string[];
  clientId: string;
}

// Carries the RFC 6750 error so the route can build the right 401. `invalid_token`
// covers unknown/expired/revoked/wrong-audience alike — the client's remedy
// (re-authorize) is identical, and distinguishing them would leak token state.
export class BearerError extends Error {
  constructor(
    public readonly reason: "missing" | "invalid_token" | "insufficient_scope",
    public readonly description: string
  ) {
    super(description);
    this.name = "BearerError";
  }
}

export function extractBearer(authorization: string | null): string | null {
  if (!authorization) return null;
  const m = authorization.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Resolves the caller behind a bearer token, or throws BearerError. `audience`
 * is the canonical identifier of this resource (issuer + /api/mcp); a token
 * whose stored resource is set and does not match is refused.
 */
export async function authenticateBearer(
  db: SupabaseClient,
  authorization: string | null,
  audience: string
): Promise<McpCaller> {
  const token = extractBearer(authorization);
  if (!token) throw new BearerError("missing", "No bearer token was presented.");

  const { data: row } = await db
    .from("oauth_access_tokens")
    .select("id, client_id, user_id, company_id, scope, resource, revoked_at, expires_at")
    .eq("token_hash", sha256(token))
    .maybeSingle();

  if (!row) throw new BearerError("invalid_token", "The access token is invalid.");
  if (row.revoked_at) throw new BearerError("invalid_token", "The access token has been revoked.");
  if (new Date(row.expires_at) <= new Date()) {
    throw new BearerError("invalid_token", "The access token has expired.");
  }
  // Audience binding. A token with no stored resource is accepted (it predates
  // audience binding or was issued without one); a token WITH a resource must
  // match this server exactly.
  if (row.resource && row.resource !== audience) {
    throw new BearerError("invalid_token", "The access token was issued for a different resource.");
  }

  // Best-effort last-used stamp; never fail the request on it.
  void db.from("oauth_access_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", row.id);

  return {
    tokenId: row.id,
    userId: row.user_id,
    companyId: row.company_id,
    scopes: parseScope(row.scope),
    clientId: row.client_id,
  };
}

export function requireScope(caller: McpCaller, scope: string): void {
  if (!caller.scopes.includes(scope)) {
    throw new BearerError("insufficient_scope", `This token lacks the "${scope}" scope.`);
  }
}
