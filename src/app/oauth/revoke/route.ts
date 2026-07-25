import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getClient, authenticateClient, revokeToken, OAuthError } from "@/lib/oauth/store";
import { DISCOVERY_HEADERS } from "@/lib/oauth/metadata";

// RFC 7009 — token revocation.
//
// The spec's defining quirk: an unknown, expired or already-revoked token is a
// SUCCESS, not an error. The client's goal is "make this token stop working";
// if it never worked, that goal is already met, and returning 200 also denies
// an attacker a way to probe which tokens exist. So the only failures here are
// a malformed request or a client that cannot authenticate — never the token
// itself. A refresh token revokes its entire family (see the store).

const NO_STORE = { ...DISCOVERY_HEADERS, "Cache-Control": "no-store" };

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
      return NextResponse.json(
        { error: "invalid_request" },
        { status: 400, headers: NO_STORE }
      );
    }
    const token = form.get("token");
    if (typeof token !== "string" || !token) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "token is required." },
        { status: 400, headers: NO_STORE }
      );
    }

    const basic = basicAuth(req.headers.get("authorization"));
    const clientId = basic?.id ?? (form.get("client_id") as string | null);
    const clientSecret = basic?.secret ?? (form.get("client_secret") as string | null);
    if (!clientId) {
      return NextResponse.json(
        { error: "invalid_client" },
        { status: 401, headers: NO_STORE }
      );
    }

    const db = createServiceRoleClient();
    const client = await getClient(db, clientId);
    if (!client || !authenticateClient(client, clientSecret)) {
      return NextResponse.json(
        { error: "invalid_client" },
        { status: 401, headers: NO_STORE }
      );
    }

    // Scoped to the presenting client: a client cannot revoke another's token.
    // Idempotent and silent about whether the token existed.
    await revokeToken(db, clientId, token);
    return new NextResponse(null, { status: 200, headers: NO_STORE });
  } catch (e) {
    if (e instanceof OAuthError) {
      return NextResponse.json(
        { error: e.code, error_description: e.description },
        { status: e.status, headers: NO_STORE }
      );
    }
    console.error("[oauth/revoke]", e);
    return NextResponse.json({ error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
