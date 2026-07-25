"use client";

// The Approve / Deny control. A plain HTML form that POSTs the validated
// request back to /oauth/authorize/decision.
//
// It carries the request parameters as hidden fields, but the decision handler
// does NOT trust them for anything security-relevant: it re-fetches the client
// and re-checks the redirect_uri against the DB allowlist, and mints a code
// only for the logged-in user's own session. The hidden fields are a
// convenience for reconstructing the request, not an authority.
//
// CSRF: the handler requires the Supabase session cookie, which is SameSite,
// so a cross-site auto-submit of this form arrives without a session and is
// refused. Approval cannot be forged from another origin.

import { useState } from "react";
import styles from "./Authorize.module.css";

export function ConsentForm(props: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state: string | null;
  resource: string | null;
  clientName: string;
}) {
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);

  return (
    <form method="POST" action="/oauth/authorize/decision" className={styles.form}>
      <input type="hidden" name="client_id" value={props.clientId} />
      <input type="hidden" name="redirect_uri" value={props.redirectUri} />
      <input type="hidden" name="code_challenge" value={props.codeChallenge} />
      <input type="hidden" name="scope" value={props.scope} />
      {props.state != null && <input type="hidden" name="state" value={props.state} />}
      {props.resource != null && <input type="hidden" name="resource" value={props.resource} />}

      <div className={styles.actions}>
        <button
          type="submit"
          name="decision"
          value="deny"
          className={styles.deny}
          disabled={submitting !== null}
          onClick={() => setSubmitting("deny")}
        >
          {submitting === "deny" ? "Cancelling…" : "Cancel"}
        </button>
        <button
          type="submit"
          name="decision"
          value="approve"
          className={styles.approve}
          disabled={submitting !== null}
          onClick={() => setSubmitting("approve")}
        >
          {submitting === "approve" ? "Authorizing…" : `Authorize ${props.clientName}`}
        </button>
      </div>
    </form>
  );
}
