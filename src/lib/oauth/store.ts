// OAuth 2.1 persistence + the security-critical state transitions.
//
// The pure crypto lives in tokens.ts; this file is where those primitives meet
// the database, and it is deliberately the ONLY place that touches the oauth_*
// tables. Every function takes a SupabaseClient so the whole flow can be
// integration-tested against a throwaway Postgres with an injected service
// client — the same client the routes pass in production.
//
// Two transitions carry the weight of the whole design, and both are handled
// here rather than trusted to a caller:
//
//   * Authorization-code replay. A code is single-use. Presenting one twice
//     means it leaked, so the second presentation does not merely fail — it
//     revokes every token already minted from that code (RFC 6749 §4.1.2).
//
//   * Refresh-token reuse. Refresh tokens rotate and are single-use. A reused
//     one means two parties hold it; the correct response is to revoke the
//     entire token family, forcing a fresh, user-present authorization.
//
// Both claim their row with an atomic `UPDATE … WHERE consumed_at IS NULL`, so
// two concurrent redemptions cannot both succeed — the loser is treated
// exactly as a replay, which is what it is.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  generateAccessToken,
  generateAuthCode,
  generateClientId,
  generateClientSecret,
  generateRefreshToken,
  sha256,
  safeEqualHex,
  verifyPkce,
  narrowScope,
  parseScope,
  serialiseScope,
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_CODE_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./tokens";
import { OAUTH_SCOPES, type OAuthScope } from "./metadata";

// OAuth-defined error codes (RFC 6749 §5.2). Thrown as sentinels and mapped to
// the spec's JSON error body by the token route.
export class OAuthError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "unauthorized_client"
      | "unsupported_grant_type"
      | "invalid_scope"
      | "server_error",
    public readonly description: string,
    public readonly status = 400
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

function nowPlus(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Clients (RFC 7591 dynamic registration)
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string; // returned once, only for confidential clients
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
}

export interface RegisterClientInput {
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  scope: string[];
  softwareId?: string;
  softwareVersion?: string;
}

export async function registerClient(
  db: SupabaseClient,
  input: RegisterClientInput
): Promise<RegisteredClient> {
  const clientId = generateClientId();
  const confidential = input.tokenEndpointAuthMethod !== "none";
  const secret = confidential ? generateClientSecret() : null;

  // A client may only ever be granted scopes the server actually defines; an
  // unknown scope in a registration request is dropped, not honoured.
  const scope = serialiseScope(narrowScope(input.scope, [...OAUTH_SCOPES]));

  const { error } = await db.from("oauth_clients").insert({
    client_id: clientId,
    client_secret_hash: secret?.hash ?? null,
    client_name: input.clientName.slice(0, 255),
    redirect_uris: input.redirectUris,
    token_endpoint_auth_method: input.tokenEndpointAuthMethod,
    scope,
    software_id: input.softwareId ?? null,
    software_version: input.softwareVersion ?? null,
  });
  if (error) throw new OAuthError("server_error", `client registration failed: ${error.message}`, 500);

  return {
    clientId,
    clientSecret: secret?.plaintext,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
    scope,
  };
}

export interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  scope: string;
  status: string;
}

export async function getClient(db: SupabaseClient, clientId: string): Promise<ClientRow | null> {
  if (!clientId) return null;
  const { data } = await db
    .from("oauth_clients")
    .select(
      "client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, scope, status"
    )
    .eq("client_id", clientId)
    .maybeSingle();
  if (!data || data.status !== "active") return null;
  return data as ClientRow;
}

// Exact-match, never prefix or wildcard. A substring match on the redirect URI
// is the open-redirect that delivers the authorization code to an attacker.
export function redirectUriAllowed(client: ClientRow, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

// Confidential clients must prove their secret at the token endpoint; public
// clients ("none") rely solely on PKCE, which is why PKCE is mandatory.
export function authenticateClient(client: ClientRow, providedSecret: string | null): boolean {
  if (client.token_endpoint_auth_method === "none") return true;
  if (!client.client_secret_hash || !providedSecret) return false;
  return safeEqualHex(sha256(providedSecret), client.client_secret_hash);
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export interface CreateAuthCodeInput {
  clientId: string;
  userId: string;
  companyId: string;
  redirectUri: string;
  scope: string[];
  codeChallenge: string; // S256 challenge; method is fixed by the schema
  resource: string | null;
}

/** Mints a single-use code AFTER the user has consented. Returns plaintext. */
export async function createAuthorizationCode(
  db: SupabaseClient,
  input: CreateAuthCodeInput
): Promise<string> {
  const code = generateAuthCode();
  const { error } = await db.from("oauth_authorization_codes").insert({
    code_hash: code.hash,
    client_id: input.clientId,
    user_id: input.userId,
    company_id: input.companyId,
    redirect_uri: input.redirectUri,
    scope: serialiseScope(input.scope),
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    resource: input.resource,
    expires_at: nowPlus(AUTH_CODE_TTL_SECONDS),
  });
  if (error) throw new OAuthError("server_error", `code issue failed: ${error.message}`, 500);
  return code.plaintext;
}

export interface RedeemAuthCodeInput {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string | null;
}

export interface GrantContext {
  userId: string;
  companyId: string;
  scope: string[];
  resource: string | null;
  authorizationCodeId: string;
}

/**
 * Validates and consumes an authorization code. On any replay — a code already
 * consumed — every token minted from it is revoked before the error is
 * returned.
 */
export async function redeemAuthorizationCode(
  db: SupabaseClient,
  input: RedeemAuthCodeInput
): Promise<GrantContext> {
  const codeHash = sha256(input.code);
  const { data: row } = await db
    .from("oauth_authorization_codes")
    .select(
      "id, client_id, user_id, company_id, redirect_uri, scope, code_challenge, resource, consumed_at, expires_at"
    )
    .eq("code_hash", codeHash)
    .maybeSingle();

  if (!row) throw new OAuthError("invalid_grant", "Authorization code is invalid.");

  // Replay: the code was already spent. Treat the leak seriously — revoke its
  // descendants — then refuse.
  if (row.consumed_at) {
    await revokeTokensFromCode(db, row.id);
    throw new OAuthError("invalid_grant", "Authorization code has already been used.");
  }

  if (new Date(row.expires_at) <= new Date()) {
    throw new OAuthError("invalid_grant", "Authorization code has expired.");
  }
  // The code is bound to the client and redirect it was issued to; a mismatch
  // means it is being redeemed by someone other than its originator.
  if (row.client_id !== input.clientId) {
    throw new OAuthError("invalid_grant", "Authorization code was issued to a different client.");
  }
  if (row.redirect_uri !== input.redirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
  }
  // RFC 8707: a token must not be redeemable against a different audience than
  // the one the user authorized.
  if ((row.resource ?? null) !== (input.resource ?? null)) {
    throw new OAuthError("invalid_grant", "resource does not match the authorization request.");
  }
  // PKCE proof.
  if (!verifyPkce(input.codeVerifier, row.code_challenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed.");
  }

  // Atomic claim: only one redemption can flip consumed_at from null. A loser
  // here is a concurrent double-spend — handled as the replay it is.
  const { data: claimed } = await db
    .from("oauth_authorization_codes")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) {
    await revokeTokensFromCode(db, row.id);
    throw new OAuthError("invalid_grant", "Authorization code has already been used.");
  }

  return {
    userId: row.user_id,
    companyId: row.company_id,
    scope: parseScope(row.scope),
    resource: row.resource ?? null,
    authorizationCodeId: row.id,
  };
}

async function revokeTokensFromCode(db: SupabaseClient, codeId: string): Promise<void> {
  const stamp = new Date().toISOString();
  await db
    .from("oauth_access_tokens")
    .update({ revoked_at: stamp })
    .eq("authorization_code_id", codeId)
    .is("revoked_at", null);
  // Refresh tokens link to their access token; revoke the whole families.
  const { data: ats } = await db
    .from("oauth_access_tokens")
    .select("id")
    .eq("authorization_code_id", codeId);
  for (const at of ats ?? []) {
    await db
      .from("oauth_refresh_tokens")
      .update({ revoked_at: stamp, revoked_reason: "authorization_code_replayed" })
      .eq("access_token_id", at.id)
      .is("revoked_at", null);
  }
}

// ---------------------------------------------------------------------------
// Token issuance & rotation
// ---------------------------------------------------------------------------

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

interface IssueInput {
  clientId: string;
  userId: string;
  companyId: string;
  scope: string[];
  resource: string | null;
  authorizationCodeId?: string | null;
  familyId?: string | null; // set when rotating within an existing family
}

async function issueTokens(db: SupabaseClient, input: IssueInput): Promise<IssuedTokens> {
  const access = generateAccessToken();
  const refresh = generateRefreshToken();
  const scope = serialiseScope(input.scope);

  const { data: at, error: atErr } = await db
    .from("oauth_access_tokens")
    .insert({
      token_hash: access.hash,
      client_id: input.clientId,
      user_id: input.userId,
      company_id: input.companyId,
      scope,
      resource: input.resource,
      authorization_code_id: input.authorizationCodeId ?? null,
      expires_at: nowPlus(ACCESS_TOKEN_TTL_SECONDS),
    })
    .select("id")
    .single();
  if (atErr || !at) throw new OAuthError("server_error", `access token issue failed: ${atErr?.message}`, 500);

  const refreshRow: Record<string, unknown> = {
    token_hash: refresh.hash,
    client_id: input.clientId,
    user_id: input.userId,
    company_id: input.companyId,
    scope,
    resource: input.resource,
    access_token_id: at.id,
    expires_at: nowPlus(REFRESH_TOKEN_TTL_SECONDS),
  };
  // Rotation stays inside the original family so reuse detection can walk it.
  if (input.familyId) refreshRow.family_id = input.familyId;

  const { data: rt, error: rtErr } = await db
    .from("oauth_refresh_tokens")
    .insert(refreshRow)
    .select("id")
    .single();
  if (rtErr || !rt) throw new OAuthError("server_error", `refresh token issue failed: ${rtErr?.message}`, 500);

  return {
    accessToken: access.plaintext,
    refreshToken: refresh.plaintext,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope,
  };
}

/** authorization_code grant → first token pair. */
export async function issueTokensForGrant(
  db: SupabaseClient,
  clientId: string,
  grant: GrantContext
): Promise<IssuedTokens> {
  return issueTokens(db, {
    clientId,
    userId: grant.userId,
    companyId: grant.companyId,
    scope: grant.scope,
    resource: grant.resource,
    authorizationCodeId: grant.authorizationCodeId,
  });
}

/**
 * refresh_token grant → rotated token pair, with reuse detection.
 *
 * A refresh token is single-use. Presenting a consumed one means it is held by
 * two parties, so the whole family is revoked and the request refused —
 * rotation without this is just a stolen token that works once.
 */
export async function rotateRefreshToken(
  db: SupabaseClient,
  clientId: string,
  refreshToken: string,
  requestedScope: string[] | null
): Promise<IssuedTokens> {
  const hash = sha256(refreshToken);
  const { data: row } = await db
    .from("oauth_refresh_tokens")
    .select(
      "id, family_id, client_id, user_id, company_id, scope, resource, consumed_at, revoked_at, expires_at"
    )
    .eq("token_hash", hash)
    .maybeSingle();

  if (!row) throw new OAuthError("invalid_grant", "Refresh token is invalid.");
  if (row.client_id !== clientId) {
    throw new OAuthError("invalid_grant", "Refresh token was issued to a different client.");
  }
  if (row.revoked_at) throw new OAuthError("invalid_grant", "Refresh token has been revoked.");

  // Reuse: already consumed → two holders. Burn the family.
  if (row.consumed_at) {
    await revokeFamily(db, row.family_id, "refresh_token_reuse");
    throw new OAuthError("invalid_grant", "Refresh token has already been used; session revoked.");
  }
  if (new Date(row.expires_at) <= new Date()) {
    throw new OAuthError("invalid_grant", "Refresh token has expired.");
  }

  // Atomic single-use claim. A concurrent second use loses here and is treated
  // as reuse.
  const { data: claimed } = await db
    .from("oauth_refresh_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) {
    await revokeFamily(db, row.family_id, "refresh_token_reuse");
    throw new OAuthError("invalid_grant", "Refresh token has already been used; session revoked.");
  }

  // Scope may narrow on refresh, never widen (RFC 6749 §6).
  const granted = parseScope(row.scope);
  const scope = requestedScope && requestedScope.length ? narrowScope(requestedScope, granted) : granted;

  const issued = await issueTokens(db, {
    clientId,
    userId: row.user_id,
    companyId: row.company_id,
    scope,
    resource: row.resource ?? null,
    familyId: row.family_id,
  });

  // Link the spent token to its successor so the chain is walkable.
  const { data: newRt } = await db
    .from("oauth_refresh_tokens")
    .select("id")
    .eq("token_hash", sha256(issued.refreshToken))
    .maybeSingle();
  if (newRt) {
    await db.from("oauth_refresh_tokens").update({ rotated_to_id: newRt.id }).eq("id", row.id);
  }

  return issued;
}

async function revokeFamily(db: SupabaseClient, familyId: string, reason: string): Promise<void> {
  const stamp = new Date().toISOString();
  const { data: fam } = await db
    .from("oauth_refresh_tokens")
    .select("access_token_id")
    .eq("family_id", familyId);
  await db
    .from("oauth_refresh_tokens")
    .update({ revoked_at: stamp, revoked_reason: reason })
    .eq("family_id", familyId)
    .is("revoked_at", null);
  const accessIds = (fam ?? []).map((r) => r.access_token_id).filter(Boolean);
  if (accessIds.length) {
    await db
      .from("oauth_access_tokens")
      .update({ revoked_at: stamp })
      .in("id", accessIds)
      .is("revoked_at", null);
  }
}

// ---------------------------------------------------------------------------
// Revocation (RFC 7009) & consent
// ---------------------------------------------------------------------------

/**
 * Revokes a presented token. RFC 7009: an already-invalid or unknown token is
 * a SUCCESS (the client's goal — that this token not work — is satisfied), so
 * this never errors on "not found". A refresh token revokes its whole family.
 */
export async function revokeToken(
  db: SupabaseClient,
  clientId: string,
  token: string
): Promise<void> {
  const hash = sha256(token);
  const stamp = new Date().toISOString();

  const { data: at } = await db
    .from("oauth_access_tokens")
    .select("id, client_id")
    .eq("token_hash", hash)
    .maybeSingle();
  if (at) {
    if (at.client_id === clientId) {
      await db.from("oauth_access_tokens").update({ revoked_at: stamp }).eq("id", at.id);
    }
    return;
  }

  const { data: rt } = await db
    .from("oauth_refresh_tokens")
    .select("id, client_id, family_id")
    .eq("token_hash", hash)
    .maybeSingle();
  if (rt && rt.client_id === clientId) {
    await revokeFamily(db, rt.family_id, "client_revocation");
  }
}

/** Records (or refreshes) the consent a user granted a client. */
export async function recordConsent(
  db: SupabaseClient,
  userId: string,
  companyId: string,
  clientId: string,
  scope: string[]
): Promise<void> {
  await db.from("oauth_consents").upsert(
    {
      user_id: userId,
      company_id: companyId,
      client_id: clientId,
      scope: serialiseScope(scope),
      granted_at: new Date().toISOString(),
      revoked_at: null,
    },
    { onConflict: "user_id,client_id" }
  );
}

export interface UserConsent {
  clientId: string;
  clientName: string;
  scope: string[];
  grantedAt: string;
}

/**
 * The active consents a user has granted — "which AI clients can reach my
 * claims", the question oauth_consents exists to answer. Joined with the client
 * name so the UI shows something a human recognises, not an opaque id. Revoked
 * grants are omitted; a client the user never authorised is simply absent.
 */
export async function listUserConsents(
  db: SupabaseClient,
  userId: string
): Promise<UserConsent[]> {
  const { data } = await db
    .from("oauth_consents")
    .select("client_id, scope, granted_at, oauth_clients(client_name)")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("granted_at", { ascending: false });

  return (data ?? []).map((row: Record<string, unknown>) => {
    const client = row.oauth_clients as { client_name?: string } | null;
    return {
      clientId: row.client_id as string,
      clientName: client?.client_name || (row.client_id as string),
      scope: parseScope((row.scope as string) ?? ""),
      grantedAt: row.granted_at as string,
    };
  });
}

export interface RevokeClientAccessResult {
  found: boolean;
  accessRevoked: number;
  refreshRevoked: number;
}

/**
 * Revokes a user's grant to one client and — the part that actually matters —
 * kills every live token issued under it. A plain UPDATE on oauth_consents
 * would hide the grant in the UI while leaving working access/refresh tokens
 * behind; revocation only means something if the client STOPS being able to
 * reach the data. That is why this lives here and the RLS policy on
 * oauth_consents is read-only. Idempotent: re-revoking finds nothing live left.
 */
export async function revokeClientAccess(
  db: SupabaseClient,
  userId: string,
  clientId: string
): Promise<RevokeClientAccessResult> {
  const stamp = new Date().toISOString();

  // Does the grant exist at all? Distinguishes "revoked" (200, real effect)
  // from "you never authorised this client" (404 at the route).
  const { data: consent } = await db
    .from("oauth_consents")
    .select("id")
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .maybeSingle();

  await db
    .from("oauth_consents")
    .update({ revoked_at: stamp })
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .is("revoked_at", null);

  // Only ever this user's own tokens for this client — scoped by BOTH columns,
  // so one user revoking a shared public client cannot revoke another's tokens.
  const { data: access } = await db
    .from("oauth_access_tokens")
    .update({ revoked_at: stamp })
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .select("id");

  const { data: refresh } = await db
    .from("oauth_refresh_tokens")
    .update({ revoked_at: stamp, revoked_reason: "consent_revoked" })
    .eq("user_id", userId)
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .select("id");

  return {
    found: !!consent,
    accessRevoked: access?.length ?? 0,
    refreshRevoked: refresh?.length ?? 0,
  };
}

/** Validates the requested scope against what the server defines. */
export function validateRequestedScope(requested: string[]): OAuthScope[] {
  return narrowScope(requested, [...OAUTH_SCOPES]) as OAuthScope[];
}
