// /oauth/authorize — the human consent step.
//
// An MCP client sends the operator's browser here. The page validates the
// request, makes sure a real user is logged in, and shows them exactly what
// the client is asking for before any code is minted. Nothing here is granted
// without a click.
//
// The one rule that governs the structure: a bad client_id or an unregistered
// redirect_uri is shown as an error page and NEVER redirected, because
// redirecting an unvalidated URI is how the authorization code reaches an
// attacker. Only once the redirect target is proven to be on the client's
// allowlist do other errors bounce back to it. That split lives in
// validateAuthorizeRequest(); this page acts on its verdict.

import { redirect } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { getClient } from "@/lib/oauth/store";
import {
  validateAuthorizeRequest,
  buildRedirect,
  SCOPE_LABELS,
  type RawAuthorizeParams,
} from "@/lib/oauth/authorize";
import { Logo } from "@/components/laygrounded/Logo";
import { ConsentForm } from "./consent-form";
import styles from "./Authorize.module.css";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Authorize access — LayGrounded",
  robots: { index: false, follow: false },
};

// The authorize URL a signed-out user is sent back to after login. Rebuilt
// from the validated params so it survives the round trip to /sign-in.
function selfUrl(p: RawAuthorizeParams): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) u.set(k, v);
  return `/oauth/authorize?${u.toString()}`;
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string): string | null => {
    const v = sp[k];
    return typeof v === "string" ? v : null;
  };
  const params: RawAuthorizeParams = {
    response_type: one("response_type"),
    client_id: one("client_id"),
    redirect_uri: one("redirect_uri"),
    code_challenge: one("code_challenge"),
    code_challenge_method: one("code_challenge_method"),
    scope: one("scope"),
    state: one("state"),
    resource: one("resource"),
  };

  const db = createServiceRoleClient();
  const client = params.client_id ? await getClient(db, params.client_id) : null;
  const validation = validateAuthorizeRequest(params, client?.redirect_uris ?? null);

  // Fatal — render, never redirect.
  if (validation.kind === "fatal") {
    return (
      <ErrorScreen title="This authorization request cannot proceed" detail={validation.description} />
    );
  }

  // Redirectable — the target is now trusted, so hand the error back to it.
  if (validation.kind === "redirect") {
    redirect(
      buildRedirect(params.redirect_uri!, {
        error: validation.error,
        error_description: validation.description,
        state: validation.state ?? undefined,
      })
    );
  }

  const request = validation.request;

  // A real user must be at the keyboard. If not, send them to sign in and
  // straight back here — the whole point is that the token acts as a person.
  let auth: Awaited<ReturnType<typeof requireAuth>> | null = null;
  try {
    auth = await requireAuth();
  } catch {
    redirect(`/sign-in?next=${encodeURIComponent(selfUrl(params))}`);
  }

  const scopeRows = request.scope.length
    ? request.scope.map((s) => ({ scope: s, label: SCOPE_LABELS[s] ?? s }))
    : [{ scope: "", label: "Basic connection only — no data access is being requested." }];

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logoRow}>
          <Logo variant="auth" />
        </div>

        <h1 className={styles.title}>Authorize access</h1>
        <p className={styles.lead}>
          <strong>{client!.client_name || "An application"}</strong> wants to connect to LayGrounded
          and act as you within <strong>{auth!.companyName || "your company"}</strong>.
        </p>

        <div className={styles.scopeBox}>
          <div className={styles.scopeHead}>It is requesting permission to:</div>
          <ul className={styles.scopeList}>
            {scopeRows.map((r) => (
              <li key={r.scope || "none"}>{r.label}</li>
            ))}
          </ul>
        </div>

        <p className={styles.account}>
          Signed in as <strong>{auth!.email}</strong>. The connection can be revoked at any time in
          Settings → Security Trail.
        </p>

        <ConsentForm
          clientId={request.clientId}
          redirectUri={request.redirectUri}
          codeChallenge={request.codeChallenge}
          scope={request.scope.join(" ")}
          state={request.state}
          resource={request.resource}
          clientName={client!.client_name || "the application"}
        />
      </div>
    </main>
  );
}

function ErrorScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logoRow}>
          <Logo variant="auth" />
        </div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.lead}>{detail}</p>
        <p className={styles.account}>
          For your safety, LayGrounded did not redirect anywhere. Close this window and try
          connecting again from the application.
        </p>
      </div>
    </main>
  );
}
