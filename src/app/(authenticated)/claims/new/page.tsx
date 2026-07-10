"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Input } from "@/components/core/Input";
import { Button } from "@/components/core/Button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/core/Card";
import { AlertCircle, ArrowLeft } from "lucide-react";
import styles from "./NewClaim.module.css";

// Matches the exact API validation schema from POST /api/claims
const createClaimSchema = z.object({
  vessel: z.string().min(1, "Vessel name is required"),
  voyageRef: z.string().min(1, "Voyage reference is required"),
  port: z.string().min(1, "Port is required"),
  cargo: z.string().min(1, "Cargo description is required"),
  cpForm: z.string().min(1),
});

type CreateClaimFormValues = z.infer<typeof createClaimSchema>;

export default function NewClaimPage() {
  const router = useRouter();
  const [globalError, setGlobalError] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<CreateClaimFormValues>({
    resolver: zodResolver(createClaimSchema),
    defaultValues: {
      vessel: "",
      voyageRef: "",
      port: "",
      cargo: "",
      cpForm: "GENCON94",
    },
  });

  async function onSubmit(data: CreateClaimFormValues) {
    setGlobalError(null);
    try {
      const res = await fetch("/api/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setGlobalError(d.error || "Failed to create claim workspace. Please try again.");
        return;
      }
      
      const { claim } = await res.json();
      router.push(`/claims/${claim.id}/workspace`);
    } catch (e) {
      setGlobalError("A network error occurred. Please try again.");
    }
  }

  return (
    <div className={styles.pageContainer}>
      <Card>
        <CardHeader>
          <CardTitle>Voyage Particulars</CardTitle>
          <CardDescription>All fields are required unless otherwise noted.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)}>
            
            <div className={styles.formGrid}>
              <Input
                label="VESSEL NAME"
                placeholder="e.g. MV Pacific Trader"
                {...register("vessel")}
                disabled={isSubmitting}
                error={errors.vessel?.message}
              />
              
              <Input
                label="VOYAGE REFERENCE"
                placeholder="e.g. VR-2024-0142"
                {...register("voyageRef")}
                disabled={isSubmitting}
                error={errors.voyageRef?.message}
                className="tnum"
              />

              <Input
                label="LOAD / DISCH PORT"
                placeholder="e.g. Port Hedland, AU"
                {...register("port")}
                disabled={isSubmitting}
                error={errors.port?.message}
              />

              <Input
                label="CARGO DETAILS"
                placeholder="e.g. Iron Ore Fines, 165,000 MT"
                {...register("cargo")}
                disabled={isSubmitting}
                error={errors.cargo?.message}
              />
            </div>

            <div className={styles.lockedField}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.25rem" }}>CHARTERPARTY FORM</span>
                <span className={styles.lockedText}>GENCON94</span>
              </div>
              <span className={styles.lockedBadge}>Locked</span>
            </div>

            {globalError && (
              <div className={styles.errorBox}>
                <AlertCircle size={20} color="#ef4444" />
                <p className={styles.errorText}>{globalError}</p>
              </div>
            )}

            <div className={styles.formActions}>
              <Button type="submit" isLoading={isSubmitting} size="lg">
                {isSubmitting ? "Creating Workspace..." : "Create Workspace"}
              </Button>
              <Button type="button" variant="secondary" size="lg" disabled={isSubmitting} onClick={() => router.push("/claims")}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
