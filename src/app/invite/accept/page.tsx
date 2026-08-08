// Accepting an invitation.
//
// OUTSIDE THE `(authenticated)` GROUP, deliberately, and for the same reason
// `/rooms/[token]` is: the person arriving here may have no session at all, and
// certainly has no tenant. The authenticated layout would bounce them to
// /sign-in with no memory of the token, which is the exact dead end this page
// exists to remove.
//
// The token is resolved SERVER-SIDE before anything renders, so the page can
// say "join Meridian Bulk Carriers as an Operator" rather than showing a bare
// Accept button for an unnamed company. An invitation asks somebody to trust an
// organisation with their account; naming it is the minimum.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT DO: it does not accept on load. A GET
// that mutates would let a link preview bot in a mail client — which fetches
// every URL it sees — redeem the invitation before the human ever clicked it,
// and the person would then find a dead token. Acceptance is a POST behind a
// button.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, MailWarning, ShieldCheck } from "lucide-react";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { invitationState, sameEmail } from "@/lib/auth/invitations";
import { findInvitationByToken, invitationCompanyName } from "@/lib/auth/invitations-server";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/auth/roles";
import { Logo } from "@/components/laygrounded/Logo";
import { AcceptInvitation } from "./accept-invitation";
import styles from "./Invite.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Accept your invitation — LayGrounded",
  // An invitation link is a credential. It must never be indexed, and it must
  // not leak into the referrer of whatever the user clicks next.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <Logo variant="auth" />
        </div>
        {children}
      </div>
    </main>
  );
}

/** A dead end, phrased so the reader knows what to do next rather than just that it failed. */
function Refusal({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <Shell>
      <div className={styles.icon} aria-hidden="true">
        <MailWarning size={28} />
      </div>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.body}>{body}</p>
      {action ?? (
        <Link href="/sign-in" className={styles.secondaryAction}>
          Go to sign in
        </Link>
      )}
    </Shell>
  );
}

export default async function AcceptInvitePage({
  searchParams,
}: {
  // Next.js 16: searchParams is a Promise.
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <Refusal
        title="This invitation link is incomplete"
        body="The link is missing its invitation token. Copy it again from the email, making sure you take the whole thing — mail clients sometimes wrap long links across two lines."
      />
    );
  }

  // Service-role, because there is no session to scope this by: an invitation
  // must be readable by the person who has not joined yet. The token IS the
  // authorisation, and it is checked by hash — an unguessable 256-bit value.
  const admin = createServiceRoleClient();
  const invitation = await findInvitationByToken(admin, token);

  if (!invitation) {
    return (
      <Refusal
        title="This invitation could not be found"
        body="The link may have been mistyped or truncated. Ask whoever invited you to send a fresh one — invitations can be re-issued from Settings → Team."
      />
    );
  }

  const state = invitationState(invitation);
  const companyName = (await invitationCompanyName(admin, invitation.companyId)) ?? "this company";

  if (state === "expired") {
    return (
      <Refusal
        title="This invitation has expired"
        body={`Invitations to ${companyName} are valid for seven days. Ask an admin there to send you a new one — nothing is lost, it just needs re-issuing.`}
      />
    );
  }

  if (state === "revoked") {
    return (
      <Refusal
        title="This invitation was withdrawn"
        body={`The invitation to join ${companyName} was cancelled by an administrator. If you think that was a mistake, contact them directly — it cannot be reinstated from this page.`}
      />
    );
  }

  if (state === "accepted") {
    return (
      <Refusal
        title="This invitation has already been used"
        body={`It looks like you have already joined ${companyName}. Sign in and you should find your workspace waiting.`}
      />
    );
  }

  // ── The invitation is live. Who is holding it? ────────────────────────────

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // NOT SIGNED IN. The token is carried through sign-in/sign-up so the user
  // comes back here afterwards. Without this hand-off the invited person signs
  // up, gets bootstrapped into a company of their own, and can then never
  // accept — the single-company rule refuses them. That was the actual bug.
  if (!user) {
    const next = `/invite/accept?token=${encodeURIComponent(token)}`;
    return (
      <Shell>
        <div className={styles.icon} aria-hidden="true">
          <ShieldCheck size={28} />
        </div>
        <h1 className={styles.title}>
          You have been invited to join <span className={styles.company}>{companyName}</span>
        </h1>
        <p className={styles.body}>
          The invitation was sent to <strong>{invitation.email}</strong>. Sign in with that address
          — or create an account for it — and you will be taken straight back here.
        </p>
        <div className={styles.roleCard}>
          <span className={styles.roleLabel}>Your role will be</span>
          <span className={styles.roleName}>{ROLE_LABELS[invitation.role]}</span>
          <span className={styles.roleDescription}>{ROLE_DESCRIPTIONS[invitation.role]}</span>
        </div>
        <div className={styles.actions}>
          <Link
            href={`/sign-up?next=${encodeURIComponent(next)}&email=${encodeURIComponent(invitation.email)}`}
            className={styles.primaryAction}
          >
            Create an account <ArrowRight size={16} />
          </Link>
          <Link href={`/sign-in?next=${encodeURIComponent(next)}`} className={styles.secondaryAction}>
            I already have an account
          </Link>
        </div>
      </Shell>
    );
  }

  // SIGNED IN AS SOMEBODY ELSE. Named explicitly, because the alternative —
  // a generic "you cannot accept this" — sends a person hunting for a broken
  // link when the fix is to switch accounts. Very common in practice: invited
  // at a work address, already signed in on a personal one.
  if (!sameEmail(invitation.email, user.email)) {
    return (
      <Refusal
        title="This invitation is for a different account"
        body={`The invitation was sent to ${invitation.email}, but you are signed in as ${user.email}. Sign out and sign back in with the invited address to accept it.`}
        action={
          <Link href="/sign-in" className={styles.secondaryAction}>
            Switch account
          </Link>
        }
      />
    );
  }

  // ALREADY IN THIS COMPANY — a second click, or a link opened twice. Not an
  // error worth alarming anyone about; just send them to the product.
  const { data: membership } = await supabase
    .from("company_members")
    .select("company_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (membership?.company_id === invitation.companyId) {
    redirect("/claims");
  }

  return (
    <Shell>
      <div className={styles.icon} aria-hidden="true">
        <ShieldCheck size={28} />
      </div>
      <h1 className={styles.title}>
        Join <span className={styles.company}>{companyName}</span>
      </h1>
      <p className={styles.body}>
        Signed in as <strong>{user.email}</strong>. Accepting adds you to this company&apos;s
        workspace and gives you access to its claims.
      </p>
      <div className={styles.roleCard}>
        <span className={styles.roleLabel}>Your role will be</span>
        <span className={styles.roleName}>{ROLE_LABELS[invitation.role]}</span>
        <span className={styles.roleDescription}>{ROLE_DESCRIPTIONS[invitation.role]}</span>
      </div>

      {/* The mutation is a client component so the refusal states — which are
          re-checked server-side on the POST — can be shown without losing the
          page. A form action that redirected would drop the reason. */}
      <AcceptInvitation token={token} companyName={companyName} />

      {membership?.company_id && membership.company_id !== invitation.companyId && (
        <p className={styles.warning}>
          You already belong to another company. An account can only be in one, so this invitation
          cannot be accepted until you are removed from the other.
        </p>
      )}
    </Shell>
  );
}
