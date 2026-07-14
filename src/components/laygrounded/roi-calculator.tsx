// ROI Calculator — the three day-one questions, answered from the tenant's
// own book by counterfactual engine runs. Presentational only: the page owns
// auth and loading (see loadRoiReport), so this renders server-side with no
// client JS and no fetch waterfall.

import type { RoiReport } from "@/lib/analytics/roi";
import styles from "./RoiCalculator.module.css";

function money(amount: number, currency: string): string {
  return `${currency} ${Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// One row per currency — book values are never summed across currencies.
function Totals({
  totals,
  emptyLabel,
  signed = false,
}: {
  totals: RoiReport["disputedWeather"]["totals"];
  emptyLabel: string;
  signed?: boolean;
}) {
  if (totals.length === 0) return <div className={styles.heroValue}>{emptyLabel}</div>;
  return (
    <>
      {totals.map((t) => (
        <div key={t.currency} className={styles.heroValue}>
          {signed && t.amount !== 0 ? (t.amount > 0 ? "+" : "−") : ""}
          {money(t.amount, t.currency)}
        </div>
      ))}
    </>
  );
}

export function RoiCalculator({ report }: { report: RoiReport }) {
  const { disputedWeather, basisSwap, timeBar } = report;

  // The SHEX swap is a cost on an owner's book (SHEX excludes Sundays/
  // holidays from laytime, so fewer hours count and less demurrage is
  // earned). Read the direction off the sign rather than assuming, so the
  // headline stays true for a charterer-side book too — and say nothing at
  // all when there is no data, rather than defaulting to "saving" and
  // promising money that may not exist.
  const basisTotal = basisSwap.totals[0]?.amount ?? null;
  const basisCosts = basisTotal !== null && basisTotal < 0;
  const basisDirection = basisTotal === null ? "" : basisCosts ? " (a cost)" : " (a saving)";

  return (
    <section className={styles.wrap}>
      <div className={styles.header}>
        <h2 className={styles.title}>ROI calculator</h2>
        <p className={styles.sub}>
          Your own book, replayed through the deterministic engine. Every figure
          below is a counterfactual run — no estimates, no models. Historical
          metrics cover voyages completed in the last {report.windowMonths} months
          (since {shortDate(report.windowStart)}).
        </p>
      </div>

      <div className={styles.tiles}>
        {/* --- Metric 1: disputed weather --- */}
        <div className={`${styles.tile} ${styles.tileHero}`}>
          <div className={styles.tileLabel}>Demurrage lost to disputed weather</div>
          <Totals totals={disputedWeather.totals} emptyLabel="—" />
          <div className={styles.tileNote}>
            {disputedWeather.claimCount === 0
              ? "No weather stoppage on your book is contradicted by the weather archive."
              : `Recoverable across ${disputedWeather.claimCount} claim${
                  disputedWeather.claimCount === 1 ? "" : "s"
                } whose weather stoppages the ERA5 archive contradicts.`}
          </div>
        </div>

        {/* --- Metric 2: SHEX vs SHINC --- */}
        <div className={styles.tile}>
          <div className={styles.tileLabel}>SHEX instead of SHINC{basisDirection}</div>
          <Totals totals={basisSwap.totals} emptyLabel="—" signed />
          <div className={styles.tileNote}>
            {basisSwap.claimCount === 0
              ? "No SHINC claims in the window to re-run on a SHEX basis."
              : basisCosts
                ? `Switching your ${basisSwap.claimCount} SHINC claim${
                    basisSwap.claimCount === 1 ? "" : "s"
                  } to SHEX would have earned you this much less: SHEX stops the laytime clock on Sundays and holidays, so fewer hours count toward demurrage. The saving here is the charterer's.`
                : `Across ${basisSwap.claimCount} SHINC claim${
                    basisSwap.claimCount === 1 ? "" : "s"
                  } re-run on a SHEX basis.`}
          </div>
        </div>

        {/* --- Metric 3: time bar --- */}
        <div className={styles.tile}>
          <div className={styles.tileLabel}>Claims approaching time bar</div>
          <div className={styles.heroValue}>{timeBar.findings.length}</div>
          <div className={styles.tileNote}>
            {timeBar.findings.length === 0
              ? "Nothing inside the 21-day warning window."
              : timeBar.totals.length > 0
                ? `${timeBar.totals.map((t) => money(t.amount, t.currency)).join(" + ")} at risk within 21 days.`
                : "Deadlines approaching; value not yet computable."}
          </div>
        </div>
      </div>

      {/* --- Time-bar queue: a worklist, soonest first --- */}
      {timeBar.findings.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>Approaching time bar</div>
          <div className={styles.cardDesc}>
            Unsettled claims whose filing deadline falls inside the warning
            window, soonest first. Miss the bar and the claim is gone regardless
            of merit.
          </div>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Vessel / voyage</th>
                  <th>Port</th>
                  <th>Deadline</th>
                  <th className={styles.right}>Days left</th>
                  <th className={styles.right}>Value at risk</th>
                  <th>Pack</th>
                </tr>
              </thead>
              <tbody>
                {timeBar.findings.map((f) => (
                  <tr key={f.claimId}>
                    <td>
                      <a className={styles.link} href={`/claims/${f.claimId}/workspace`}>
                        {f.vessel}
                      </a>
                      <div className={styles.subtle}>{f.voyageRef}</div>
                    </td>
                    <td>{f.port}</td>
                    <td className="tnum">{shortDate(f.deadline)}</td>
                    <td className={`${styles.right} tnum`}>
                      <span
                        className={
                          f.state === "critical" ? styles.critical : styles.warning
                        }
                      >
                        {f.daysRemaining ?? "—"}
                      </span>
                    </td>
                    <td className={`${styles.right} tnum`}>
                      {/* Null = engine can't price it. Say so rather than
                          printing a 0 that reads as "nothing at stake". */}
                      {f.valueAtRisk === null ? (
                        <span className={styles.subtle}>not computable</span>
                      ) : (
                        money(f.valueAtRisk, f.currency)
                      )}
                    </td>
                    <td>
                      {f.packComplete ? (
                        <span className={styles.ok}>complete</span>
                      ) : (
                        <span className={styles.warning}>incomplete</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- Disputed weather detail --- */}
      {disputedWeather.findings.length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardTitle}>Disputed weather, claim by claim</div>
          <div className={styles.cardDesc}>
            Each figure re-runs the voyage with only the contradicted stoppages
            struck out — not all weather on the claim — so it is the money
            attributable to windows the archive says did not happen.
          </div>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Vessel / voyage</th>
                  <th>Port</th>
                  <th className={styles.right}>Disputed windows</th>
                  <th className={styles.right}>Recoverable</th>
                </tr>
              </thead>
              <tbody>
                {disputedWeather.findings.map((f) => (
                  <tr key={f.claimId}>
                    <td>
                      <a className={styles.link} href={`/claims/${f.claimId}/workspace`}>
                        {f.vessel}
                      </a>
                      <div className={styles.subtle}>{f.voyageRef}</div>
                    </td>
                    <td>{f.port}</td>
                    <td className={`${styles.right} tnum`}>{f.windowCount}</td>
                    <td className={`${styles.right} tnum`}>
                      {money(f.recoverable, f.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(report.skippedClaims > 0 || report.outOfWindowClaims > 0) && (
        <p className={styles.footnote}>
          {report.outOfWindowClaims > 0 &&
            `${report.outOfWindowClaims} claim(s) fall outside the ${report.windowMonths}-month window or have no confirmed completion. `}
          {report.skippedClaims > 0 &&
            `${report.skippedClaims} claim(s) could not be priced by the engine and are excluded from the money figures above.`}
        </p>
      )}
    </section>
  );
}
