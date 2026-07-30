// OAuth 2.1 discovery metadata for the LayGrounded MCP server.
//
// LayGrounded acts as BOTH roles here, which is why one file produces both
// documents:
//   * Resource Server — the MCP endpoint an AI client calls.
//   * Authorization Server — the thing that logs the operator in and issues
//     the token. Supabase Auth cannot fill this role: it has no dynamic client
//     registration and does not mint audience-bound tokens for arbitrary
//     third-party clients, so it authenticates the HUMAN and this layer issues
//     the client's token on top of that session.
//
// Two documents, two RFCs, both fetched by the client before it ever sees a
// token:
//   RFC 9728  /.well-known/oauth-protected-resource   → "who guards me"
//   RFC 8414  /.well-known/oauth-authorization-server → "how to get a token"
//
// OAuth 2.1 (and the MCP authorization spec) narrow classic OAuth 2.0
// deliberately, and the metadata is where those constraints are advertised:
//   - PKCE is mandatory, S256 only. "plain" is NOT offered — it provides no
//     protection against an attacker who can observe the authorization code.
//   - No implicit grant and no password grant; authorization_code + refresh
//     only.
//   - Public clients authenticate with "none" at the token endpoint; PKCE is
//     what binds the code to the client, not a secret an installed app cannot
//     keep anyway.
//   - RFC 8707 `resource` is advertised so tokens are audience-bound: a token
//     minted for this server must not be replayable against another MCP
//     server the same user happens to have authorized.

export const OAUTH_SCOPES = [
  "claims:read", // list claims, calculations, event timelines
  "claims:write", // create and amend claims and CP terms
  "documents:write", // upload a Statement of Facts for extraction
  "analysis:read", // laytime results, sensitivity, evidence verdicts
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

// Where the MCP transport itself lives. The discovery documents point at it,
// so it is defined once.
export const MCP_ENDPOINT_PATH = "/api/mcp";

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  service_documentation?: string;
}

/**
 * Normalises an origin: scheme + host, no trailing slash, no path.
 * The issuer is an identity that clients compare by exact string, so a stray
 * slash is a real mismatch, not cosmetics.
 */
export function normaliseIssuer(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * The issuer this deployment publishes.
 *
 * Configuration wins over the request. Deriving the origin from the Host
 * header alone would let anyone who can reach the app with a forged Host
 * publish metadata pointing at an authorization server they control — and a
 * client that follows it would hand its user's credentials there. Behind a
 * proxy the header is attacker-influenced, so it is the LAST resort and is
 * only used when nothing is configured (local development).
 */
export function resolveIssuer(
  requestUrl: string,
  env: Record<string, string | undefined> = process.env
): string {
  const configured =
    normaliseIssuer(env.OAUTH_ISSUER_URL ?? "") ?? normaliseIssuer(env.NEXTAUTH_URL ?? "");
  if (configured) return configured;
  return normaliseIssuer(requestUrl) ?? "";
}

export function buildProtectedResourceMetadata(issuer: string): ProtectedResourceMetadata {
  return {
    // The canonical identifier of THIS resource server — the same string a
    // client must send as the RFC 8707 `resource` parameter, and the audience
    // the token endpoint will stamp into the token.
    resource: `${issuer}${MCP_ENDPOINT_PATH}`,
    authorization_servers: [issuer],
    scopes_supported: [...OAUTH_SCOPES],
    // Bearer in the Authorization header only. Accepting tokens in a query
    // string would write them into every access log and Referer header.
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/api/v1/openapi.json`,
  };
}

export function buildAuthorizationServerMetadata(issuer: string): AuthorizationServerMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    // RFC 7591. An MCP client the operator installs today was not registered
    // with us yesterday, so it registers itself at first use.
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    // Code flow only. `token` (implicit) is absent by design: it returns
    // credentials in the URL fragment, which OAuth 2.1 removes outright.
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    // No `password`, no `implicit`, no `client_credentials` — every one of
    // these tokens acts as a specific human inside one company, so there is
    // no flow here without a user at the keyboard.
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // S256 only, deliberately. Advertising "plain" would let a client
    // downgrade to it, which is no protection at all.
    code_challenge_methods_supported: ["S256"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    service_documentation: `${issuer}/legal/terms`,
  };
}

// Discovery documents are fetched cross-origin by clients that have no
// session and no allowlisted origin — they are public, unauthenticated and
// contain no secrets, so wildcard CORS is correct here (and only here; the
// /api surface keeps its deny-by-default allowlist in src/proxy.ts).
export const DISCOVERY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Cache-Control": "public, max-age=3600",
};
