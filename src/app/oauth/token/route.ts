import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  getClient,
  authenticateClient,
  redeemAuthorizationCode,
  issueTokensForGrant,
  rotateRefreshToken,
  OAuthError,
} from "@/lib/oauth/store";
import { parseScope } from "@/lib/oauth/tokens";
import { DISCOVERY_HEADERS } from "@/lib/oauth/metadata";

// RFC 6749 §3.2 token endpoint — the only two grants OAuth 2.1 leaves:
// authorization_code and refresh_token. There is no client_credentials or
// password grant, because every token here acts as a specific human inside
// one company.
//
// Never cached: it returns credentials. The store owns the security-critical
// logic (PKCE proof, single-use codes with replay revocation, refresh rotation
// with reuse detection); this handler is parsing, client authentication, and
// mapping OAuthError to the spec's JSON error body.

const NO_STORE = { ...DISCOVERY_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" };

function oauthError(e: OAuthError) {
  return NextResponse.json(
    { error: e.code, error_description: e.description },
    { status: e.status, headers: NO_STORE }
  );
}

// The token endpoint takes application/x-www-form-urlencoded (RFC 6749), not
// JSON. Client credentials may arrive in the body (client_secret_post) or in a
// Basic auth header (client_secret_basic).
function basicAuth(header: string | null): { id: string; secret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const [id, secret] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
    if (!id) return null;
    return { id, secret: secret ?? "" };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData().catch(() => null);
    if (!form) {
      throw new OAuthError("invalid_request", "Body must be application/x-www-form-urlencoded.");
    }
    const field = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : null;
    };

    const grantType = field("grant_type");

    // Client identity: header (Basic) wins over body, per RFC 6749.
    const basic = basicAuth(req.headers.get("authorization"));
    const clientId = basic?.id ?? field("client_id");
    const clientSecret = basic?.secret ?? field("client_secret");
    if (!clientId) {
      throw new OAuthError("invalid_client", "client_id is required.", 401);
    }

    const db = createServiceRoleClient();
    const client = await getClient(db, clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown or disabled client.", 401);
    if (!authenticateClient(client, clientSecret)) {
      throw new OAuthError("invalid_client", "Client authentication failed.", 401);
    }

    if (grantType === "authorization_code") {
      const code = field("code");
      const redirectUri = field("redirect_uri");
      const codeVerifier = field("code_verifier");
      if (!code || !redirectUri || !codeVerifier) {
        throw new OAuthError(
          "invalid_request",
          "code, redirect_uri and code_verifier are all required."
        );
      }
      const grant = await redeemAuthorizationCode(db, {
        code,
        clientId,
        redirectUri,
        codeVerifier,
        resource: field("resource"),
      });
      const tokens = await issueTokensForGrant(db, clientId, grant);
      return tokenResponse(tokens);
    }

    if (grantType === "refresh_token") {
      const refreshToken = field("refresh_token");
      if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required.");
      const requested = parseScope(field("scope"));
      const tokens = await rotateRefreshToken(db, clientId, refreshToken, requested.length ? requested : null);
      return tokenResponse(tokens);
    }

    throw new OAuthError(
      "unsupported_grant_type",
      `grant_type must be authorization_code or refresh_token. Received: ${grantType ?? "(none)"}.`
    );
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    console.error("[oauth/token]", e);
    return NextResponse.json(
      { error: "server_error" },
      { status: 500, headers: NO_STORE }
    );
  }
}

function tokenResponse(t: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }) {
  return NextResponse.json(
    {
      access_token: t.accessToken,
      token_type: "Bearer",
      expires_in: t.expiresIn,
      refresh_token: t.refreshToken,
      scope: t.scope,
    },
    { status: 200, headers: NO_STORE }
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
