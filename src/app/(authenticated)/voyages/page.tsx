import { Suspense } from "react";
import Link from "next/link";
import { Card } from "@/components/core/Card";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { computeStoredPnl } from "@/lib/pnl/pnl-server";
import styles from "./Voyages.module.css";

export const metadata = {
  title: "Voyage P&L · LayGrounded",
  description: "Freight, hire, demurrage and costs as one voyage result.",
};

const STATUS_LABEL: Record<string, string> = {
  estimate: "Estimate",
  actual: "Actual",
  closed: "Closed",
};

interface VoyageRow {
  id: string;
  vessel: string;
  voyage_ref: string;
  charter_type: string;
  status: string;
  currency: string;
  netResult: number | null;
  tcePerDay: number | null;
  incomplete: boolean;
}

async function loadVoyages(): Promise<VoyageRow[]> {
  const auth = await requireAuth();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("voyage_pnl")
    .select("id, vessel, voyage_ref, charter_type, status, currency")
    .eq("company_id", auth.companyId)
    .order("updated_at", { ascending: false });
  if (error) throw error;

  // Each row is recomputed rather than read from its last snapshot: a linked
  // claim's calculation can move after a snapshot was taken, and a list showing
  // yesterday's TCE beside today's claims is worse than no list.
  const rows: VoyageRow[] = [];
  for (const v of data ?? []) {
    try {
      const { result } = await computeStoredPnl(v.id, supabase);
      rows.push({
        ...v,
        netResult: result.netResult,
        tcePerDay: result.tcePerDay,
        incomplete: result.warnings.length > 0,
      });
    } catch {
      // A voyage whose terms no longer validate still belongs in the list —
      // it is precisely the one somebody needs to open and fix.
      rows.push({ ...v, netResult: null, tcePerDay: null, incomplete: true });
    }
  }
  return rows;
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

async function VoyageList() {
  const voyages = await loadVoyages();

  if (voyages.length === 0) {
    return (
      <div className={styles.empty}>
        <h2 className={styles.emptyTitle}>No voyages yet</h2>
        <p className={styles.emptyBody}>
          A voyage P&amp;L gathers freight or hire, costs, and the demurrage from every
          port call on the voyage into one result — and the TCE the market compares on.
        </p>
      </div>
    );
  }

  return (
    <ol className={styles.list}>
      {voyages.map((v) => (
        <li key={v.id} className={styles.item}>
          <Link href={`/voyages/${v.id}`} className={styles.itemLink}>
            <div className={styles.itemMain}>
              <div className={styles.itemHead}>
                <span className={`${styles.chip} ${styles[v.status] ?? ""}`}>
                  {STATUS_LABEL[v.status] ?? v.status}
                </span>
                <strong className={styles.vessel}>{v.vessel}</strong>
                <span className={styles.sep}>·</span>
                <span className="tnum">{v.voyage_ref}</span>
                <span className={styles.sep}>·</span>
                <span className={styles.charterType}>
                  {v.charter_type === "time" ? "Time charter" : "Voyage charter"}
                </span>
              </div>
              {v.incomplete && (
                <p className={styles.incomplete}>Incomplete — open to see what is missing.</p>
              )}
            </div>
            <div className={styles.itemFigures}>
              <div className={styles.figure}>
                <span className={`${styles.figureValue} tnum`}>
                  {v.tcePerDay === null ? "—" : money(v.tcePerDay, v.currency)}
                </span>
                <span className={styles.figureLabel}>TCE / day</span>
              </div>
              <div className={styles.figure}>
                <span
                  className={`${styles.figureValue} tnum ${
                    (v.netResult ?? 0) < 0 ? styles.negative : ""
                  }`}
                >
                  {v.netResult === null ? "—" : money(v.netResult, v.currency)}
                </span>
                <span className={styles.figureLabel}>Net result</span>
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ol>
  );
}

function ListSkeleton() {
  return (
    <div className={styles.skeletonWrap}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className={styles.skeleton} />
      ))}
    </div>
  );
}

export default function VoyagesPage() {
  return (
    <div>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Voyage P&amp;L</h1>
        <p className={styles.pageSub}>
          Freight or hire, commissions, bunkers, port costs and the demurrage from every
          port call — as one voyage result, with the TCE the market compares on.
        </p>
      </header>
      <Card>
        <div className={styles.body}>
          <Suspense fallback={<ListSkeleton />}>
            <VoyageList />
          </Suspense>
        </div>
      </Card>
    </div>
  );
}
