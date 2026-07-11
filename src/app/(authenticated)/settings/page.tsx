"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/core/Card";
import { Input } from "@/components/core/Input";
import { Button } from "@/components/core/Button";
import { AlertCircle, CheckCircle2, UserPlus, Building2, Settings, User, Trash2, ShieldAlert } from "lucide-react";
import { format, parseISO } from "date-fns";
import { useAuth } from "@/components/providers";
import { createClient } from "@/lib/supabase/client";
import styles from "./Settings.module.css";

interface Member {
  id: string;
  email: string;
  displayName?: string | null;
  role: string;
  createdAt: string;
}

interface CompanyData {
  company: { id: string; name: string; createdAt: string };
  members?: Member[];
}

export default function SettingsPage() {
  const { data: session } = useAuth();
  const supabase = createClient();
  const [data, setData] = useState<CompanyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"account" | "company" | "team" | "system">("account");
  
  // Personal Account State
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountMsg, setAccountMsg] = useState<{type: "error" | "success", text: string} | null>(null);

  // Company Profile State
  const [companyName, setCompanyName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

  // Invite State
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setCompanyName(d.company?.name ?? "");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (session?.user) {
      setDisplayName((session.user as any).user_metadata?.display_name || "");
    }
  }, [session]);

  const currentUserRole = data?.members?.find(m => m.id === session?.user?.id)?.role || "member";

  async function saveAccount() {
    setSavingAccount(true);
    setAccountMsg(null);
    try {
      const updates: any = {};
      if (displayName !== (session?.user as any)?.user_metadata?.display_name) {
        updates.data = { display_name: displayName };
      }
      if (password) {
        updates.password = password;
      }

      if (Object.keys(updates).length > 0) {
        const { error } = await supabase.auth.updateUser(updates);
        if (error) throw error;
      }

      setAccountMsg({ type: "success", text: "Account details updated successfully." });
      setPassword(""); // Clear password field
      setTimeout(() => setAccountMsg(null), 3000);
    } catch (e) {
      setAccountMsg({ type: "error", text: (e as Error).message || "Failed to update account." });
    } finally {
      setSavingAccount(false);
    }
  }

  async function saveName() {
    setSavingName(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: companyName }),
      });
      setSavingName(false);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setProfileError(d.error || "Failed to update company name");
        return;
      }
      setProfileSuccess("Company name successfully updated.");
      setTimeout(() => setProfileSuccess(null), 3000);
      
      const r = await fetch("/api/settings");
      const d = await r.json();
      setData(d);
    } catch (e) {
      setSavingName(false);
      setProfileError("A network error occurred. Please try again.");
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    setInviteSuccess(null);
    
    try {
      const res = await fetch("/api/settings/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      setInviting(false);
      
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setInviteError(d.error || "Failed to invite member");
        return;
      }
      
      const r = await fetch("/api/settings");
      const d = await r.json();
      setData(d);
      
      setInviteEmail("");
      setInviteSuccess("Member successfully invited.");
      setTimeout(() => setInviteSuccess(null), 3000);
    } catch (e) {
      setInviting(false);
      setInviteError("A network error occurred. Please try again.");
    }
  }

  async function removeMember(memberId: string) {
    if (!confirm("Are you sure you want to completely revoke this user's access to the workspace?")) return;
    setRemovingId(memberId);
    try {
      const res = await fetch("/api/settings/members", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: memberId }),
      });
      if (res.ok) {
        const r = await fetch("/api/settings");
        const d = await r.json();
        setData(d);
      } else {
        alert("Failed to remove member.");
      }
    } catch (e) {
      alert("A network error occurred.");
    } finally {
      setRemovingId(null);
    }
  }

  if (loading) {
    return (
      <div className={styles.pageContainer}>
        <div className={styles.skeletonContainer}>
          <div className={styles.skeletonLine} style={{ height: "2rem", width: "12rem" }} />
          <div className={styles.skeletonLine} style={{ height: "2.5rem", width: "24rem" }} />
          <div className={styles.skeletonLine} style={{ height: "400px", width: "100%" }} />
        </div>
      </div>
    );
  }

  const memberList = data?.members ?? [];

  return (
    <div className={styles.pageContainer}>
      <div className={styles.tabsList}>
        <button 
          className={`${styles.tabTrigger} ${activeTab === "account" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("account")}
        >
          <User size={16} />
          <span>Personal Account</span>
        </button>
        <button 
          className={`${styles.tabTrigger} ${activeTab === "company" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("company")}
        >
          <Building2 size={16} />
          <span>Company Profile</span>
        </button>
        <button 
          className={`${styles.tabTrigger} ${activeTab === "team" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("team")}
        >
          <UserPlus size={16} />
          <span>Team Members</span>
        </button>
        <button 
          className={`${styles.tabTrigger} ${activeTab === "system" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("system")}
        >
          <Settings size={16} />
          <span>System Preferences</span>
        </button>
      </div>

      {activeTab === "account" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          <Card>
            <CardHeader>
              <CardTitle>Personal Details</CardTitle>
              <CardDescription>Manage your personal profile and security settings.</CardDescription>
            </CardHeader>
            <CardContent>
              <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "32rem" }}>
                <Input
                  label="Email Address"
                  type="email"
                  value={session?.user?.email || ""}
                  disabled
                />
                <Input
                  label="Display Name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Captain Nemo"
                  disabled={savingAccount}
                />
                <Input
                  label="New Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave blank to keep unchanged"
                  disabled={savingAccount}
                />
              </div>

              {accountMsg && (
                <div className={`${styles.alertBox} ${accountMsg.type === "error" ? styles.alertError : styles.alertSuccess}`} style={{ marginTop: "1rem", maxWidth: "32rem" }}>
                  {accountMsg.type === "error" ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
                  <p className={styles.alertText}>{accountMsg.text}</p>
                </div>
              )}
            </CardContent>
            <CardFooter style={{ borderTop: "1px solid var(--color-border)" }}>
              <Button onClick={saveAccount} disabled={savingAccount} isLoading={savingAccount}>
                {savingAccount ? "Saving..." : "Save Account Details"}
              </Button>
            </CardFooter>
          </Card>

          <Card style={{ borderColor: "rgba(220, 38, 38, 0.2)" }}>
            <CardHeader>
              <CardTitle style={{ color: "var(--color-danger)" }}>Danger Zone</CardTitle>
              <CardDescription>Account deletion and workspace removal.</CardDescription>
            </CardHeader>
            <CardContent>
              <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start", padding: "1rem", backgroundColor: "rgba(220, 38, 38, 0.05)", borderRadius: "8px", border: "1px solid rgba(220, 38, 38, 0.1)" }}>
                <ShieldAlert size={24} style={{ color: "var(--color-danger)", flexShrink: 0 }} />
                <div>
                  <h4 style={{ fontWeight: 600, color: "var(--color-danger)", marginBottom: "0.25rem" }}>Account Deletion Policy</h4>
                  {currentUserRole === "member" ? (
                    <p style={{ color: "var(--color-text-secondary)", fontSize: "0.875rem", lineHeight: 1.5 }}>
                      As a workspace <strong>Member</strong>, you cannot delete your own account directly to ensure data integrity. 
                      To permanently delete your account and revoke your workspace access, please contact your company administrator.
                    </p>
                  ) : (
                    <p style={{ color: "var(--color-text-secondary)", fontSize: "0.875rem", lineHeight: 1.5 }}>
                      As a workspace <strong>Administrator</strong>, deleting your account requires securely transferring or deleting the entire company workspace. 
                      Please contact system administration at <strong>support@laygrounded.com</strong> to process your account deletion.
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
        
      {activeTab === "company" && (
        <Card>
          <CardHeader>
            <CardTitle>Company Information</CardTitle>
            <CardDescription>Update your company's primary identity.</CardDescription>
          </CardHeader>
          <CardContent>
            <div style={{ maxWidth: "32rem" }}>
              <Input
                label="Company Name"
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. Maritime Corp."
                disabled={savingName}
              />
            </div>

            {profileError && (
              <div className={`${styles.alertBox} ${styles.alertError}`}>
                <AlertCircle size={16} />
                <p className={styles.alertText}>{profileError}</p>
              </div>
            )}
            {profileSuccess && (
              <div className={`${styles.alertBox} ${styles.alertSuccess}`}>
                <CheckCircle2 size={16} />
                <p className={styles.alertText}>{profileSuccess}</p>
              </div>
            )}
          </CardContent>
          <CardFooter style={{ borderTop: "1px solid var(--color-border)" }}>
            <Button onClick={saveName} disabled={savingName || !companyName} isLoading={savingName}>
              {savingName ? "Saving Changes..." : "Save Changes"}
            </Button>
          </CardFooter>
        </Card>
      )}

      {activeTab === "team" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {currentUserRole === "admin" && (
            <Card>
              <CardHeader>
                <CardTitle>Invite New Member</CardTitle>
                <CardDescription>Grant access to a new user to collaborate in your workspace.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={invite} className={styles.inviteForm}>
                  <div style={{ flex: 1 }}>
                    <Input 
                      label="Email Address"
                      type="email" 
                      placeholder="captain@fleet.com" 
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      disabled={inviting}
                      required
                    />
                  </div>
                  <div className={styles.selectWrapper}>
                    <label className={styles.selectLabel}>Role Level</label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}
                      className={styles.select}
                      disabled={inviting}
                    >
                      <option value="member">Member</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </div>
                  <Button type="submit" disabled={inviting || !inviteEmail} isLoading={inviting}>
                    {inviting ? "Inviting..." : "Send Invite"}
                  </Button>
                </form>

                {inviteError && (
                  <div className={`${styles.alertBox} ${styles.alertError}`}>
                    <AlertCircle size={16} />
                    <p className={styles.alertText}>{inviteError}</p>
                  </div>
                )}
                {inviteSuccess && (
                  <div className={`${styles.alertBox} ${styles.alertSuccess}`}>
                    <CheckCircle2 size={16} />
                    <p className={styles.alertText}>{inviteSuccess}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Active Members ({memberList.length})</CardTitle>
              <CardDescription>Manage your current workspace team.</CardDescription>
            </CardHeader>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th style={{ textAlign: "right" }}>Date Joined</th>
                    {currentUserRole === "admin" && <th style={{ width: "80px" }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {memberList.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          <span style={{ fontWeight: 500 }}>{m.displayName || "No Name Set"}</span>
                          <span style={{ fontSize: "0.75rem", color: "var(--color-text-tertiary)" }}>{m.email}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`${styles.badge} ${m.role === "admin" ? styles.badgeAdmin : styles.badgeMember}`}>
                          {m.role.toUpperCase()}
                        </span>
                      </td>
                      <td className="tnum" style={{ textAlign: "right", color: "var(--color-text-secondary)" }}>
                        {m.createdAt ? format(parseISO(m.createdAt), "dd MMM yyyy") : "—"}
                      </td>
                      {currentUserRole === "admin" && (
                        <td style={{ textAlign: "right" }}>
                          {m.id !== session?.user?.id && (
                            <button
                              onClick={() => removeMember(m.id)}
                              disabled={removingId === m.id}
                              style={{ 
                                color: "var(--color-danger)", 
                                background: "transparent", 
                                border: "none", 
                                cursor: "pointer",
                                opacity: removingId === m.id ? 0.5 : 1
                              }}
                              title="Revoke Access"
                            >
                              <Trash2 size={18} />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                  {memberList.length === 0 && (
                    <tr>
                      <td colSpan={currentUserRole === "admin" ? 4 : 3} style={{ textAlign: "center", color: "var(--color-text-tertiary)", padding: "2rem" }}>
                        No team members found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {activeTab === "system" && (
        <Card>
          <CardHeader>
            <CardTitle>System Preferences</CardTitle>
            <CardDescription>Application-wide defaults and system settings.</CardDescription>
          </CardHeader>
          <CardContent>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "3rem 1rem", color: "var(--color-text-tertiary)" }}>
              <Settings size={32} style={{ opacity: 0.5, marginBottom: "1rem" }} />
              <p style={{ fontSize: "0.875rem" }}>Advanced system preferences will be available in a future update.</p>
            </div>
          </CardContent>
        </Card>
      )}

    </div>
  );
}
