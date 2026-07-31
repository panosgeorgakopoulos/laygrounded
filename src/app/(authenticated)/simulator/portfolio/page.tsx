"use client";

// Portfolio demurrage risk — the whole book, priced with correlated weather.
//
// The page leads with the one number a per-voyage model cannot produce: the
// correlation uplift. Everything else is there to make that number credible
// (the two distributions side by side) and actionable (which fixture drives the
// tail).

import { useCallback, useEffect, useState } from "react";
import PortfolioOverlayChart from "@/components/laygrounded/PortfolioOverlayChart";
import type { HistogramBin } from "@/lib/risk/chart-model";
import styles from "./Portfolio.module.css";

interface Estimate {
  value: number;
  standardError: number;
  ci95: [number, number];
}

interface Distribution {
  expectedCost: Estimate;
  p50Cost: Estimate;
  p90Cost: Estimate;
  p95Cost: Estimate;
  expectedShortfall90: Estimate;
  worstCase: number;
  bestCase: number;
  anyDemurrageProbability: Estimate;
  histogram: HistogramBin[];
}

interface VoyageContribution {
  voyageId: string;
  label: string;
  expectedCost: Estimate;
  p90Cost: Estimate;
  demurrageProbability: Estimate;
  tailContributionShare: number;
  tailContributionAmount: number;
}

interface Report {
  seed: string;
  trials: number;
  voyageCount: number;
  currency: string;
  decisionGrade: boolean;
  clusters: Array<{ id: string; voyageIds: string[]; label: string }>;
  correlated: Distribution;
  independent: Distribution;
  perVoyage: VoyageContribution[];
  sumOfIndividualP90: number;
  correlationUplift: number;
  diversification: number;
  diversificationVerdict: "benefit" | "penalty" | "neutral";
  notes: string[];
  caveats: string[];
  skipped: Array<{ id: string; reason: string }>;
}

function money(v: number, currency: string): string {
  return `${v < 0 ? "−" : ""}${currency} ${Math.abs(v).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

export default function PortfolioRiskPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [includeSynthetic, setIncludeSynthetic] = useState(false);
  const [trials, setTrials] = useState(4000);
  const [radiusKm, setRadiusKm] = useState(500);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setStage("Replaying stored assessments…");
    const t = setTimeout(() => setStage(`Simulating ${trials.toLocaleString("en-US")} quarters…`), 700);

    try {
      const res = await fetch("/api/risk/portfolio-var", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trials,
          includeNonDecisionGrade: includeSynthetic,
          clustering: { radiusKm, requireTimeOverlap: true },
        }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // The API's remedies are actionable, so they are shown rather than
        // flattened into "something went wrong".
        // The hint must match WHICH empty case this is. "Run some assessments
        // first" is wrong when five exist and are merely filtered out — it
        // sends the operator to do work they have already done, past a
        // checkbox that would have shown them the answer.
        const excludedNotAbsent =
          body.error === "NO_ASSESSMENTS" &&
          typeof body.message === "string" &&
          body.message.includes("excluded by default");

        setError({
          message: body.message || body.error || "The portfolio assessment failed.",
          hint: excludedNotAbsent
            ? "Tick 'Include synthetic-data assessments' above to see them."
            : body.error === "NO_ASSESSMENTS"
              ? "Run some pre-arrival assessments first, then come back."
              : undefined,
        });
        setReport(null);
        return;
      }
      setReport(body as Report);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(t);
      setRunning(false);
      setStage("");
    }
  }, [trials, includeSynthetic, radiusKm]);

  // Load once on mount. `run` is stable per control set and the controls invoke
  // it themselves, so this must not re-fire when they change — otherwise
  // changing the trial count would kick off a second simulation mid-flight.
  const [loadedOnce, setLoadedOnce] = useState(false);
  useEffect(() => {
    if (loadedOnce) return;
    setLoadedOnce(true);
    void run();
  }, [loadedOnce, run]);

  const c = report?.correlated;
  const i = report?.independent;
  const cur = report?.currency ?? "USD";
  const esUplift =
    c && i ? c.expectedShortfall90.value - i.expectedShortfall90.value : 0;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Portfolio demurrage risk</h1>
        <p className={styles.pageSub}>
          Your whole book, priced with the weather your vessels actually share. Five ships in
          one storm lose together — a model that prices them one at a time cannot see that,
          and the gap is the number below.
        </p>
      </header>

      <section className={styles.controls} aria-label="Simulation controls">
        <div className={styles.field}>
          <label className={styles.label} htmlFor="trials">Trials</label>
          <select id="trials" className={styles.select} value={trials}
            onChange={(e) => setTrials(Number(e.target.value))}>
            <option value={1000}>1,000 (fast)</option>
            <option value={4000}>4,000 (default)</option>
            <option value={10000}>10,000 (tighter)</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="radius">Weather system radius</label>
          <select id="radius" className={styles.select} value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value))}>
            <option value={250}>250 km (tight)</option>
            <option value={500}>500 km (synoptic)</option>
            <option value={1000}>1,000 km (broad)</option>
          </select>
        </div>
        <label className={styles.checkbox}>
          <input type="checkbox" checked={includeSynthetic}
            onChange={(e) => setIncludeSynthetic(e.target.checked)} />
          Include synthetic-data assessments
        </label>
        <button className={styles.runBtn} onClick={run} disabled={running}>
          {running ? "Running…" : "Re-run"}
        </button>
        {running && stage && (
          <span className={styles.stage} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" />
            {stage}
          </span>
        )}
      </section>

      {error && (
        <div className={styles.error} role="alert">
          <p>{error.message}</p>
          {error.hint && <p className={styles.errorHint}>{error.hint}</p>}
        </div>
      )}

      {running && !report && (
        <div className={styles.skeletonWrap} aria-hidden="true">
          <div className={styles.skeletonRow}>
            <div className={`${styles.skeleton} ${styles.skeletonHero}`} />
            <div className={`${styles.skeleton} ${styles.skeletonTile}`} />
            <div className={`${styles.skeleton} ${styles.skeletonTile}`} />
          </div>
          <div className={`${styles.skeleton} ${styles.skeletonChart}`} />
        </div>
      )}

      {report && c && i && (
        <>
          {!report.decisionGrade && (
            <div className={styles.syntheticBanner} role="alert">
              <strong>Not decision-grade.</strong> At least one assessment in this book was
              built on synthetic congestion. These figures are for testing and demonstration
              only.
            </div>
          )}

          {/* Hero row. The uplift is the one hero figure; the two P90s beside it
              are what it is the difference between. */}
          <section className={styles.heroRow} aria-label="Headline portfolio metrics">
            <div className={styles.upliftCard}>
              <span className={styles.tileLabel}>Correlation uplift (P90)</span>
              <span className={styles.heroValue}>+{money(report.correlationUplift, cur)}</span>
              <span className={styles.upliftTag}>Hidden by per-voyage models</span>
              <span className={styles.tileFoot}>
                Expected Shortfall uplift +{money(esUplift, cur)} — the coherent tail measure,
                and the one to quote when the two disagree.
              </span>
            </div>

            <div className={styles.tile}>
              <span className={styles.tileLabel}>Correlated</span>
              <span className={styles.tileValue}>{money(c.p90Cost.value, cur)}</span>
              <span className={styles.tileSub}>P90 · shared weather</span>
              <span className={styles.tileFoot}>
                ES90 {money(c.expectedShortfall90.value, cur)}
                <br />
                Expected {money(c.expectedCost.value, cur)}
              </span>
            </div>

            <div className={styles.tile}>
              <span className={styles.tileLabel}>Independent baseline</span>
              <span className={`${styles.tileValue} ${styles.muted}`}>
                {money(i.p90Cost.value, cur)}
              </span>
              <span className={styles.tileSub}>P90 · private weather</span>
              <span className={styles.tileFoot}>
                ES90 {money(i.expectedShortfall90.value, cur)}
                <br />
                Expected {money(i.expectedCost.value, cur)}
              </span>
            </div>
          </section>

          <section className={styles.chartCard} aria-label="Outcome distributions">
            <PortfolioOverlayChart
              correlated={c.histogram}
              independent={i.histogram}
              trials={report.trials}
              currency={cur}
              correlatedP90={c.p90Cost.value}
              independentP90={i.p90Cost.value}
            />
          </section>

          <section className={styles.bookRow} aria-label="Book composition">
            {[
              { k: "Voyages", v: String(report.voyageCount) },
              { k: "Weather systems", v: String(report.clusters.length) },
              { k: "Sum of individual P90s", v: money(report.sumOfIndividualP90, cur) },
              {
                k: report.diversificationVerdict === "penalty" ? "Aggregation penalty" : "Diversification benefit",
                v: money(Math.abs(report.diversification), cur),
              },
              { k: "Worst simulated", v: money(c.worstCase, cur) },
            ].map((s) => (
              <div key={s.k} className={styles.stat}>
                <span className={styles.statKey}>{s.k}</span>
                <span className={`${styles.statVal} tnum`}>{s.v}</span>
              </div>
            ))}
          </section>

          {/* Tail decomposition — what makes the maths actionable. */}
          <section className={styles.tailCard} aria-label="Tail decomposition">
            <h2 className={styles.sectionTitle}>What drives the bad case</h2>
            <p className={styles.sectionSub}>
              Share of the worst decile each fixture accounts for, measured over the same
              simulated quarters that formed the tail. The top of this list is where
              re-nomination or cover buys the most. A negative share means that fixture tended
              to earn despatch in those same quarters, offsetting the book rather than adding
              to it.
            </p>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Fixture</th>
                    <th scope="col" className={styles.numCol}>Tail share</th>
                    <th scope="col" className={styles.numCol}>Mean in tail</th>
                    <th scope="col" className={styles.numCol}>Own P90</th>
                    <th scope="col" className={styles.numCol}>P(demurrage)</th>
                  </tr>
                </thead>
                <tbody>
                  {[...report.perVoyage]
                    .sort((a, b) => b.tailContributionShare - a.tailContributionShare)
                    .map((p) => (
                      <tr key={p.voyageId}>
                        <th scope="row" className={styles.rowHead}>
                          {p.label}
                        </th>
                        <td className={styles.numCol}>
                          <span className={styles.barCell}>
                            {/* A NEGATIVE share is meaningful, not an error: in
                                the quarters that formed the tail this fixture
                                averaged a despatch, so it OFFSETS the book's
                                bad case. A zero-width bar reads as broken, so
                                negatives get a word instead of a stub. */}
                            {p.tailContributionShare < 0 ? (
                              <span className={styles.offsets}>offsets</span>
                            ) : (
                              <span
                                className={styles.bar}
                                style={{
                                  width: `${Math.min(100, p.tailContributionShare * 100)}%`,
                                }}
                                aria-hidden="true"
                              />
                            )}
                            <span
                              className={`tnum ${p.tailContributionShare < 0 ? styles.negShare : ""}`}
                            >
                              {(p.tailContributionShare * 100).toFixed(1)}%
                            </span>
                          </span>
                        </td>
                        <td className={`${styles.numCol} tnum`}>
                          {money(p.tailContributionAmount, cur)}
                        </td>
                        <td className={`${styles.numCol} tnum`}>{money(p.p90Cost.value, cur)}</td>
                        <td className={`${styles.numCol} tnum`}>
                          {(p.demurrageProbability.value * 100).toFixed(0)}%
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.auditCard} aria-label="Method and provenance">
            <h2 className={styles.sectionTitle}>Method &amp; provenance</h2>
            <dl className={styles.auditGrid}>
              <div className={styles.auditItem}>
                <dt>Seed</dt>
                {/* The seed concatenates every voyage id, so it runs to
                    hundreds of characters and swamped the panel. Truncated for
                    reading, full value on hover and in the DOM so it can still
                    be copied for an audit. */}
                <dd className={`${styles.mono} tnum`} title={report.seed}>
                  {report.seed.length > 96 ? `${report.seed.slice(0, 96)}…` : report.seed}
                </dd>
              </div>
              <div className={styles.auditItem}>
                <dt>Trials</dt>
                <dd className="tnum">{report.trials.toLocaleString("en-US")}</dd>
              </div>
              <div className={styles.auditItem}>
                <dt>Weather systems</dt>
                <dd>{report.clusters.map((cl) => cl.label).join(" · ")}</dd>
              </div>
            </dl>

            <ul className={styles.noteList}>
              {[...new Set([...report.notes, ...report.caveats])].map((n, idx) => (
                <li key={idx}>{n}</li>
              ))}
            </ul>

            {report.skipped.length > 0 && (
              <p className={styles.skipped}>
                {report.skipped.length} assessment
                {report.skipped.length === 1 ? " was" : "s were"} excluded: {report.skipped[0].reason}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
