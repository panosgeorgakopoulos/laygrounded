import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { authenticateBearer, BearerError } from "@/lib/oauth/bearer";
import { dispatchMcp, JSON_RPC_CODES, type JsonRpcRequest } from "@/lib/oauth/mcp";
import { resolveIssuer, MCP_ENDPOINT_PATH } from "@/lib/oauth/metadata";

// The MCP transport — Streamable HTTP, JSON-RPC 2.0.
//
// An authenticated AI client POSTs JSON-RPC here to list and call tools. The
// endpoint's whole job before dispatch is to prove the bearer token and hand
// the tools a company-scoped context; the tools themselves cannot widen it.
//
// The 401 is load-bearing. A client with no or a bad token gets
//   WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"
// which is exactly the RFC 9728 breadcrumb that starts discovery — so an
// unauthenticated call is not a dead end, it is the first step of the OAuth
// dance. This is why the discovery routes and this 401 have to agree on the
// resource URL.

function audienceFor(req: NextRequest): string {
  return `${resolveIssuer(req.url)}${MCP_ENDPOINT_PATH}`;
}

// RFC 9728 §5.1: point an unauthenticated caller at the resource metadata.
function challenge(req: NextRequest, error?: string, description?: string): string {
  const resourceMetadata = `${resolveIssuer(req.url)}/.well-known/oauth-protected-resource${MCP_ENDPOINT_PATH}`;
  const parts = [`Bearer resource_metadata="${resourceMetadata}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(", ");
}

function unauthorized(req: NextRequest, e: BearerError): NextResponse {
  const status = e.reason === "insufficient_scope" ? 403 : 401;
  const error = e.reason === "missing" ? undefined : e.reason;
  return NextResponse.json(
    { error: e.reason, error_description: e.description },
    {
      status,
      headers: {
        "WWW-Authenticate": challenge(req, error, e.description),
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function POST(req: NextRequest) {
  const db = createServiceRoleClient();

  // 1. Authenticate the token, or emit the discovery-triggering 401.
  let caller;
  try {
    caller = await authenticateBearer(db, req.headers.get("authorization"), audienceFor(req));
  } catch (e) {
    if (e instanceof BearerError) return unauthorized(req, e);
    console.error("[api/mcp] auth", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  // 2. Parse the JSON-RPC body. A batch is an array; a single call is an object.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_CODES.PARSE_ERROR, message: "Invalid JSON." } },
      { status: 400 }
    );
  }

  const ctx = { db, caller };

  try {
    if (Array.isArray(body)) {
      // Batch: dispatch each, drop notification nulls, and if NOTHING needs a
      // response (all notifications) answer 202 with no body per JSON-RPC.
      const responses = (await Promise.all(body.map((m) => dispatchMcp(m as JsonRpcRequest, ctx)))).filter(
        (r) => r !== null
      );
      if (responses.length === 0) return new NextResponse(null, { status: 202 });
      return NextResponse.json(responses, { headers: { "Cache-Control": "no-store" } });
    }

    const response = await dispatchMcp(body as JsonRpcRequest, ctx);
    if (response === null) return new NextResponse(null, { status: 202 }); // a notification
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/mcp] dispatch", e);
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: JSON_RPC_CODES.INTERNAL_ERROR, message: "Internal error." } },
      { status: 500 }
    );
  }
}

// A bare GET is how some clients probe for auth before opening a session.
// Answer with the same discovery-pointing 401 rather than a 405.
export async function GET(req: NextRequest) {
  const db = createServiceRoleClient();
  try {
    await authenticateBearer(db, req.headers.get("authorization"), audienceFor(req));
  } catch (e) {
    if (e instanceof BearerError) return unauthorized(req, e);
  }
  // A valid token on GET: nothing to stream in this minimal transport.
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
