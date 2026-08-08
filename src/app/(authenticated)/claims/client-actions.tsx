"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/core/Button";
import { useCan } from "@/components/role-provider";
import styles from "./Claims.module.css";

// BOTH BUTTONS WRITE CLAIMS, so both are gated on `claim.write`.
//
// Added in Phase 16, after the RBAC E2E suite went looking for the boundary and
// found neither control checked anything. A viewer could click "Create Claim
// Workspace", fill in the whole form, and collect a 403 on submit — which reads
// as a broken product rather than as a permission boundary, exactly the failure
// `role-provider.tsx` describes.
//
// The server refusal is the security (`POST /api/claims` and `POST /api/seed`
// both check the capability). Hiding these is the courtesy half.

export function SeedDemoButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const canWrite = useCan("claim.write");

  if (!canWrite) return null;

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
  const canWrite = useCan("claim.write");

  if (!canWrite) return null;

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
