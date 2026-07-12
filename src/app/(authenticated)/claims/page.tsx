import { Suspense } from "react";
import { Anchor } from "lucide-react";
import { format, parseISO } from "date-fns";
import { Card } from "@/components/core/Card";
import styles from "./Claims.module.css";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { ClaimWithRelations, LaytimeCalculationRow } from "@/lib/database-types";
import { computeTimeBar, TimeBarStatus } from "@/lib/time-bar";
import { SeedDemoButton, CreateClaimButton, ClaimRow } from "./client-actions";

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
  timeBar: TimeBarStatus | null;
  exposure: {
    demurrageAmount: number;
    despatchAmount: number;
    currency: string;
    usedHours: number;
    allowedHours: number;
  } | null;
}

interface DashboardClaimRow extends Omit<ClaimWithRelations, "sof_events" | "documents" | "companies" | "laytime_calculations"> {
  sof_events: [{ count: number }] | { count: number } | number | null;
  documents: [{ count: number }] | { count: number } | number | null;
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

function TimeBarCell({ timeBar }: { timeBar: TimeBarStatus | null }) {
  if (!timeBar || timeBar.state === "no_anchor" || timeBar.daysRemaining === null) {
    return <span style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  }
  let badgeClass = styles.badgeSuccess;
  if (timeBar.state === "warning") badgeClass = styles.badgeWarning;
  else if (timeBar.state === "critical" || timeBar.state === "expired") badgeClass = styles.badgeDanger;

  return (
    <span className={`${styles.badge} ${badgeClass} tnum`}>
      {timeBar.state === "expired" ? "EXPIRED" : `${timeBar.daysRemaining}D LEFT`}
    </span>
  );
}

function ExposureCell({ exposure }: { exposure: Claim["exposure"] }) {
  if (!exposure) return <span className="tnum" style={{ color: "var(--color-text-tertiary)" }}>—</span>;
  if (exposure.demurrageAmount > 0) {
    return (
      <span className="tnum" style={{ color: "#ca8a04", fontWeight: 500 }}>
        {exposure.currency} {exposure.demurrageAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  }
  if (exposure.despatchAmount > 0) {
    return (
      <span className="tnum" style={{ color: "#16a34a", fontWeight: 500 }}>
        ↓ {exposure.currency} {exposure.despatchAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  }
  return <span className="tnum" style={{ color: "var(--color-text-tertiary)" }}>—</span>;
}

async function ClaimsList() {
  const auth = await requireAuth();
  const supabase = await createClient();

  const { data: claimsData, error } = await supabase
    .from("claims")
    .select(`
      *,
      sof_events(count),
      documents(count)
    `)
    .eq("company_id", auth.companyId)
    .order("updated_at", { ascending: false });

  if (error) throw error;

  const rawClaims = claimsData as unknown as DashboardClaimRow[];
  const claimIds = rawClaims.map((c) => c.id);
  const calculationsMap: Record<string, LaytimeCalculationRow> = {};
  // Confirmed milestone events per claim, batched — feeds the time-bar chip
  // without an N+1.
  const milestonesMap: Record<string, Array<{ event_type: string; occurred_at: string }>> = {};

  if (claimIds.length > 0) {
    const [{ data: calculations }, { data: milestones }] = await Promise.all([
      supabase
        .from("laytime_calculations")
        .select("claim_id, demurrage_amount, despatch_amount, currency, used_hours, allowed_hours, computed_at")
        .in("claim_id", claimIds)
        .order("computed_at", { ascending: false }),
      supabase
        .from("sof_events")
        .select("claim_id, event_type, occurred_at")
        .in("claim_id", claimIds)
        .in("event_type", ["COMPLETED_DISCHARGE", "COMPLETED_LOADING", "NOR_TENDERED"])
        .in("status", ["accepted", "edited"]),
    ]);

    if (calculations) {
      for (const calc of calculations as unknown as LaytimeCalculationRow[]) {
        if (!calculationsMap[calc.claim_id]) {
          calculationsMap[calc.claim_id] = calc;
        }
      }
    }
    for (const m of milestones || []) {
      (milestonesMap[m.claim_id] ??= []).push({
        event_type: m.event_type,
        occurred_at: m.occurred_at,
      });
    }
  }

  const claims: Claim[] = rawClaims.map((c) => {
    const calc = calculationsMap[c.id];
    const getCount = (relation: any) => {
      if (Array.isArray(relation) && relation.length > 0) return relation[0].count || 0;
      if (typeof relation === 'object' && relation !== null) return relation.count || 0;
      if (typeof relation === 'number') return relation;
      return 0;
    };

    const timeBar = computeTimeBar({
      timeBarDays: c.time_bar_days ?? 90,
      events: milestonesMap[c.id] ?? [],
      // Only the deadline matters for the dashboard chip; the full
      // completeness checklist lives in the workspace.
      hasSofDocument: true,
      hasValidCpTerms: true,
      hasCalculation: !!calc,
    });

    return {
      id: c.id,
      vessel: c.vessel,
      voyageRef: c.voyage_ref,
      port: c.port,
      cargo: c.cargo,
      status: c.status,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      eventCount: getCount(c.sof_events),
      documentCount: getCount(c.documents),
      timeBar,
      exposure: calc
        ? {
            demurrageAmount: calc.demurrage_amount,
            despatchAmount: calc.despatch_amount,
            currency: calc.currency,
            usedHours: calc.used_hours,
            allowedHours: calc.allowed_hours,
          }
        : null,
    };
  });

  if (claims.length === 0) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>
          <Anchor size={32} />
        </div>
        <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem" }}>No claims found</h2>
        <p style={{ color: "var(--color-text-secondary)", maxWidth: "400px", marginBottom: "1.5rem" }}>
          You haven't initialized any claim workspaces yet. Create a new claim or seed some demo scenarios to get started.
        </p>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <CreateClaimButton />
          <SeedDemoButton />
        </div>
      </div>
    );
  }

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Vessel & Cargo</th>
          <th>Voyage Ref</th>
          <th>Port</th>
          <th>Status</th>
          <th>Time Bar</th>
          <th>Updated</th>
          <th style={{ textAlign: "right" }}>Exposure</th>
        </tr>
      </thead>
      <tbody>
        {claims.map((c) => (
          <ClaimRow key={c.id} id={c.id}>
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
              <TimeBarCell timeBar={c.timeBar} />
            </td>
            <td>
              <span className="tnum" style={{ color: "var(--color-text-secondary)" }}>
                {format(parseISO(c.updatedAt), "dd MMM yyyy")}
              </span>
            </td>
            <td style={{ textAlign: "right" }}>
              <ExposureCell exposure={c.exposure} />
            </td>
          </ClaimRow>
        ))}
      </tbody>
    </table>
  );
}

function ClaimsSkeleton() {
  return (
    <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className={styles.skeleton} style={{ height: "2.5rem", width: "100%" }} />
      ))}
    </div>
  );
}

export default function ClaimsDashboard() {
  return (
    <div>
      <Card>
        <div className={styles.tableWrapper}>
          <Suspense fallback={<ClaimsSkeleton />}>
            <ClaimsList />
          </Suspense>
        </div>
      </Card>
    </div>
  );
}
