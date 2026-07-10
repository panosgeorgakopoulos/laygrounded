"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/core/Button";
import { Card } from "@/components/core/Card";
import { PlusCircle, Anchor } from "lucide-react";
import { format, parseISO } from "date-fns";
import styles from "./Claims.module.css";

export interface Claim {
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

export default function ClaimsDashboard() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const fetchClaims = () => {
    setLoading(true);
    fetch("/api/claims")
      .then((r) => r.json())
      .then((d) => setClaims(d.claims || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchClaims();
  }, []);

  async function seedDemo() {
    if (!confirm("Seed 3 demo SoF scenarios? This adds 3 sample claims to your workspace.")) return;
    setLoading(true);
    await fetch("/api/seed", { method: "POST" });
    fetchClaims();
  }

  return (
    <div>
      <Card>
        <div className={styles.tableWrapper}>
          {loading ? (
            <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className={styles.skeleton} style={{ height: "2.5rem", width: "100%" }} />
              ))}
            </div>
          ) : claims.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                <Anchor size={32} />
              </div>
              <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>No claims found</h2>
              <p style={{ color: "var(--color-text-secondary)", maxWidth: "400px", marginBottom: "1.5rem" }}>
                You haven't initialized any claim workspaces yet. Create a new claim or seed some demo scenarios to get started.
              </p>
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <Button onClick={() => router.push("/claims/new")}>Create Claim Workspace</Button>
                <Button variant="secondary" onClick={seedDemo}>Seed Demo Scenarios</Button>
              </div>
            </div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Vessel & Cargo</th>
                  <th>Voyage Ref</th>
                  <th>Port</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th style={{ textAlign: "right" }}>Exposure</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/claims/${c.id}/workspace`)}
                    className={styles.tableRow}
                  >
                    <td>
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{c.vessel}</span>
                        <span style={{ fontSize: "0.75rem", color: "var(--color-text-tertiary)" }}>{c.cargo}</span>
                      </div>
                    </td>
                    <td>
                      <span className="tnum" style={{ color: "var(--color-text-secondary)" }}>{c.voyageRef}</span>
                    </td>
                    <td>
                      <span>{c.port}</span>
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>
                      <span className="tnum" style={{ color: "var(--color-text-secondary)" }}>
                        {format(parseISO(c.updatedAt), "dd MMM yyyy")}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <ExposureCell exposure={c.exposure} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  let badgeClass = styles.badgeMuted;
  
  if (status === "demurrage") badgeClass = styles.badgeWarning;
  else if (status === "despatch") badgeClass = styles.badgeSuccess;
  else if (status === "in_progress") badgeClass = styles.badgeInfo;

  return (
    <span className={`${styles.badge} ${badgeClass}`}>
      {status.replace(/_/g, " ").toUpperCase()}
    </span>
  );
}

function ExposureCell({ exposure }: { exposure: Claim["exposure"] }) {
  if (!exposure) return <span className="tnum" style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  
  if (exposure.demurrageAmount && exposure.demurrageAmount > 0) {
    return (
      <span className="tnum" style={{ color: "#ca8a04", fontWeight: 500 }}>
        {exposure.currency} {exposure.demurrageAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  }
  
  if (exposure.despatchAmount && exposure.despatchAmount > 0) {
    return (
      <span className="tnum" style={{ color: "#16a34a", fontWeight: 500 }}>
        ↓ {exposure.currency} {exposure.despatchAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  }
  
  return <span className="tnum" style={{ color: "var(--color-text-tertiary)" }}>—</span>;
}
