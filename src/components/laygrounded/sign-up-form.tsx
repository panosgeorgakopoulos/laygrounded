"use client";

// Sign-up: create the ACCOUNT, and nothing else.
//
// WHAT THIS DELIBERATELY NO LONGER DOES. It used to collect a company name and
// call `/api/bootstrap` itself, immediately after `signUp()`. That produced two
// distinct failures:
//
//   * an invited colleague who signed up through this form was bootstrapped
//     into a brand-new company of their own, and the single-company rule then
//     permanently refused the invitation they were holding. The orphaned
//     company was created HERE, not by the seed script that made it visible;
//   * when email confirmation is enabled there is no session yet, so the
//     bootstrap call 401'd and the form had to show a paragraph explaining that
//     the account existed but the workspace did not.
//
// Tenancy is now decided at `/onboarding`, after authentication, where the
// answer to "has anybody invited you" is actually knowable. This form's only
// job is the credential.

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "@/app/Auth.module.css";

/**
 * Same rule as the sign-in form: a single leading slash, so `next` cannot
 * bounce a freshly-created account off to another origin. This form is reached
 * from the invitation page with `next=/invite/accept?token=…`, which is exactly
 * the kind of link somebody would try to forge.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/onboarding";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/onboarding";
  return raw;
}

export function SignUpForm() {
  const searchParams = useSearchParams();
  // Prefilled when arriving from an invitation: the invitation is bound to a
  // specific address, and letting somebody type a different one here produces
  // an account that cannot accept the invitation that sent them.
  const invitedEmail = searchParams.get("email") ?? "";

  const [email, setEmail] = useState(invitedEmail);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const next = safeNext(searchParams.get("next"));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name, display_name: name },
        // Where Supabase sends them after confirming, when confirmation is on.
        // Carries the invitation through a round trip via the mail client,
        // which is the one place a `next` parameter would otherwise be lost.
        emailRedirectTo:
          typeof window !== "undefined" ? `${window.location.origin}${next}` : undefined,
      },
    });

    if (signUpError) {
      setLoading(false);
      setError(signUpError.message || "Could not create account.");
      return;
    }

    // No session means confirmation is required. Said plainly, rather than
    // reported as a half-failure: the account exists and nothing is wrong.
    if (!data.session) {
      setLoading(false);
      setConfirmationRequired(true);
      return;
    }

    setLoading(false);
    router.push(next);
    router.refresh();
  }

  if (confirmationRequired) {
    return (
      <div className={styles.form} role="status">
        <p className={styles.subtitle}>
          Check <strong>{email}</strong> for a confirmation link. Once you have confirmed, you will
          be brought back to finish setting up your workspace.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className={styles.form}>
      <div className={styles.inputGroup}>
        <label className={styles.label} htmlFor="signup-name">
          Your name
        </label>
        <input
          id="signup-name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={styles.input}
        />
      </div>
      <div className={styles.inputGroup}>
        <label className={styles.label} htmlFor="signup-email">
          Email
        </label>
        <input
          id="signup-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={styles.input}
          // Read-only rather than disabled when invited: a disabled input is not
          // submitted and is skipped by some screen readers, and the value here
          // is load-bearing — it is the address the invitation is bound to.
          readOnly={Boolean(invitedEmail)}
        />
        {invitedEmail && (
          <p className={styles.subtitle} style={{ marginTop: "0.375rem", marginBottom: 0 }}>
            Your invitation was sent to this address.
          </p>
        )}
      </div>
      <div className={styles.inputGroup}>
        <label className={styles.label} htmlFor="signup-password">
          Password
        </label>
        <input
          id="signup-password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={styles.input}
        />
      </div>
      {error && <div className={styles.errorText}>{error}</div>}
      <button type="submit" disabled={loading} className={styles.submitButton}>
        {loading ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
