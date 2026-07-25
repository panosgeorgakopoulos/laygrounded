import { NextRequest, NextResponse } from "next/server";
import {
  buildProtectedResourceMetadata,
  resolveIssuer,
  DISCOVERY_HEADERS,
} from "@/lib/oauth/metadata";

// RFC 9728 — OAuth 2.0 Protected Resource Metadata.
//
// The first thing an MCP client fetches. It reaches the MCP endpoint with no
// token, gets a 401 carrying
//   WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"
// and comes here to learn which authorization server can issue it one.
//
// OPTIONAL CATCH-ALL, and that is the point. RFC 9728 locates this document by
// INSERTING the well-known segment before the resource's path, so a resource
// at https://host/api/mcp is discovered at
//   https://host/.well-known/oauth-protected-resource/api/mcp
// while other clients (and the RFC's own fallback) probe the bare
//   https://host/.well-known/oauth-protected-resource
// [[...suffix]] answers both from one handler. Serving only the bare form is
// a common and confusing failure: discovery 404s and the client reports
// nothing more useful than "authentication required".
//
// Public and unauthenticated by design — it names no secrets, only where to
// go next. It sits outside /api on purpose, so the deny-by-default CORS
// allowlist in src/proxy.ts does not apply and any client origin can read it.

export async function GET(req: NextRequest) {
  const issuer = resolveIssuer(req.url);
  return NextResponse.json(buildProtectedResourceMetadata(issuer), {
    headers: DISCOVERY_HEADERS,
  });
}

// Browser-based MCP clients preflight the cross-origin fetch.
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: DISCOVERY_HEADERS });
}
