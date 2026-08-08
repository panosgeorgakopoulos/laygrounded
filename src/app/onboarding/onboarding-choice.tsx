"use client";

// The onboarding decision: join somebody, or start something.
//
// WHY BOTH OPTIONS ARE ON ONE SCREEN. The two are not sequential steps and
// there is no reliable way to guess which one a person wants — an invitation
// waiting for their address is strong evidence, but somebody genuinely
// registering a second company from a work address that was also invited to a
// broker's tenant is a real case. Presenting the invitation first and keeping
// "create your own" reachable below means the likely answer is one click and
// the other answer is still possible.
//
// The dangerous design here would be auto-accepting a pending invitation on
// page load: joining a company is consequential, it is visible to that
// company's admins, and it consumes the account's one allowed membership.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, Building2, Loader2, Users } from "lucide-react";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "@/lib/auth/roles";
import styles from "./Onboarding.module.css";

interface PendingInvitation {
  id: string;
  companyName: string;
  role: Role;
  expiresAt: string;
}

const ERROR_COPY: Record<string, string> = {
  UNAUTHORIZED: "Your session expired. Sign in again to continue.",
  INVITATION_NOT_FOUND: "That invitation is no longer available.",
  INVITATION_EXPIRED: "That invitation has expired. Ask an admin to send a new one.",
  INVITATION_REVOKED: "That invitation was withdrawn.",
  INVITATION_ALREADY_ACCEPTED: "That invitation has already been used.",
  INVITATION_EMAIL_MISMATCH: "That invitation is for a different email address.",
  USER_ALREADY_IN_ANOTHER_COMPANY: "Your account already belongs to another company.",
  ALREADY_MEMBER: "You are already a member of that company.",
  // The one refusal specific to this screen: accepting here presents no token,
  // so the address itself has to be proven. The emailed link is the way through.
  EMAIL_NOT_VERIFIED:
    "Confirm your email address first — check your inbox for the confirmation message, or open the invitation link that was emailed to you.",
  REDEMPTION_FAILED: "Something went wrong joining that company. Try again in a moment.",
  BOOTSTRAP_FAILED: "Your workspace could not be created. Try again in a moment.",
  VALIDATION_ERROR: "Check the company name and try again.",
  COMPANY_NAME_REQUIRED: "Give your workspace a name so your colleagues recognise it.",
  // The server's guard against the orphaned-company bug: an account can only be
  // in one company, so creating one would consume the membership the pending
  // invitation needs. Only reachable from a stale tab — the UI puts the
  // invitation first — which is exactly why the server checks too.
  INVITATION_OUTSTANDING:
    "You have an invitation waiting. Accept it above, or reload this page if you do not see it — an account can only belong to one company.",
};

function readable(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  return ERROR_COPY[code] ?? fallback;
}

export function OnboardingChoice({
  invitations,
  suggestedName,
}: {
  invitations: PendingInvitation[];
  suggestedName: string;
}) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState(suggestedName);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function acceptInvitation(invitation: PendingInvitation) {
    setBusy(invitation.id);
    setError(null);
    try {
      const res = await fetch("/api/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // By id, not by token — there is no token on this screen. The server
        // requires a confirmed email address for this path; see RedemptionProof.
        body: JSON.stringify({ invitationId: invitation.id }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok && body?.error !== "ALREADY_MEMBER") {
        setError(readable(body?.error, "The invitation could not be accepted."));
        return;
      }

      // `refresh()` first: every server component downstream resolves the
      // tenant from the membership this call just created, and a cached
      // tenantless render would bounce the new member straight back here.
      router.refresh();
      router.push("/claims");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function createWorkspace(e: React.FormEvent) {
    e.preventDefault();
    const name = companyName.trim();
    if (!name) {
      setError(ERROR_COPY.COMPANY_NAME_REQUIRED);
      return;
    }

    setBusy("create");
    setError(null);
    try {
      const res = await fetch("/api/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: name }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(readable(body?.error, "Your workspace could not be created."));
        return;
      }

      router.refresh();
      router.push("/claims");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.stack}>
      {invitations.length > 0 && (
        <section className={styles.section} aria-label="Invitations waiting for you">
          <div className={styles.sectionHeader}>
            <Users size={16} />
            <h2 className={styles.sectionTitle}>Join a team</h2>
          </div>

          <ul className={styles.inviteList}>
            {invitations.map((invitation) => (
              <li key={invitation.id} className={styles.inviteItem}>
                <div className={styles.inviteText}>
                  <span className={styles.inviteCompany}>{invitation.companyName}</span>
                  <span className={styles.inviteRole}>
                    as {ROLE_LABELS[invitation.role]} — {ROLE_DESCRIPTIONS[invitation.role]}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.joinButton}
                  disabled={busy !== null}
                  onClick={() => acceptInvitation(invitation)}
                >
                  {busy === invitation.id ? (
                    <>
                      <Loader2 size={15} className={styles.spin} /> Joining…
                    </>
                  ) : (
                    <>
                      Join <ArrowRight size={15} />
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>

          <div className={styles.divider}>
            <span>or</span>
          </div>
        </section>
      )}

      <section className={styles.section} aria-label="Create a new workspace">
        <div className={styles.sectionHeader}>
          <Building2 size={16} />
          <h2 className={styles.sectionTitle}>
            {invitations.length > 0 ? "Start your own company" : "Name your company"}
          </h2>
        </div>

        <form onSubmit={createWorkspace} className={styles.form}>
          <label className={styles.label} htmlFor="company-name">
            Company / fleet name
          </label>
          <input
            id="company-name"
            className={styles.input}
            type="text"
            required
            autoFocus={invitations.length === 0}
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Meridian Bulk Carriers"
            disabled={busy !== null}
          />
          <p className={styles.hint}>
            You will be its first admin, and can invite colleagues straight away. This is the name
            your team sees — it can be changed later in Settings.
          </p>

          <button
            type="submit"
            className={styles.createButton}
            disabled={busy !== null || !companyName.trim()}
          >
            {busy === "create" ? (
              <>
                <Loader2 size={16} className={styles.spin} /> Creating workspace…
              </>
            ) : (
              <>
                Create workspace <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>
      </section>

      {error && (
        <div className={styles.error} role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
