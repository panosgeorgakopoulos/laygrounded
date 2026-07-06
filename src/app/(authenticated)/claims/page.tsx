"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Claim {
  id: string;
  vessel: string;
  voyageRef: string;
  port: string;
  cargo: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  documentCount: number;
  exposure: {
    demurrageAmount: number | null;
    despatchAmount: number | null;
    currency: string;
    usedHours: number;
    allowedHours: number;
  } | null;
}

export default function ClaimsRegisterPage() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/claims")
      .then((r) => r.json())
      .then((d) => setClaims(d.claims || []))
      .finally(() => setLoading(false));
  }, []);

  async function seedDemo() {
    if (!confirm("Seed 3 demo SoF scenarios? This adds 3 sample claims to your workspace.")) return;
    await fetch("/api/seed", { method: "POST" });
    const r = await fetch("/api/claims");
    const d = await r.json();
    setClaims(d.claims || []);
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[#1f2937] bg-[#0a0f1e] sticky top-0" style={{ zIndex: 20 }}>
        <div className="px-8 h-14 flex items-center justify-between">
          <h1
            className="text-lg font-medium"
            style={{ fontFamily: "var(--font-space-grotesk)" }}
          >
            Claims Register
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={seedDemo}
              className="px-3 py-1.5 text-xs border border-[#1f2937] bg-[#111827] text-[#9ca3af] hover:text-[#f9fafb] hover:border-[#f59e0b]"
              style={{ borderRadius: 2, fontFamily: "var(--font-jetbrains-mono)" }}
            >
              SEED DEMO
            </button>
            <Link
              href="/claims/new"
              className="px-3 py-1.5 text-sm text-[#0a0f1e] font-medium transition hover:opacity-90"
              style={{ background: "#f59e0b", borderRadius: 2 }}
            >
              New Claim
            </Link>
          </div>
        </div>
      </header>

      <div className="p-8">
        {loading ? (
          <div className="text-sm text-[#9ca3af]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
            LOADING CLAIMS…
          </div>
        ) : claims.length === 0 ? (
          <div className="border border-[#1f2937] bg-[#111827] p-12 text-center" style={{ borderRadius: 2 }}>
            <div
              className="text-xs uppercase tracking-wider text-[#6b7280] mb-4"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              NO CLAIMS YET
            </div>
            <div className="text-[#f9fafb] mb-6">
              No claims yet — initialize your first claim workspace
            </div>
            <div className="flex items-center justify-center gap-3">
              <Link
                href="/claims/new"
                className="px-4 py-2 text-sm text-[#0a0f1e] font-medium transition hover:opacity-90"
                style={{ background: "#f59e0b", borderRadius: 2 }}
              >
                Initialize Claim Workspace
              </Link>
              <button
                onClick={seedDemo}
                className="px-4 py-2 text-sm border border-[#1f2937] bg-[#111827] text-[#f9fafb] hover:border-[#f59e0b]"
                style={{ borderRadius: 2 }}
              >
                Seed demo scenarios
              </button>
            </div>
          </div>
        ) : (
          <div className="border border-[#1f2937] bg-[#111827]" style={{ borderRadius: 2 }}>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#1f2937]">
                  {["Vessel", "Voyage Ref", "Port", "Status", "Exposure"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 text-xs uppercase tracking-wider text-[#9ca3af] font-medium"
                      style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/claims/${c.id}/workspace`)}
                    className="border-b border-[#1f2937] last:border-b-0 cursor-pointer hover:bg-[#1f2937] transition"
                  >
                    <td className="px-4 py-3 text-sm text-[#f9fafb]">{c.vessel}</td>
                    <td className="px-4 py-3 text-sm text-[#9ca3af] tnum">{c.voyageRef}</td>
                    <td className="px-4 py-3 text-sm text-[#9ca3af]">{c.port}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-4 py-3 text-sm tnum">
                      <ExposureCell exposure={c.exposure} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  let color = "#6b7280";
  let bg = "transparent";
  if (status === "demurrage") {
    color = "#f59e0b";
    bg = "rgba(245,158,11,0.08)";
  } else if (status === "despatch") {
    color = "#14b8a6";
    bg = "rgba(20,184,166,0.08)";
  } else if (status === "in_progress") {
    color = "#9ca3af";
    bg = "rgba(156,163,175,0.08)";
  } else if (status === "draft") {
    color = "#6b7280";
  }
  return (
    <span
      className="status-badge inline-block px-2 py-0.5"
      style={{ color, background: bg, border: `1px solid ${color}40`, borderRadius: 2 }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ExposureCell({
  exposure,
}: {
  exposure: Claim["exposure"];
}) {
  if (!exposure) return <span className="text-[#6b7280]">—</span>;
  if (exposure.demurrageAmount && exposure.demurrageAmount > 0) {
    return (
      <span style={{ color: "#f59e0b" }}>
        {exposure.currency} {exposure.demurrageAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  }
  if (exposure.despatchAmount && exposure.despatchAmount > 0) {
    return (
      <span style={{ color: "#14b8a6" }}>
        ↓ {exposure.currency} {exposure.despatchAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  }
  return <span className="text-[#6b7280]">—</span>;
}
