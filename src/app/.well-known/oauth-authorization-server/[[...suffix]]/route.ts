import { NextRequest, NextResponse } from "next/server";
import {
  buildAuthorizationServerMetadata,
  resolveIssuer,
  DISCOVERY_HEADERS,
} from "@/lib/oauth/metadata";

// RFC 8414 — OAuth 2.0 Authorization Server Metadata.
//
// Fetched second, using the `authorization_servers` entry the protected-
// resource document returned. It tells the client where to send the user, how
// to redeem the code, how to register itself, and — the part that matters for
// OAuth 2.1 — which PKCE methods exist. A client that finds no
// code_challenge_methods_supported is entitled to assume PKCE is unavailable;
// publishing ["S256"] and nothing else is how "PKCE required, S256 only"
// becomes machine-readable rather than a line in a README.
//
// Same optional catch-all as the protected-resource document: clients built
// against different drafts of the MCP spec probe both the bare path and the
// path-suffixed form, and answering only one produces a discovery 404 that
// surfaces to the user as an unexplained login failure.
//
// Public, unauthenticated, cacheable. Every value here is a public endpoint
// URL or a supported-algorithm list.

export async function GET(req: NextRequest) {
  const issuer = resolveIssuer(req.url);
  return NextResponse.json(buildAuthorizationServerMetadata(issuer), {
    headers: DISCOVERY_HEADERS,
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: DISCOVERY_HEADERS });
}
