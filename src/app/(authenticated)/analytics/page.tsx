// Clause P&L analytics — what each charterparty concession costs across the
// book, computed as counterfactual runs of the deterministic engine.

import { Suspense } from "react";
import { Card } from "@/components/core/Card";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { buildClausePnlReport, ClausePnlReport } from "@/lib/analytics/clause-pnl";
import { loadRoiReport } from "@/lib/analytics/roi";
import { PrefixtureIntel } from "@/components/laygrounded/prefixture-intel";
import { RoiCalculator } from "@/components/laygrounded/roi-calculator";
import styles from "./Analytics.module.css";

export const dynamic = "force-dynamic";

function money(amount: number, currency: string): string {
  return `${currency} ${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Signed money with polarity color; the sign carries direction so color is
// never the only channel.
function SignedAmount({ amount, currency }: { amount: number; currency: string }) {
  if (amount === 0) {
    return <span className={`${styles.amountZero} tnum`}>±{money(0, currency)}</span>;
  }
  const cls = amount > 0 ? styles.amountPos : styles.amountNeg;
  return (
    <span className={`${cls} tnum`}>
      {amount > 0 ? "+" : "−"}
      {money(amount, currency)}
    </span>
  );
}

function Tiles({ report }: { report: ClausePnlReport }) {
  return (
    <>
      {report.totalsByCurrency.map((t) => (
        <div key={t.currency} className={styles.tileRow}>
          <div className={`${styles.tile} ${styles.tileHero}`}>
            <div className={styles.tileLabel}>Net outstanding position</div>
            <div className={styles.tileValue}>
              {t.net < 0 ? "−" : ""}
              {money(t.net, t.currency)}
            </div>
            <div className={styles.tileNote}>
              demurrage receivable − despatch payable
            </div>
          </div>
          <div className={styles.tile}>
            <div className={styles.tileLabel}>Demurrage claimed</div>
            <div className={styles.tileValue}>{money(t.demurrage, t.currency)}</div>
          </div>
          <div className={styles.tile}>
            <div className={styles.tileLabel}>Despatch payable</div>
            <div className={styles.tileValue}>{money(t.despatch, t.currency)}</div>
          </div>
          <div className={styles.tile}>
            <div className={styles.tileLabel}>Recovery rate</div>
            <div className={styles.tileValue}>
              {t.recoveryRate === null ? "—" : `${(t.recoveryRate * 100).toFixed(1)}%`}
            </div>
            <div className={styles.tileNote}>
              {t.settledClaimCount > 0
                ? `across ${t.settledClaimCount} settled claim${t.settledClaimCount === 1 ? "" : "s"}`
                : "no settlements recorded yet"}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

async function AnalyticsBody() {
  const auth = await requireAuth();
  const supabase = await createClient();
  // Both reports walk the same book; load them concurrently rather than
  // paying for two sequential passes over the DB.
  const [report, roi] = await Promise.all([
    buildClausePnlReport(auth.companyId, supabase),
    loadRoiReport(auth.companyId, supabase),
  ]);

  // The ROI calculator renders even when Clause P&L has nothing to say: its
  // time-bar queue covers claims the engine cannot price, which is exactly
  // the case that empties the report below.
  if (report.claims.length === 0) {
    return (
      <>
        <RoiCalculator report={roi} />
        <Card>
          <div className={styles.emptyState}>
            No computable claims yet. Clause P&L needs at least one claim with
            confirmed events and valid CP terms.
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <RoiCalculator report={roi} />
      <Tiles report={report} />

      <Card className={styles.sectionCard}>
        <div className={styles.cardPad}>
          <div className={styles.cardTitle}>Clause effects across the book</div>
          <div className={styles.cardDesc}>
            Each row compares your actual outcomes against a counterfactual run of
            the same voyages with that term removed or neutralised. Positive =
            the term moved money toward the owner; negative = toward the charterer.
          </div>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Term</th>
                  <th style={{ textAlign: "right" }}>Claims affected</th>
                  <th style={{ textAlign: "right" }}>Effect on net position</th>
                </tr>
              </thead>
              <tbody>
                {report.aggregates.map((a) => (
                  <tr key={`${a.key}-${a.currency}`}>
                    <td>{a.label}</td>
                    <td style={{ textAlign: "right" }} className="tnum">
                      {a.claimCount}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <SignedAmount amount={a.totalDelta} currency={a.currency} />
                    </td>
                  </tr>
                ))}
                {report.aggregates.length === 0 && (
                  <tr>
                    <td colSpan={3} className={styles.muted}>
                      No clause-sensitive terms found on computable claims.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card className={styles.sectionCard}>
        <div className={styles.cardPad}>
          <div className={styles.cardTitle}>Per-claim breakdown</div>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Vessel / voyage</th>
                  <th>Port</th>
                  <th>Form</th>
                  <th>Basis</th>
                  <th style={{ textAlign: "right" }}>Net position</th>
                  <th style={{ textAlign: "right" }}>Settled</th>
                  <th>Largest clause effect</th>
                </tr>
              </thead>
              <tbody>
                {report.claims.map((c) => {
                  const top = [...c.clauseEffects].sort(
                    (a, b) => Math.abs(b.deltaNet) - Math.abs(a.deltaNet)
                  )[0];
                  return (
                    <tr key={c.claimId}>
                      <td>
                        {c.vessel}{" "}
                        <span className={`${styles.muted} tnum`}>{c.voyageRef}</span>
                      </td>
                      <td>{c.port}</td>
                      <td>{c.cpForm === "ASBATANKVOY" ? "Asbatankvoy" : "GENCON 94"}</td>
                      <td className="tnum">{c.daysBasis}</td>
                      <td style={{ textAlign: "right" }}>
                        <SignedAmount amount={c.net} currency={c.currency} />
                      </td>
                      <td style={{ textAlign: "right" }} className="tnum">
                        {c.settledAmount != null ? money(c.settledAmount, c.currency) : "—"}
                      </td>
                      <td>
                        {top ? (
                          <>
                            {top.label}{" "}
                            <SignedAmount amount={top.deltaNet} currency={c.currency} />
                          </>
                        ) : (
                          <span className={styles.muted}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.skippedClaims > 0 && (
            <div className={styles.cardDesc} style={{ marginTop: "0.75rem", marginBottom: 0 }}>
              {report.skippedClaims} claim{report.skippedClaims === 1 ? "" : "s"} skipped
              (no confirmed events or invalid CP terms).
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

export default function AnalyticsPage() {
  return (
    <div>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Clause P&L</h1>
        <p className={styles.pageSub}>
          The deterministic engine re-runs every voyage under counterfactual terms
          to show what each charterparty concession is actually worth — ammunition
          for the next fixture negotiation.
        </p>
      </header>
      <Suspense fallback={<Card><div className={styles.emptyState}>Computing counterfactuals…</div></Card>}>
        <AnalyticsBody />
      </Suspense>

      <Card className={styles.sectionCard}>
        <div className={styles.cardPad}>
          <PrefixtureIntel />
        </div>
      </Card>
    </div>
  );
}
