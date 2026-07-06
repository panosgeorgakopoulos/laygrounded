"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function NewClaimPage() {
  const [vessel, setVessel] = useState("");
  const [voyageRef, setVoyageRef] = useState("");
  const [port, setPort] = useState("");
  const [cargo, setCargo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vessel, voyageRef, port, cargo, cpForm: "GENCON94" }),
    });
    setLoading(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to create claim");
      return;
    }
    const { claim } = await res.json();
    router.push(`/claims/${claim.id}/workspace`);
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[#1f2937] bg-[#0a0f1e] sticky top-0" style={{ zIndex: 20 }}>
        <div className="px-4 sm:px-8 h-14 flex items-center gap-3 min-w-0">
          <Link href="/claims" className="text-sm text-[#9ca3af] hover:text-[#f9fafb] shrink-0">
            ← Claims
          </Link>
          <span className="text-[#1f2937] shrink-0">/</span>
          <h1
            className="text-base sm:text-lg font-medium truncate"
            style={{ fontFamily: "var(--font-space-grotesk)" }}
          >
            New Claim
          </h1>
        </div>
      </header>

      <div className="p-4 sm:p-8 max-w-2xl">
        <div className="border border-[#1f2937] bg-[#111827] p-6" style={{ borderRadius: 2 }}>
          <form onSubmit={onSubmit} className="space-y-5">
            <div>
              <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                Vessel
              </label>
              <input
                type="text"
                required
                value={vessel}
                onChange={(e) => setVessel(e.target.value)}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-3 py-2.5 sm:py-2 min-h-[44px] text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
                style={{ borderRadius: 2 }}
                placeholder="MV Pacific Trader"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                Voyage reference
              </label>
              <input
                type="text"
                required
                value={voyageRef}
                onChange={(e) => setVoyageRef(e.target.value)}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-3 py-2.5 sm:py-2 min-h-[44px] text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
                style={{ borderRadius: 2 }}
                placeholder="VR-2024-0142"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                Load port
              </label>
              <input
                type="text"
                required
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-3 py-2.5 sm:py-2 min-h-[44px] text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
                style={{ borderRadius: 2 }}
                placeholder="Port Hedland, AU"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                Cargo type
              </label>
              <input
                type="text"
                required
                value={cargo}
                onChange={(e) => setCargo(e.target.value)}
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-3 py-2.5 sm:py-2 min-h-[44px] text-[#f9fafb] focus:outline-none focus:border-[#f59e0b]"
                style={{ borderRadius: 2 }}
                placeholder="Iron Ore Fines, 165,000 MT"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-[#9ca3af] mb-2" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                Charterparty form
              </label>
              <div
                className="w-full bg-[#0a0f1e] border border-[#1f2937] px-3 py-2 text-[#6b7280] flex items-center justify-between"
                style={{ borderRadius: 2 }}
              >
                <span>GENCON 94</span>
                <span
                  className="text-xs uppercase tracking-wider"
                  style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                >
                  LOCKED
                </span>
              </div>
            </div>

            {error && (
              <div className="text-xs text-[#ef4444]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                {error}
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-3 min-h-[48px] sm:min-h-0 sm:py-2.5 text-sm text-[#0a0f1e] font-medium transition hover:opacity-90 disabled:opacity-50"
                style={{ background: "#f59e0b", borderRadius: 2 }}
              >
                {loading ? "Creating…" : "Create claim & open workspace"}
              </button>
              <Link
                href="/claims"
                className="px-4 py-3 min-h-[48px] sm:min-h-0 sm:py-2.5 flex items-center justify-center text-sm text-[#9ca3af] hover:text-[#f9fafb]"
              >
                Cancel
              </Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
