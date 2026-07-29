import { Suspense } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Card } from "@/components/core/Card";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { computeTimeBar } from "@/lib/time-bar";
import { triageBook, type TriageClaimInput, type TriageSeverity } from "@/lib/console/triage";
import { loadCompanyExposure, type ClaimExposure } from "@/lib/voyage/exposure-server";
import { LiveExposureMeter } from "@/components/laygrounded/live-exposure-meter";
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

/**
 * Non-working days inferred from statements of facts and still awaiting review.
 *
 * Surfaced on the console because they are invisible everywhere else until
 * someone opens the right voyage: they sit pending, excluded from every
 * calculation, and a queue nobody is told about is a queue nobody clears.
 */
async function loadPendingCalendarDays(companyId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("port_calendar_days")
    .select("id, calendar_date, observed_claim_id, port_calendars!inner(port_label, company_id)")
    .eq("status", "pending")
    .eq("port_calendars.company_id", companyId);

  // A widget must never break the console it sits on.
  if (error || !data) return { total: 0, ports: [] as string[], firstClaimId: null };

  const rows = data as unknown as Array<Record<string, any>>;
  const ports = new Set<string>();
  let firstClaimId: string | null = null;
  for (const r of rows) {
    const cal = Array.isArray(r.port_calendars) ? r.port_calendars[0] : r.port_calendars;
    if (cal?.port_label) ports.add(cal.port_label);
    if (!firstClaimId && r.observed_claim_id) firstClaimId = r.observed_claim_id;
  }
  return { total: rows.length, ports: [...ports], firstClaimId };
}

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
  if (claims.length === 0) {
    return {
      summary: triageBook([]),
      totalClaims: 0,
      pendingCalendar: { total: 0, ports: [] as string[], firstClaimId: null },
      exposures: [] as ClaimExposure[],
    };
  }

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

  const pendingCalendar = await loadPendingCalendarDays(auth.companyId);

  // Live exposure prices each voyage through the engine, so it is the most
  // expensive thing on this page. A failure here must not take the triage queue
  // with it — the queue is the console's reason to exist, the meter is an
  // addition to it.
  let exposures: ClaimExposure[] = [];
  try {
    exposures = await loadCompanyExposure(auth.companyId, supabase);
  } catch {
    exposures = [];
  }

  return {
    summary: triageBook(inputs),
    totalClaims: claims.length,
    pendingCalendar,
    exposures,
  };
}

function PendingCalendarWidget({
  pending,
}: {
  pending: { total: number; ports: string[]; firstClaimId: string | null };
}) {
  if (pending.total === 0) return null;

  // Links to the voyage the days were observed on when there is one, because
  // that is where the decision has context; otherwise to the master list.
  const href = pending.firstClaimId
    ? `/claims/${pending.firstClaimId}/workspace`
    : "/settings";

  return (
    <div className={styles.pendingWidget}>
      <div className={styles.pendingBody}>
        <span className={styles.pendingCount}>{pending.total}</span>
        <div>
          <p className={styles.pendingTitle}>
            possible non-working day{pending.total === 1 ? "" : "s"} awaiting review
            {pending.ports.length > 0 && (
              <> at {pending.ports.slice(0, 3).join(", ")}
                {pending.ports.length > 3 && ` +${pending.ports.length - 3} more`}</>
            )}
          </p>
          <p className={styles.pendingSub}>
            Inferred from your statements of facts. They are excluded from every calculation
            until approved, so affected claims may currently overstate laytime used.
          </p>
        </div>
      </div>
      <Link href={href} className={styles.pendingAction}>
        Review
      </Link>
    </div>
  );
}

function SeverityChip({ severity }: { severity: TriageSeverity }) {
  return (
    <span className={`${styles.chip} ${styles[severity]}`}>{severity.toUpperCase()}</span>
  );
}

async function TriageQueue() {
  const { summary, totalClaims, pendingCalendar, exposures } = await loadTriage();

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
      <>
        <PendingCalendarWidget pending={pendingCalendar} />
        {/* Shown even with an empty queue: a voyage burning laytime right now
            needs no triage action, and "the book is clear" would otherwise be
            the only thing on screen while money accrues. */}
        <LiveExposureMeter exposures={exposures} />
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
      </>
    );
  }

  return (
    <>
      <PendingCalendarWidget pending={pendingCalendar} />
      <LiveExposureMeter exposures={exposures} />

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
