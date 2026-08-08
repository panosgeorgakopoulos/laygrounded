// Zero-to-tenant: the step between having an account and having a workspace.
//
// WHAT THIS REPLACES. Sign-up used to call `/api/bootstrap` itself, which
// created a company named from a field on the sign-up form, or — when that
// field was empty or the call failed — from the local part of the email
// address, producing tenants called "j.smith's Fleet". Worse, it ran for
// EVERYONE, including people who had just been invited to an existing company.
// They were bootstrapped into a company of their own, and the single-company
// rule then permanently refused the invitation they were holding. That is the
// orphaned-company bug, and it was created by the signup path, not by the seed
// script that made it visible.
//
// So the decision moves here, after authentication, where both facts are
// known: who the user is, and whether anybody has invited them.
//
// OUTSIDE `(authenticated)`, like `/invite/accept` and for the same reason —
// that layout renders the app chrome (nav, notification bell), all of which
// queries a tenant this user does not have yet. Every one of those requests
// would 401 behind a shell that implies the product is already working.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { pendingInvitationsForEmail } from "@/lib/auth/invitations-server";
import { Logo } from "@/components/laygrounded/Logo";
import { OnboardingChoice } from "./onboarding-choice";
import styles from "./Onboarding.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Set up your workspace — LayGrounded",
  robots: { index: false, follow: false },
};

export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No session: this page is meaningless. `next` is carried so an invited user
  // who lands here without a session returns after signing in.
  if (!user?.email) {
    redirect("/sign-in?next=%2Fonboarding");
  }

  // Already has a tenant — they finished this, or were invited and accepted.
  // Reached routinely, because the authenticated layout sends every tenantless
  // user here and a browser tab left open across an acceptance in another tab
  // will land on it.
  const { data: membership } = await supabase
    .from("company_members")
    .select("company_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (membership) {
    redirect("/claims");
  }

  // Invitations waiting for THIS address. Service-role, because the person
  // reading has no membership and so passes no RLS policy on the invitations
  // table — and the address is taken from their verified session, never from a
  // query parameter, so it can only ever return their own.
  const admin = createServiceRoleClient();
  const invitations = await pendingInvitationsForEmail(admin, user.email);

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <Logo variant="auth" />
        </div>

        <h1 className={styles.title}>
          {invitations.length > 0 ? "You have been invited" : "Set up your workspace"}
        </h1>
        <p className={styles.subtitle}>
          {invitations.length > 0
            ? `Signed in as ${user.email}. Join a team that has invited you, or start a company of your own.`
            : `Signed in as ${user.email}. A workspace holds your fleet's claims, your colleagues and your charterparty settings.`}
        </p>

        <OnboardingChoice
          invitations={invitations.map((inv) => ({
            id: inv.id,
            companyName: inv.companyName,
            role: inv.role,
            expiresAt: inv.expiresAt,
          }))}
          suggestedName={suggestCompanyName(user.email)}
        />
      </div>
    </main>
  );
}

/**
 * A starting point for the company name field, never a silent default.
 *
 * The old bootstrap used `${localpart}'s Fleet` as the actual name whenever the
 * form did not supply one, which is how tenants ended up called "demo2's
 * Fleet". Here it only prefills an input the user can see and overwrite before
 * committing — the difference between a suggestion and a decision made on
 * somebody's behalf.
 *
 * A free-mail address gets no suggestion at all: "gmail" is not a fleet, and a
 * plausible-looking wrong default is worse than an empty field, because it is
 * the one people accept without reading.
 */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "mail.com",
  "yandex.com",
  "zoho.com",
]);

function suggestCompanyName(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain || FREE_MAIL.has(domain)) return "";

  const label = domain.split(".")[0];
  if (!label || label.length < 2) return "";

  // "meridian-bulk" → "Meridian Bulk". Title-cased on separators only; no
  // attempt to expand abbreviations, which would produce confident nonsense.
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
