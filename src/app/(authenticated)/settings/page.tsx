"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/core/Card";
import { Input } from "@/components/core/Input";
import { Button } from "@/components/core/Button";
import { AlertCircle, CheckCircle2, UserPlus, Building2, Settings } from "lucide-react";
import { format, parseISO } from "date-fns";
import styles from "./Settings.module.css";

interface Member {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}

interface CompanyData {
  company: { id: string; name: string; createdAt: string };
  members?: Member[]; // CRITICAL FIX: Ensure optional array fallback
}

export default function SettingsPage() {
  const [data, setData] = useState<CompanyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"profile" | "team" | "system">("profile");
  
  // Profile State
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

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setCompanyName(d.company?.name ?? "");
      })
      .finally(() => setLoading(false));
  }, []);

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

  // Safe fallback for members
  const memberList = data?.members ?? [];

  return (
    <div className={styles.pageContainer}>
      <div className={styles.tabsList}>
        <button 
          className={`${styles.tabTrigger} ${activeTab === "profile" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("profile")}
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
        
      {activeTab === "profile" && (
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

          <Card>
            <CardHeader>
              <CardTitle>Active Members ({memberList.length})</CardTitle>
              <CardDescription>Manage your current workspace team.</CardDescription>
            </CardHeader>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Email Address</th>
                    <th>Role</th>
                    <th style={{ textAlign: "right" }}>Date Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {memberList.map((m) => (
                    <tr key={m.id}>
                      <td style={{ fontWeight: 500 }}>{m.email}</td>
                      <td>
                        <span className={`${styles.badge} ${m.role === "admin" ? styles.badgeAdmin : styles.badgeMember}`}>
                          {m.role.toUpperCase()}
                        </span>
                      </td>
                      <td className="tnum" style={{ textAlign: "right", color: "var(--color-text-secondary)" }}>
                        {m.createdAt ? format(parseISO(m.createdAt), "dd MMM yyyy") : "—"}
                      </td>
                    </tr>
                  ))}
                  {memberList.length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ textAlign: "center", color: "var(--color-text-tertiary)", padding: "2rem" }}>
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
