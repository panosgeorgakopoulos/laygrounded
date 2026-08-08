"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/core/Card";
import { Input } from "@/components/core/Input";
import { Button } from "@/components/core/Button";
import { AlertCircle, CheckCircle2, UserPlus, Building2, Settings, User, Trash2, ShieldAlert, ShieldCheck, KeyRound, CalendarDays, CloudRain, Banknote } from "lucide-react";
import { DeveloperSettings } from "@/components/laygrounded/developer-settings";
import { SecurityTrail } from "@/components/laygrounded/security-trail";
import { CargoProfileSettings } from "@/components/laygrounded/cargo-profile-settings";
import { PortCalendarManager } from "@/components/laygrounded/port-calendar-manager";
import { SettlementFinanceSettings } from "@/components/laygrounded/settlement-finance-settings";
import { TeamManagement } from "@/components/laygrounded/team-management";
import { ROLE_LABELS, can, roleOf } from "@/lib/auth/roles";
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
  const [activeTab, setActiveTab] = useState<"account" | "company" | "team" | "calendars" | "finance" | "api" | "cargo" | "security" | "system">("account");
  
  // Personal Account State
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountMsg, setAccountMsg] = useState<{type: "error" | "success", text: string} | null>(null);

  // Company Profile State
  const [companyName, setCompanyName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [shareMarketData, setShareMarketData] = useState(true);
  const [savingSharing, setSavingSharing] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);


  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setCompanyName(d.company?.name ?? "");
        setShareMarketData(d.company?.shareMarketData ?? true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (session?.user) {
      setDisplayName((session.user as any).user_metadata?.display_name || "");
    }
  }, [session]);

  // Through roleOf(), so an unrecognised value fails closed to `viewer`
  // instead of quietly reading as the old "member".
  const currentUserRole = roleOf(data?.members?.find(m => m.id === session?.user?.id)?.role);
  const isAdmin = can(currentUserRole, "team.manage");

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

  // Withdrawal from market aggregates is a contractual right, so it applies on
  // toggle rather than waiting behind a Save button, and the local state is
  // rolled back if the write fails — a switch that looks flipped but did not
  // persist would misrepresent what we are publishing.
  async function saveSharing(next: boolean) {
    const previous = shareMarketData;
    setShareMarketData(next);
    setSavingSharing(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareMarketData: next }),
      });
      setSavingSharing(false);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setShareMarketData(previous);
        setProfileError(d.error || "Failed to update data-sharing preference");
        return;
      }
      setProfileSuccess(
        next
          ? "This company now contributes to market benchmarks."
          : "Withdrawn. Your voyages are excluded from future market benchmarks.",
      );
      setTimeout(() => setProfileSuccess(null), 4000);
    } catch {
      setSavingSharing(false);
      setShareMarketData(previous);
      setProfileError("A network error occurred. Please try again.");
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
          className={`${styles.tabTrigger} ${activeTab === "calendars" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("calendars")}
        >
          <CalendarDays size={16} />
          <span>Port Calendars</span>
        </button>
        <button
          className={`${styles.tabTrigger} ${activeTab === "finance" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("finance")}
        >
          <Banknote size={16} />
          <span>Settlement &amp; Banking</span>
        </button>
        <button
          className={`${styles.tabTrigger} ${activeTab === "api" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("api")}
        >
          <KeyRound size={16} />
          <span>API &amp; Developers</span>
        </button>
        <button
          className={`${styles.tabTrigger} ${activeTab === "cargo" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("cargo")}
        >
          <CloudRain size={16} />
          <span>Cargo &amp; Weather</span>
        </button>
        <button
          className={`${styles.tabTrigger} ${activeTab === "security" ? styles.tabActive : ""}`}
          onClick={() => setActiveTab("security")}
        >
          <ShieldCheck size={16} />
          <span>Security Trail</span>
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
                  {!isAdmin ? (
                    <p style={{ color: "var(--color-text-secondary)", fontSize: "0.875rem", lineHeight: 1.5 }}>
                      As a workspace <strong>{ROLE_LABELS[currentUserRole]}</strong>, you cannot delete your own account directly to ensure data integrity. 
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

          <CardHeader style={{ borderTop: "1px solid var(--color-border)" }}>
            <CardTitle>Market data sharing</CardTitle>
            <CardDescription>
              Whether this company&apos;s voyages contribute to industry benchmarks.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <label className={styles.switchRow}>
              <input
                type="checkbox"
                checked={shareMarketData}
                disabled={savingSharing || !isAdmin}
                onChange={(e) => saveSharing(e.target.checked)}
              />
              <span>
                <strong>Contribute to market benchmarks</strong>
                <span className={styles.switchHint}>
                  Your voyage timings feed aggregated, anonymised industry indices such as the
                  Port Congestion Index and the lane benchmarks on your Analytics page. Figures
                  are only ever published for a port and month containing at least 5 voyages
                  from at least 3 separate companies, so no individual voyage, vessel,
                  counterparty or company can be identified or attributed. Turning this off
                  withdraws you from future benchmarks; benchmarks already published are not
                  recalculated.
                </span>
              </span>
            </label>
            {!isAdmin && (
              <p className={styles.switchHint} style={{ marginTop: "0.5rem" }}>
                Only a company admin can change this.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* The team UI lives in one component, shared with /settings/team. Two
          copies of an invite form is two places for the role list to drift. */}
      {activeTab === "team" && <TeamManagement />}

      {activeTab === "calendars" && <PortCalendarManager />}

      {activeTab === "finance" && (
        <Card>
          <CardHeader>
            <CardTitle>Settlement &amp; Banking</CardTitle>
            <CardDescription>
              Bank and wallet details for the parties a settlement pays, and the escrow contract
              that receives an on-chain leg.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SettlementFinanceSettings />
          </CardContent>
        </Card>
      )}

      {activeTab === "api" && <DeveloperSettings />}

      {activeTab === "cargo" && (
        <Card>
          <CardHeader>
            <CardTitle>Cargo weather sensitivity</CardTitle>
          </CardHeader>
          <CardContent>
            <CargoProfileSettings />
          </CardContent>
        </Card>
      )}

      {activeTab === "security" && <SecurityTrail />}

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
