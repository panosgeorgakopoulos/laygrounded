import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import {
  getClient,
  redirectUriAllowed,
  createAuthorizationCode,
  recordConsent,
} from "@/lib/oauth/store";
import { buildRedirect, validateAuthorizeRequest } from "@/lib/oauth/authorize";
import { isValidCodeChallenge, narrowScope, parseScope } from "@/lib/oauth/tokens";
import { OAUTH_SCOPES } from "@/lib/oauth/metadata";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";

// Handles the Approve / Deny click from the consent screen.
//
// Everything security-relevant is re-derived here from the database and the
// session — the hidden form fields are treated as untrusted input, exactly as
// if they had been hand-crafted:
//   * the client is re-fetched and must be active,
//   * the redirect_uri is re-checked against the client's stored allowlist
//     (and, as at /authorize, a mismatch is shown, never redirected),
//   * the code is minted for the LOGGED-IN user's own id and company, so a
//     forged field cannot mint a code for someone else.
//
// The Supabase session cookie is SameSite, so this POST cannot be driven from
// another origin — a cross-site auto-submit arrives with no session and is
// refused before anything is issued.

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return bad("Malformed request.");

  const clientId = str(form, "client_id");
  const redirectUri = str(form, "redirect_uri");
  const codeChallenge = str(form, "code_challenge");
  const scopeRaw = str(form, "scope");
  const state = str(form, "state");
  const resource = str(form, "resource");
  const decision = str(form, "decision");

  // The user must still be authenticated at the moment of decision.
  let auth;
  try {
    auth = await requireAuth();
  } catch {
    // Session lapsed between rendering and clicking — send them to sign in and
    // back to a fresh authorize request rather than issuing anything.
    const back = new URLSearchParams();
    back.set("response_type", "code");
    if (clientId) back.set("client_id", clientId);
    if (redirectUri) back.set("redirect_uri", redirectUri);
    if (codeChallenge) back.set("code_challenge", codeChallenge);
    if (scopeRaw) back.set("scope", scopeRaw);
    if (state) back.set("state", state);
    if (resource) back.set("resource", resource);
    return NextResponse.redirect(
      new URL(`/sign-in?next=${encodeURIComponent(`/oauth/authorize?${back.toString()}`)}`, req.url),
      { status: 303 }
    );
  }

  const db = createServiceRoleClient();
  const client = clientId ? await getClient(db, clientId) : null;

  // Re-validate the whole request server-side. A tampered redirect_uri lands
  // in the fatal bucket and is shown, never redirected.
  const validation = validateAuthorizeRequest(
    {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: scopeRaw,
      state,
      resource,
    },
    client?.redirect_uris ?? null
  );
  if (validation.kind === "fatal") return bad(validation.description);
  if (validation.kind === "redirect") {
    return NextResponse.redirect(
      buildRedirect(redirectUri!, {
        error: validation.error,
        error_description: validation.description,
        state: state ?? undefined,
      }),
      { status: 303 }
    );
  }

  // Belt and braces — these were checked above, but the redirect target is
  // too important to take on trust from one code path.
  if (!client || !redirectUri || !redirectUriAllowed(client, redirectUri)) {
    return bad("This authorization request cannot proceed.");
  }
  if (!isValidCodeChallenge(codeChallenge)) return bad("Invalid PKCE challenge.");

  // Denial: hand access_denied back to the (validated) client.
  if (decision !== "approve") {
    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "share.revoked", // closest existing action: access was declined
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "oauth_client",
      resourceId: clientId ?? "",
      outcome: "denied",
      metadata: { clientName: client.client_name, event: "oauth_consent_denied" },
      ...requestAttribution(req),
    });
    return NextResponse.redirect(
      buildRedirect(redirectUri, { error: "access_denied", state: state ?? undefined }),
      { status: 303 }
    );
  }

  // Approval. The granted scope is the request narrowed to what the server
  // defines AND what the client was registered for — it can only shrink.
  const requested = parseScope(scopeRaw);
  const clientScopes = parseScope(client.scope);
  const granted = narrowScope(
    narrowScope(requested, [...OAUTH_SCOPES]),
    clientScopes.length ? clientScopes : [...OAUTH_SCOPES]
  );

  const code = await createAuthorizationCode(db, {
    clientId: client.client_id,
    userId: auth.userId,
    companyId: auth.companyId,
    redirectUri,
    scope: granted,
    codeChallenge: codeChallenge!,
    resource: resource ?? null,
  });

  await recordConsent(db, auth.userId, auth.companyId, client.client_id, granted);

  // A machine credential is being granted against this company's data; that is
  // exactly the kind of act the tamper-evident trail exists to record.
  await recordSecurityEvent({
    companyId: auth.companyId,
    action: "api_key.created",
    actorId: auth.userId,
    actorLabel: auth.email,
    resourceType: "oauth_client",
    resourceId: client.client_id,
    metadata: {
      clientName: client.client_name,
      scope: granted.join(" "),
      event: "oauth_consent_granted",
    },
    ...requestAttribution(req),
  });

  return NextResponse.redirect(
    buildRedirect(redirectUri, { code, state: state ?? undefined }),
    { status: 303 }
  );
}

function str(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === "string" && v.length ? v : null;
}

// A fatal error is shown as plain text, deliberately not redirected.
function bad(detail: string): NextResponse {
  return new NextResponse(
    `Authorization request rejected: ${detail}\n\nFor your safety, no redirect was performed.`,
    { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}
