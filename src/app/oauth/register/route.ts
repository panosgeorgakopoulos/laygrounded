import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { registerClient, OAuthError } from "@/lib/oauth/store";
import { DISCOVERY_HEADERS } from "@/lib/oauth/metadata";

// RFC 7591 — OAuth 2.0 Dynamic Client Registration.
//
// An MCP client the operator installs today was not registered with us
// yesterday, so it registers itself at first use. This endpoint is therefore
// UNAUTHENTICATED by necessity — which shapes everything about it:
//
//  * client_id is a public identifier, never a credential. Nothing that
//    happens here grants access; the client still has to send its user
//    through /oauth/authorize, where a human logs in and consents. A
//    registration is a name badge, not a key.
//  * It is a public write endpoint, so it is treated as hostile input:
//    strict schema, https-only redirect URIs with no wildcards, a hard cap on
//    how many can be registered, and the per-IP rate limit from src/proxy.ts.
//  * Secrets, when issued (confidential clients), are returned exactly once.

const RegisterSchema = z.object({
  client_name: z.string().min(1).max(255).default("MCP Client"),
  // Exact-match allowlist. OAuth 2.1 forbids wildcards; loopback and custom
  // schemes (installed apps) are allowed, everything else must be https.
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_post", "client_secret_basic"])
    .default("none"),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
  software_id: z.string().max(255).optional(),
  software_version: z.string().max(64).optional(),
});

// A redirect URI must be either https, or a loopback/custom-scheme URI that an
// installed app legitimately uses. http on a public host is refused: the code
// would travel in cleartext.
function redirectUriAcceptable(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  }
  // A custom scheme (com.example.app:/cb) has no host; that is how native apps
  // receive the redirect, and it cannot be intercepted over the network.
  return u.protocol.endsWith(":") && !u.hostname;
}

export async function POST(req: NextRequest) {
  try {
    const parsed = RegisterSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_client_metadata", error_description: "Malformed registration request." },
        { status: 400, headers: DISCOVERY_HEADERS }
      );
    }

    const bad = parsed.data.redirect_uris.filter((u) => !redirectUriAcceptable(u));
    if (bad.length) {
      return NextResponse.json(
        {
          error: "invalid_redirect_uri",
          error_description:
            "Redirect URIs must be https, a loopback http URI, or a custom scheme. Received: " +
            bad.join(", "),
        },
        { status: 400, headers: DISCOVERY_HEADERS }
      );
    }

    const db = createServiceRoleClient();
    const client = await registerClient(db, {
      clientName: parsed.data.client_name,
      redirectUris: parsed.data.redirect_uris,
      tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method,
      scope: parsed.data.scope ? parsed.data.scope.split(/\s+/).filter(Boolean) : [],
      softwareId: parsed.data.software_id,
      softwareVersion: parsed.data.software_version,
    });

    // RFC 7591 §3.2.1 response shape.
    return NextResponse.json(
      {
        client_id: client.clientId,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: client.scope,
        // Non-expiring registration; there is no rotation flow for it here.
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      { status: 201, headers: DISCOVERY_HEADERS }
    );
  } catch (e) {
    if (e instanceof OAuthError) {
      return NextResponse.json(
        { error: "invalid_client_metadata", error_description: e.description },
        { status: e.status, headers: DISCOVERY_HEADERS }
      );
    }
    console.error("[oauth/register]", e);
    return NextResponse.json(
      { error: "server_error" },
      { status: 500, headers: DISCOVERY_HEADERS }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: DISCOVERY_HEADERS });
}
