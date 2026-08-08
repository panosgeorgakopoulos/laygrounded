"use client";

// Team management: the UI for the RBAC model in src/lib/auth/roles.ts.
//
// The role picker and the capability legend are both generated FROM that
// module rather than restated here. A hand-written list of roles would drift
// from the one the API enforces, and the failure is silent in the direction
// that matters — an admin grants "Finance manager" from a stale dropdown and
// the server refuses a capability the label promised.

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, Loader2, MailX, Trash2, UserPlus } from "lucide-react";
import { format, parseISO } from "date-fns";
import { Button } from "@/components/core/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/core/Card";
import { Input } from "@/components/core/Input";
import {
  CAPABILITY_MIN_ROLE,
  ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  can,
  type Capability,
  type Role,
} from "@/lib/auth/roles";
import styles from "./TeamManagement.module.css";

interface Member {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
  joinedAt: string | null;
  neverSignedIn: boolean;
}

/** An offer, not a person. Kept in its own list for exactly that reason. */
interface Invitation {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

interface TeamPayload {
  members: Member[];
  invitations: Invitation[];
  selfId: string;
  selfRole: Role;
}

/**
 * The result of a successful invite, held so the accept link can be shown.
 *
 * The token is stored only as a hash, so this is the ONE moment it can be
 * surfaced — reloading the page will not bring it back. Same contract as a
 * finance grant token, and worth showing rather than hiding: Supabase cannot
 * email an address that already has an account, so for those invitees this
 * link is the only way they will ever hear about it.
 */
interface IssuedInvite {
  email: string;
  role: Role;
  acceptUrl: string;
  emailed: boolean;
}

/** Server sentinels turned into something a person can act on. */
const ERROR_COPY: Record<string, string> = {
  ALREADY_MEMBER: "That person is already in your team.",
  USER_ALREADY_IN_ANOTHER_COMPANY:
    "That account already belongs to another company. A user can only be in one.",
  CANNOT_REMOVE_SELF: "You cannot remove yourself from the team.",
  LAST_ADMIN:
    "This is your last admin. Promote somebody else to admin first — otherwise nobody could manage the team.",
  MEMBER_NOT_FOUND: "That person is no longer in your team. Refresh to see the current list.",
  FORBIDDEN: "Only an admin can change the team.",
  USER_LOOKUP_FAILED: "Could not check that email address just now. Try again in a moment.",
  FAILED_TO_INVITE: "The invitation could not be sent.",
  FAILED_TO_CHANGE_ROLE: "The role could not be changed.",
  FAILED_TO_REMOVE: "That person could not be removed.",
  VALIDATION_ERROR: "Check the email address and try again.",
  INVITATION_ALREADY_OUTSTANDING:
    "That person already has an invitation waiting. Withdraw it first if you want to change their role.",
  INVITATION_NOT_FOUND: "That invitation is no longer outstanding. Refresh to see the current list.",
};

function readableError(code: string | undefined): string {
  if (!code) return "Something went wrong.";
  return ERROR_COPY[code] ?? code;
}

/** The capability grid, derived so a new capability appears without an edit here. */
const CAPABILITY_LABELS: Record<Capability, string> = {
  "claim.read": "View claims and calculations",
  "claim.write": "Create claims, ingest SoFs, confirm events, dispute",
  "claim.negotiate": "Set the negotiation mandate",
  "claim.agree": "Agree a claim (fix the figures)",
  "claim.settle": "Generate and clear settlement",
  "finance.grant": "Issue and revoke bank access",
  "finance.counterparty": "Edit bank and wallet details",
  "team.manage": "Invite colleagues and change roles",
};

const ALL_CAPABILITIES = Object.keys(CAPABILITY_MIN_ROLE) as Capability[];

export function TeamManagement() {
  const [data, setData] = useState<TeamPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("operator");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/members");
      const body = await res.json();
      if (!res.ok) throw new Error(readableError(body?.error));
      setData(body as TeamPayload);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the team.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isAdmin = data ? can(data.selfRole, "team.manage") : false;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setError(null);
    setSuccess(null);
    setIssued(null);
    setCopied(false);
    try {
      const res = await fetch("/api/settings/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(readableError(body?.error));

      // Held in state rather than announced and forgotten: the accept link is
      // shown exactly once, because only its hash is stored.
      setIssued({
        email: inviteEmail,
        role: inviteRole,
        acceptUrl: body.acceptUrl,
        emailed: Boolean(body.emailed),
      });
      setInviteEmail("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the invitation.");
    } finally {
      setInviting(false);
    }
  }

  async function withdraw(invitation: Invitation) {
    if (
      !window.confirm(
        `Withdraw the invitation to ${invitation.email}?\n\nTheir link stops working immediately. You can invite them again afterwards.`
      )
    ) {
      return;
    }
    setBusyId(invitation.id);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/settings/members", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId: invitation.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(readableError(body?.error));
      setSuccess(`The invitation to ${invitation.email} was withdrawn.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not withdraw that invitation.");
    } finally {
      setBusyId(null);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure origin, permissions). The
      // link is on screen and selectable either way, so this is not an error
      // worth interrupting anyone over — it just does not get to say "Copied".
      setCopied(false);
    }
  }

  async function changeRole(member: Member, role: Role) {
    setBusyId(member.id);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/settings/members", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: member.id, role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(readableError(body?.error));
      setSuccess(`${member.email} is now ${ROLE_LABELS[role]}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the role.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(member: Member) {
    // Native confirm, matching the other destructive actions in this app. The
    // consequence is named: removal is not a downgrade.
    if (
      !window.confirm(
        `Remove ${member.email} from ${"your team"}?\n\nThey lose access to every claim in this company immediately. This does not delete their account.`
      )
    ) {
      return;
    }
    setBusyId(member.id);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/settings/members", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: member.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(readableError(body?.error));
      setSuccess(`${member.email} was removed.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove that person.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className={styles.loading}>
        <Loader2 size={16} className={styles.spin} /> Loading the team…
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className={`${styles.alert} ${styles.alertError}`} role="alert">
        <AlertCircle size={16} />
        <p>{loadError ?? "Could not load the team."}</p>
      </div>
    );
  }

  const members = data.members;

  return (
    <div className={styles.stack}>
      {!isAdmin && (
        <div className={styles.alert} role="status">
          <AlertCircle size={16} />
          <p>
            You are signed in as <strong>{ROLE_LABELS[data.selfRole]}</strong>. You can see who is
            in the team; only an admin can invite people or change roles.
          </p>
        </div>
      )}

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Invite a colleague</CardTitle>
            <CardDescription>
              They receive an email invitation and join with the role you pick. You can change it
              afterwards.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={invite} className={styles.inviteForm}>
              <div className={styles.inviteEmail}>
                <Input
                  label="Email address"
                  type="email"
                  placeholder="captain@fleet.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  disabled={inviting}
                  required
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="invite-role">
                  Role
                </label>
                <select
                  id="invite-role"
                  className={styles.select}
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Role)}
                  disabled={inviting}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" disabled={inviting || !inviteEmail} isLoading={inviting}>
                <UserPlus size={15} /> Send invite
              </Button>
            </form>
            <p className={styles.roleHint}>{ROLE_DESCRIPTIONS[inviteRole]}</p>

            {issued && (
              <div className={styles.issued} role="status">
                <div className={styles.issuedHead}>
                  <CheckCircle2 size={16} />
                  <span>
                    {issued.email} has been invited as {ROLE_LABELS[issued.role]}.
                  </span>
                </div>
                <p className={styles.issuedNote}>
                  {issued.emailed
                    ? "An invitation email is on its way. If it does not arrive, send them this link — it is shown once and cannot be retrieved later."
                    : "This address already has an account, so no invitation email could be sent. Send them this link — it is shown once and cannot be retrieved later."}
                </p>
                <div className={styles.issuedLinkRow}>
                  <code className={styles.issuedLink}>{issued.acceptUrl}</code>
                  <button
                    type="button"
                    className={styles.copyButton}
                    onClick={() => copyLink(issued.acceptUrl)}
                  >
                    <Copy size={14} /> {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {error && (
        <div className={`${styles.alert} ${styles.alertError}`} role="alert">
          <AlertCircle size={16} />
          <p>{error}</p>
        </div>
      )}
      {success && (
        <div className={`${styles.alert} ${styles.alertSuccess}`} role="status">
          <CheckCircle2 size={16} />
          <p>{success}</p>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Team ({members.length})</CardTitle>
          <CardDescription>
            {isAdmin
              ? "Change a role from the dropdown. It takes effect on their next request."
              : "Everyone with access to this company's claims."}
          </CardDescription>
        </CardHeader>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col" className={styles.right}>
                  Joined
                </th>
                {isAdmin && <th scope="col" className={styles.actionCol}></th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.id === data.selfId;
                return (
                  <tr key={m.id}>
                    <td>
                      <div className={styles.person}>
                        <span className={styles.name}>
                          {m.displayName || m.email.split("@")[0]}
                          {isSelf && <span className={styles.you}>you</span>}
                          {m.neverSignedIn && (
                            <span className={styles.pending} title="Has an account but has never signed in">
                              never signed in
                            </span>
                          )}
                        </span>
                        <span className={styles.email}>{m.email}</span>
                      </div>
                    </td>
                    <td>
                      {isAdmin ? (
                        <select
                          className={styles.select}
                          value={m.role}
                          disabled={busyId === m.id}
                          aria-label={`Role for ${m.email}`}
                          onChange={(e) => changeRole(m, e.target.value as Role)}
                        >
                          {ROLES.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={styles.badge}>{ROLE_LABELS[m.role]}</span>
                      )}
                    </td>
                    <td className={`${styles.right} tnum`}>
                      {m.joinedAt ? format(parseISO(m.joinedAt), "dd MMM yyyy") : "—"}
                    </td>
                    {isAdmin && (
                      <td className={styles.right}>
                        {!isSelf && (
                          <button
                            type="button"
                            className={styles.remove}
                            onClick={() => remove(m)}
                            disabled={busyId === m.id}
                            title={`Remove ${m.email}`}
                            aria-label={`Remove ${m.email}`}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {members.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 4 : 3} className={styles.empty}>
                    Nobody here yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Invitations, in their own card rather than as greyed-out rows in the
          team table. An offer is not a colleague: it has no role to change, no
          claims to open and nobody to hold it. The previous design listed them
          together and had to invent a `pending` flag from the invitee's
          account, which reported anyone who had ever signed in anywhere as an
          active member of a company they had never seen. */}
      {data.invitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Invitations ({data.invitations.length})</CardTitle>
            <CardDescription>
              Sent but not yet accepted. Nobody here has access until they accept — invitations
              expire after seven days.
            </CardDescription>
          </CardHeader>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col" className={styles.right}>
                    Expires
                  </th>
                  {isAdmin && <th scope="col" className={styles.actionCol}></th>}
                </tr>
              </thead>
              <tbody>
                {data.invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <div className={styles.person}>
                        <span className={styles.email}>{inv.email}</span>
                      </div>
                    </td>
                    <td>
                      <span className={styles.badge}>{ROLE_LABELS[inv.role]}</span>
                    </td>
                    <td className={`${styles.right} tnum`}>
                      {inv.expired ? (
                        <span className={styles.pending} title="This invitation can no longer be accepted">
                          expired
                        </span>
                      ) : (
                        format(parseISO(inv.expiresAt), "dd MMM yyyy")
                      )}
                    </td>
                    {isAdmin && (
                      <td className={styles.right}>
                        <button
                          type="button"
                          className={styles.remove}
                          onClick={() => withdraw(inv)}
                          disabled={busyId === inv.id}
                          title={`Withdraw the invitation to ${inv.email}`}
                          aria-label={`Withdraw the invitation to ${inv.email}`}
                        >
                          <MailX size={16} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What each role can do</CardTitle>
          <CardDescription>
            Generated from the same table the API enforces, so this cannot drift from what actually
            happens on a request.
          </CardDescription>
        </CardHeader>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Capability</th>
                {ROLES.map((role) => (
                  <th key={role} scope="col" className={styles.center}>
                    {ROLE_LABELS[role]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ALL_CAPABILITIES.map((capability) => (
                <tr key={capability}>
                  <td>{CAPABILITY_LABELS[capability]}</td>
                  {ROLES.map((role) => (
                    <td key={role} className={styles.center}>
                      {can(role, capability) ? (
                        <CheckCircle2
                          size={15}
                          className={styles.yes}
                          aria-label={`${ROLE_LABELS[role]}: yes`}
                        />
                      ) : (
                        <span className={styles.no} aria-label={`${ROLE_LABELS[role]}: no`}>
                          —
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
