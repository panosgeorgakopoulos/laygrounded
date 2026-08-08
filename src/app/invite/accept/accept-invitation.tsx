"use client";

// The Accept button.
//
// A client component rather than a server action + redirect, because every
// refusal this can hit is one a real person needs to READ: "you already belong
// to another company" and "this invitation was withdrawn while you were looking
// at it" are different problems with different fixes, and a redirect on failure
// loses both. The page has already resolved the happy path server-side; this
// handles the moment of commitment and whatever comes back.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import styles from "./Invite.module.css";

/**
 * Server sentinels turned into something actionable.
 *
 * These are the SAME conditions the page checked before rendering, re-checked
 * on the POST — an invitation can be revoked, or the user can join another
 * company in a second tab, between the page load and the click. The server is
 * the authority; this map only decides what the person is told.
 */
const ERROR_COPY: Record<string, string> = {
  UNAUTHORIZED: "Your session has expired. Sign in again and reopen this link.",
  INVITATION_NOT_FOUND: "This invitation could not be found. Ask for a fresh link.",
  INVITATION_EXPIRED: "This invitation expired. Ask an admin to send you a new one.",
  INVITATION_REVOKED: "This invitation was withdrawn while this page was open.",
  INVITATION_ALREADY_ACCEPTED: "This invitation has already been used. Try signing in.",
  INVITATION_EMAIL_MISMATCH:
    "This invitation is for a different email address than the one you are signed in with.",
  ALREADY_MEMBER: "You are already a member of this company.",
  USER_ALREADY_IN_ANOTHER_COMPANY:
    "Your account already belongs to another company, and an account can only be in one. Ask an admin there to remove you first.",
  REDEMPTION_FAILED: "Something went wrong joining the company. Try again in a moment.",
  VALIDATION_ERROR: "This invitation link is malformed. Copy it again from the email.",
};

export function AcceptInvitation({
  token,
  companyName,
}: {
  token: string;
  companyName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // ALREADY_MEMBER is a success from the user's point of view: they are
        // in, they just clicked twice. Treating it as an error would tell
        // somebody who belongs here that something went wrong.
        if (body?.error === "ALREADY_MEMBER") {
          setDone(true);
          router.push("/claims");
          return;
        }
        setError(ERROR_COPY[body?.error] ?? "The invitation could not be accepted.");
        return;
      }

      setDone(true);
      // `refresh()` before navigating: the membership this request just created
      // is what every server component downstream reads to resolve the tenant,
      // and a cached tenantless render would send the new member straight back
      // to onboarding.
      router.refresh();
      router.push("/claims");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className={styles.successState} role="status">
        <Check size={18} />
        <span>Welcome to {companyName}. Taking you to the workspace…</span>
      </div>
    );
  }

  return (
    <div className={styles.actions}>
      <button
        type="button"
        onClick={accept}
        disabled={busy}
        className={styles.primaryAction}
      >
        {busy ? (
          <>
            <Loader2 size={16} className={styles.spin} /> Joining…
          </>
        ) : (
          <>Accept invitation</>
        )}
      </button>

      {error && (
        <div className={styles.error} role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
