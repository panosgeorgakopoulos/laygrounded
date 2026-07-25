// Authorization-request validation — the pure half of /oauth/authorize.
//
// The single most important rule of an authorize endpoint lives here: errors
// split into two kinds, and confusing them is a vulnerability.
//
//   * If client_id is unknown or redirect_uri is not on the client's exact
//     allowlist, the request MUST NOT redirect. Redirecting an
//     unvalidated URI is precisely how a code is delivered to an attacker.
//     These fail to a rendered error page.
//
//   * Every other error (bad response_type, missing/short PKCE challenge,
//     unsupported scope) redirects back to the ALREADY-VALIDATED redirect_uri
//     with an OAuth error and the client's state — because at that point the
//     redirect target is known to be trustworthy.
//
// This function decides which bucket a request falls into. It does not touch
// the database or the session; the page composes it with a client lookup.

import { isValidCodeChallenge } from "./tokens";
import { OAUTH_SCOPES } from "./metadata";

export interface RawAuthorizeParams {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  scope?: string | null;
  state?: string | null;
  resource?: string | null;
}

export interface ValidatedAuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string[];
  state: string | null;
  resource: string | null;
}

// A hard failure that must be shown, never redirected.
export interface FatalAuthorizeError {
  kind: "fatal";
  error: string;
  description: string;
}

// A failure that is safe to hand back to the (validated) redirect_uri.
export interface RedirectableAuthorizeError {
  kind: "redirect";
  error: string;
  description: string;
  state: string | null;
}

export type AuthorizeValidation =
  | { kind: "ok"; request: ValidatedAuthorizeRequest }
  | FatalAuthorizeError
  | RedirectableAuthorizeError;

/**
 * Validates the query of an authorization request, given a function that
 * resolves a client's exact redirect-URI allowlist (or null if the client is
 * unknown). The redirect-URI check happens FIRST and FATALLY, so that every
 * subsequent error can be safely redirected.
 */
export function validateAuthorizeRequest(
  p: RawAuthorizeParams,
  clientRedirectUris: string[] | null
): AuthorizeValidation {
  // 1. Client and redirect URI — fatal, and in this order. A missing client,
  //    an unknown client, or a redirect URI not on its allowlist are all
  //    shown, never redirected.
  if (!p.client_id) {
    return { kind: "fatal", error: "invalid_request", description: "client_id is required." };
  }
  if (clientRedirectUris === null) {
    return { kind: "fatal", error: "invalid_client", description: "Unknown client." };
  }
  if (!p.redirect_uri) {
    return { kind: "fatal", error: "invalid_request", description: "redirect_uri is required." };
  }
  if (!clientRedirectUris.includes(p.redirect_uri)) {
    return {
      kind: "fatal",
      error: "invalid_request",
      description: "redirect_uri is not registered for this client.",
    };
  }

  // From here the redirect target is trusted, so errors go back to it.
  const state = p.state ?? null;
  const redirectErr = (error: string, description: string): RedirectableAuthorizeError => ({
    kind: "redirect",
    error,
    description,
    state,
  });

  // 2. Response type — code only. `token` (implicit) is gone in OAuth 2.1.
  if (p.response_type !== "code") {
    return redirectErr(
      "unsupported_response_type",
      "Only response_type=code is supported."
    );
  }

  // 3. PKCE is mandatory, S256 only. A missing challenge is not an optional
  //    omission here — it is a rejected request.
  if (!p.code_challenge) {
    return redirectErr("invalid_request", "code_challenge is required (PKCE is mandatory).");
  }
  // Absent method defaults to S256 per our metadata; an explicit non-S256 is
  // refused rather than silently upgraded.
  if (p.code_challenge_method && p.code_challenge_method !== "S256") {
    return redirectErr(
      "invalid_request",
      "code_challenge_method must be S256."
    );
  }
  if (!isValidCodeChallenge(p.code_challenge)) {
    return redirectErr(
      "invalid_request",
      "code_challenge is malformed (expected a base64url SHA-256 digest)."
    );
  }

  // 4. Scope. An unknown scope is refused rather than silently dropped, so the
  //    user is never shown a consent screen that misrepresents what was asked.
  const requested = (p.scope ?? "").split(/\s+/).filter(Boolean);
  const known = new Set<string>(OAUTH_SCOPES);
  const unknown = requested.filter((s) => !known.has(s));
  if (unknown.length) {
    return redirectErr("invalid_scope", `Unknown scope(s): ${unknown.join(", ")}.`);
  }
  // Empty scope is allowed and means "no scopes"; the consent screen makes
  // that explicit rather than silently granting a default.

  return {
    kind: "ok",
    request: {
      clientId: p.client_id,
      redirectUri: p.redirect_uri,
      codeChallenge: p.code_challenge,
      scope: requested,
      state,
      resource: p.resource ?? null,
    },
  };
}

/** Builds a redirect URL that appends params without clobbering an existing query. */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | null | undefined>
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  return url.toString();
}

// Human-readable labels for the consent screen. A scope the user cannot
// understand is a consent they cannot meaningfully give.
export const SCOPE_LABELS: Record<string, string> = {
  "claims:read": "Read your claims, calculations and event timelines",
  "claims:write": "Create and amend claims and charter-party terms",
  "documents:write": "Upload Statements of Facts for extraction",
  "analysis:read": "Read laytime results, evidence verdicts and negotiation intel",
};
