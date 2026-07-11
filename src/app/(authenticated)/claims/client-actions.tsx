"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/core/Button";
import styles from "./Claims.module.css";

export function SeedDemoButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function seedDemo() {
    if (!confirm("Seed 3 demo SoF scenarios? This adds 3 sample claims to your workspace.")) return;
    setLoading(true);
    await fetch("/api/seed", { method: "POST" });
    router.refresh();
    setLoading(false);
  }

  return (
    <Button variant="secondary" onClick={seedDemo} disabled={loading}>
      {loading ? "Seeding..." : "Seed Demo Scenarios"}
    </Button>
  );
}

export function CreateClaimButton() {
  const router = useRouter();
  return (
    <Button onClick={() => router.push("/claims/new")}>
      Create Claim Workspace
    </Button>
  );
}

export function ClaimRow({ id, children }: { id: string; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <tr
      onClick={() => router.push(`/claims/${id}/workspace`)}
      className={styles.tableRow}
      style={{ cursor: "pointer" }}
    >
      {children}
    </tr>
  );
}
