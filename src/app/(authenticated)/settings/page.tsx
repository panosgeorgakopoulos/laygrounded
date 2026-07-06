"use client";

import { useEffect, useState } from "react";

interface Member {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}

interface CompanyData {
  company: { id: string; name: string; createdAt: string };
  members: Member[];
}

export default function SettingsPage() {
  const [data, setData] = useState<CompanyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [companyName, setCompanyName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
    setError(null);
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: companyName }),
    });
    setSavingName(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to update company name");
      return;
    }
    setToast("Company name updated.");
    setTimeout(() => setToast(null), 3000);
    // Refresh.
    const r = await fetch("/api/settings");
    const d = await r.json();
    setData(d);
  }

  async function invite() {
    setInviting(true);
    setError(null);
    const res = await fetch("/api/settings/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    setInviting(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to invite member");
      return;
    }
    const r = await fetch("/api/settings");
    const d = await r.json();
    setData(d);
    setInviteEmail("");
    setToast("Member invited.");
    setTimeout(() => setToast(null), 3000);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[#9ca3af]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
        LOADING SETTINGS…
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[#1f2937] bg-[#0a0f1e] sticky top-0" style={{ zIndex: 20 }}>
        <div className="px-4 sm:px-8 h-14 flex items-center">
          <h1
            className="text-base sm:text-lg font-medium truncate"
            style={{ fontFamily: "var(--font-space-grotesk)" }}
          >
            Settings
          </h1>
        </div>
      </header>

      <div className="p-4 sm:p-8 max-w-3xl space-y-6">
        {/* Company name */}
        <section className="border border-[#1f2937] bg-[#111827] p-4 sm:p-6" style={{ borderRadius: 2 }}>
          <div
            className="text-xs uppercase tracking-wider text-[#9ca3af] mb-3"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            COMPANY
          </div>
          <label className="block">
            <div
              className="text-[10px] uppercase tracking-wider text-[#6b7280] mb-1.5"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              Company name
            </div>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="w-full bg-[#0a0f1e] border border-[#1f2937] px-3 py-2.5 sm:py-2 min-h-[44px] text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
              style={{ borderRadius: 2 }}
            />
          </label>
          <button
            onClick={saveName}
            disabled={savingName}
            className="mt-3 px-4 py-2.5 min-h-[44px] text-xs text-[#0a0f1e] font-medium disabled:opacity-50"
            style={{ background: "#f59e0b", borderRadius: 2 }}
          >
            {savingName ? "SAVING…" : "SAVE"}
          </button>
        </section>

        {/* Members */}
        <section className="border border-[#1f2937] bg-[#111827]" style={{ borderRadius: 2 }}>
          <div className="p-4 sm:p-6 pb-3">
            <div
              className="text-xs uppercase tracking-wider text-[#9ca3af]"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              MEMBERS ({data?.members.length ?? 0})
            </div>
          </div>

          {/* Desktop: full table with Joined column */}
          <table className="hidden md:table w-full">
            <thead>
              <tr className="border-y border-[#1f2937]">
                {["Email", "Role", "Joined"].map((h) => (
                  <th
                    key={h}
                    className="text-left px-6 py-2 text-[10px] uppercase tracking-wider text-[#6b7280]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.members.map((m) => (
                <tr key={m.id} className="border-b border-[#1f2937] last:border-b-0">
                  <td className="px-6 py-3 text-sm text-[#f9fafb]">{m.email}</td>
                  <td className="px-6 py-3">
                    <span
                      className="status-badge px-1.5 py-0.5"
                      style={{
                        color: m.role === "admin" ? "#f59e0b" : "#9ca3af",
                        border: `1px solid ${m.role === "admin" ? "#f59e0b" : "#9ca3af"}40`,
                        borderRadius: 2,
                      }}
                    >
                      {m.role}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-sm text-[#9ca3af] tnum" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                    {new Date(m.createdAt).toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile: simplified list with only Email + Role */}
          <div className="md:hidden">
            {data?.members.map((m) => (
              <div key={m.id} className="border-y border-[#1f2937] first:border-t-0 px-4 py-3 flex items-center justify-between gap-3 min-h-[44px]">
                <span className="text-sm text-[#f9fafb] truncate min-w-0">{m.email}</span>
                <span
                  className="status-badge px-1.5 py-0.5 shrink-0"
                  style={{
                    color: m.role === "admin" ? "#f59e0b" : "#9ca3af",
                    border: `1px solid ${m.role === "admin" ? "#f59e0b" : "#9ca3af"}40`,
                    borderRadius: 2,
                  }}
                >
                  {m.role}
                </span>
              </div>
            ))}
          </div>

          {/* Invite form */}
          <div className="p-4 sm:p-6 pt-4 border-t border-[#1f2937]">
            <div
              className="text-[10px] uppercase tracking-wider text-[#6b7280] mb-2"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              INVITE BY EMAIL
            </div>
            {/* Mobile: stacked; Desktop: inline row */}
            <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="captain@fleet.com"
                className="flex-1 w-full bg-[#0a0f1e] border border-[#1f2937] px-3 py-2.5 sm:py-2 min-h-[44px] text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
                style={{ borderRadius: 2 }}
              />
              <div className="flex gap-2">
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}
                  className="flex-1 md:flex-none bg-[#0a0f1e] border border-[#1f2937] px-3 py-2.5 sm:py-2 min-h-[44px] text-[#f9fafb]"
                  style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
                <button
                  onClick={invite}
                  disabled={inviting || !inviteEmail}
                  className="px-4 py-2.5 min-h-[44px] text-xs text-[#0a0f1e] font-medium disabled:opacity-50"
                  style={{ background: "#f59e0b", borderRadius: 2 }}
                >
                  {inviting ? "INVITING…" : "INVITE"}
                </button>
              </div>
            </div>
          </div>
        </section>

        {error && (
          <div className="text-xs text-[#ef4444]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
            {error}
          </div>
        )}
        {toast && (
          <div className="text-xs text-[#14b8a6]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
