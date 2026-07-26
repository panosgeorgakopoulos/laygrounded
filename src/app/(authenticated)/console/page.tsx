import { Suspense } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Card } from "@/components/core/Card";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { computeTimeBar } from "@/lib/time-bar";
import { triageBook, type TriageClaimInput, type TriageSeverity } from "@/lib/console/triage";
import type { LaytimeCalculationRow } from "@/lib/database-types";
import styles from "./Console.module.css";

export const metadata = {
  title: "Voyage console · LayGrounded",
  description: "Everything across the book that needs attention today, ranked.",
};

// Milestone events that can anchor a time bar. Kept in step with the dashboard's
// identical filter — both feed computeTimeBar.
const MILESTONE_TYPES = ["COMPLETED_DISCHARGE", "COMPLETED_LOADING", "NOR_TENDERED"];
const CONFIRMED_STATUSES = ["accepted", "edited"];

async function loadTriage() {
  const auth = await requireAuth();
  const supabase = await createClient();

  const { data: claimRows, error } = await supabase
    .from("claims")
    .select("id, vessel, voyage_ref, port, status, time_bar_days, settled_at")
    .eq("company_id", auth.companyId)
    .order("updated_at", { ascending: false });

  if (error) throw error;
  const claims = claimRows ?? [];
  if (claims.length === 0) return { summary: triageBook([]), totalClaims: 0 };

  const claimIds = claims.map((c) => c.id);

  // Every per-claim fact in one batched round each — the console reads the whole
  // book, so an N+1 here would scale with the customer's success.
  const [
    { data: calculations },
    { data: events },
    { data: alerts },
    { data: proposals },
    { data: evidence },
  ] = await Promise.all([
    supabase
      .from("laytime_calculations")
      .select("claim_id, demurrage_amount, despatch_amount, currency, computed_at")
      .in("claim_id", claimIds)
      .order("computed_at", { ascending: false }),
    supabase.from("sof_events").select("claim_id, event_type, occurred_at, status").in("claim_id", claimIds),
    supabase.from("voyage_alerts").select("claim_id, status").in("claim_id", claimIds).eq("status", "open"),
    supabase.from("event_proposals").select("claim_id, status").in("claim_id", claimIds).eq("status", "pending"),
    supabase.from("evidence_checks").select("claim_id").in("claim_id", claimIds),
  ]);

  const latestCalc: Record<string, LaytimeCalculationRow> = {};
  for (const calc of (calculations ?? []) as unknown as LaytimeCalculationRow[]) {
    // Ordered newest-first above, so the first sighting of a claim is its latest.
    if (!latestCalc[calc.claim_id]) latestCalc[calc.claim_id] = calc;
  }

  const milestones: Record<string, Array<{ event_type: string; occurred_at: string }>> = {};
  const suggested: Record<string, number> = {};
  for (const e of events ?? []) {
    if (e.status === "suggested") {
      suggested[e.claim_id] = (suggested[e.claim_id] ?? 0) + 1;
    }
    if (MILESTONE_TYPES.includes(e.event_type) && CONFIRMED_STATUSES.includes(e.status)) {
      (milestones[e.claim_id] ??= []).push({ event_type: e.event_type, occurred_at: e.occurred_at });
    }
  }

  const tally = (rows: Array<{ claim_id: string }> | null) => {
    const out: Record<string, number> = {};
    for (const r of rows ?? []) out[r.claim_id] = (out[r.claim_id] ?? 0) + 1;
    return out;
  };
  const alertCount = tally(alerts);
  const proposalCount = tally(proposals);
  const evidenceCount = tally(evidence);

  const inputs: TriageClaimInput[] = claims.map((c) => {
    const calc = latestCalc[c.id];
    return {
      claimId: c.id,
      vessel: c.vessel,
      voyageRef: c.voyage_ref,
      port: c.port,
      status: c.status,
      timeBar: computeTimeBar({
        timeBarDays: c.time_bar_days ?? 90,
        events: milestones[c.id] ?? [],
        hasSofDocument: true,
        hasValidCpTerms: true,
        hasCalculation: !!calc,
      }),
      // Owner's perspective, matching diff.ts: demurrage earned less despatch owed.
      netAmount: calc ? calc.demurrage_amount - calc.despatch_amount : 0,
      currency: calc?.currency ?? "USD",
      hasCalculation: !!calc,
      openAlerts: alertCount[c.id] ?? 0,
      pendingProposals: proposalCount[c.id] ?? 0,
      suggestedEvents: suggested[c.id] ?? 0,
      evidenceChecks: evidenceCount[c.id] ?? 0,
      settled: c.settled_at !== null,
    };
  });

  return { summary: triageBook(inputs), totalClaims: claims.length };
}

function SeverityChip({ severity }: { severity: TriageSeverity }) {
  return (
    <span className={`${styles.chip} ${styles[severity]}`}>{severity.toUpperCase()}</span>
  );
}

async function TriageQueue() {
  const { summary, totalClaims } = await loadTriage();

  if (totalClaims === 0) {
    return (
      <div className={styles.empty}>
        <h2 className={styles.emptyTitle}>Nothing to work on yet</h2>
        <p className={styles.emptyBody}>
          The console ranks every open claim by what it needs and what ignoring it costs.
          Create a claim to fill it.
        </p>
        <Link href="/claims/new" className={styles.primaryLink}>
          Create a claim
        </Link>
      </div>
    );
  }

  if (summary.actions.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>
          <CheckCircle2 size={30} />
        </div>
        <h2 className={styles.emptyTitle}>The book is clear</h2>
        <p className={styles.emptyBody}>
          All {totalClaims} claim{totalClaims === 1 ? "" : "s"} are computed, evidenced and
          inside their time bars. Nothing needs attention right now.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className={styles.summaryRow}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{summary.actions.length}</span>
          <span className={styles.statLabel}>open actions</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{summary.claimsNeedingAction}</span>
          <span className={styles.statLabel}>of {totalClaims} claims</span>
        </div>
        <div className={styles.stat}>
          <span className={`${styles.statValue} tnum`}>
            {summary.currency}{" "}
            {summary.totalAtStake.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
          <span className={styles.statLabel}>exposure in play</span>
        </div>
        {summary.counts.critical > 0 && (
          <div className={`${styles.stat} ${styles.statCritical}`}>
            <span className={styles.statValue}>{summary.counts.critical}</span>
            <span className={styles.statLabel}>critical</span>
          </div>
        )}
      </div>

      <ol className={styles.queue}>
        {summary.actions.map((a, i) => (
          <li key={`${a.claimId}-${a.reason}-${i}`} className={styles.item}>
            <Link href={a.href} className={styles.itemLink}>
              <div className={styles.itemMain}>
                <div className={styles.itemHead}>
                  <SeverityChip severity={a.severity} />
                  <span className={styles.headline}>{a.headline}</span>
                </div>
                <p className={styles.detail}>{a.detail}</p>
                <div className={styles.vessel}>
                  <strong>{a.vessel}</strong>
                  <span className={styles.sep}>·</span>
                  <span className="tnum">{a.voyageRef}</span>
                  <span className={styles.sep}>·</span>
                  <span>{a.port}</span>
                </div>
              </div>
              {a.amountAtStake > 0 && (
                <div className={`${styles.amount} tnum`}>
                  {a.currency}{" "}
                  {a.amountAtStake.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </div>
              )}
            </Link>
          </li>
        ))}
      </ol>
    </>
  );
}

function QueueSkeleton() {
  return (
    <div className={styles.skeletonWrap}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className={styles.skeleton} />
      ))}
    </div>
  );
}

export default function VoyageConsolePage() {
  return (
    <div>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Voyage console</h1>
        <p className={styles.pageSub}>
          Everything across the book that needs attention, ranked by urgency then by money.
          Irreversible deadlines come first — a time bar you miss is gone, a large claim can
          wait a day.
        </p>
      </header>
      <Card>
        <div className={styles.body}>
          <Suspense fallback={<QueueSkeleton />}>
            <TriageQueue />
          </Suspense>
        </div>
      </Card>
    </div>
  );
}
