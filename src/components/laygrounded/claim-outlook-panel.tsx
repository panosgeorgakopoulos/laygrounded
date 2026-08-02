"use client";

// Two forward-looking views of the same claim, deliberately side by side.
//
//   LIVE EXPOSURE — what the clock is costing right now, and when the allowance
//   runs out. Computed by bisecting the ENGINE rather than extrapolating a rate,
//   because accrual is not linear: SHEX weekends, excepted periods and weather
//   all stop the clock, so a straight-line projection is wrong by exactly the
//   amount that matters.
//
//   SETTLEMENT EXPECTATION — what claims like this one have historically settled
//   at, from your own book and (when enabled) the anonymised market.
//
// They pair because one is what you are owed and the other is what you are
// likely to get, and a commercial decision needs both. Neither is presented
// without its provenance: an expectation drawn from four claims says so.

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Activity, Clock, Loader2, TrendingUp } from "lucide-react";
import styles from "./ClaimOutlookPanel.module.css";

interface Band {
  p25: number;
  median: number;
  p75: number;
}

interface Expectation {
  scope: "own" | "market";
  verdict: "estimated" | "insufficient_data";
  tier: string | null;
  sampleSize: number;
  sampleCompanies: number;
  recoveryPct: Band | null;
  daysToSettle: Band | null;
  note: string;
  methodology: string;
}

interface ExpectationPair {
  own: Expectation;
  market: Expectation | null;
  marketUnavailableReason: string | null;
}

interface Snapshot {
  state: "not_started" | "laytime_running" | "demurrage_accruing" | "completed";
  asOf: string;
  allowedHours: number;
  usedHours: number;
  remainingHours: number;
  percentConsumed: number;
  onDemurrageHours: number;
  accruedDemurrage: number;
  currency: string;
  laytimeExhaustedAt: string | null;
  unavailableReason?: string | null;
}

const STATE_LABEL: Record<Snapshot["state"], { label: string; cls: string }> = {
  not_started: { label: "Not started", cls: "" },
  laytime_running: { label: "Laytime running", cls: "ok" },
  demurrage_accruing: { label: "On demurrage", cls: "bad" },
  completed: { label: "Completed", cls: "" },
};

function money(v: number, ccy: string): string {
  return `${ccy} ${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function ClaimOutlookPanel({ claimId }: { claimId: string }) {
  const [exposure, setExposure] = useState<Snapshot | null>(null);
  const [expectation, setExpectation] = useState<ExpectationPair | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        fetch(`/api/claims/${claimId}/exposure`).then((r) => r.json()),
        fetch(`/api/claims/${claimId}/settlement-expectation`).then((r) => r.json()),
      ]);
      // Each half is independently optional: a claim can have a live exposure
      // with no settlement history to compare against, and vice versa.
      setExposure(a.exposure?.snapshot ?? a.exposure ?? null);
      setExpectation(b.expectation ?? null);
      setError(null);
    } catch {
      setError("Could not load the outlook for this claim.");
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className={styles.wrap}>
        <p className={styles.loading}>
          <Loader2 size={13} className={styles.spin} /> Loading outlook…
        </p>
      </div>
    );
  }

  const renderExpectation = (e: Expectation, title: string) => (
    <div className={styles.expBlock}>
      <h5 className={styles.expTitle}>{title}</h5>
      {e.verdict === "estimated" && e.recoveryPct ? (
        <>
          <div className={styles.expFigure}>
            <strong className="tnum">{Math.round(e.recoveryPct.median)}%</strong>
            <span className={styles.expRange}>
              of the claim recovered · {Math.round(e.recoveryPct.p25)}–
              {Math.round(e.recoveryPct.p75)}% typical range
            </span>
          </div>
          {e.daysToSettle && (
            <p className={styles.expDays}>
              Settled in <strong className="tnum">{Math.round(e.daysToSettle.median)}</strong> days
              (median)
            </p>
          )}
          <p className={styles.expSample}>
            From {e.sampleSize} settled claim{e.sampleSize === 1 ? "" : "s"}
            {e.scope === "market" && ` across ${e.sampleCompanies} companies`}
            {e.tier && ` · matched on ${e.tier}`}
          </p>
        </>
      ) : (
        <p className={styles.expNone}>{e.note}</p>
      )}
      <p className={styles.methodology}>{e.methodology}</p>
    </div>
  );

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h3 className={styles.title}>
          <TrendingUp size={15} /> Outlook
        </h3>
      </header>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}

      <div className={styles.columns}>
        {/* ── Live exposure ──────────────────────────────────────────── */}
        <section className={styles.col}>
          <h4 className={styles.colTitle}>
            <Activity size={13} /> Live exposure
          </h4>

          {!exposure || exposure.unavailableReason ? (
            <p className={styles.none}>
              {exposure?.unavailableReason ??
                "No live exposure — this claim has no confirmed NOR, so laytime cannot have begun."}
            </p>
          ) : (
            <>
              <div className={styles.stateRow}>
                <span
                  className={`${styles.state} ${
                    STATE_LABEL[exposure.state].cls === "bad"
                      ? styles.bad
                      : STATE_LABEL[exposure.state].cls === "ok"
                        ? styles.ok
                        : styles.neutral
                  }`}
                >
                  {STATE_LABEL[exposure.state].label}
                </span>
                {exposure.accruedDemurrage > 0 && (
                  <strong className={`${styles.accrued} tnum`}>
                    {money(exposure.accruedDemurrage, exposure.currency)}
                  </strong>
                )}
              </div>

              <div className={styles.meter} aria-hidden="true">
                <div
                  className={`${styles.meterFill} ${
                    exposure.percentConsumed >= 100 ? styles.meterOver : ""
                  }`}
                  style={{ width: `${Math.min(100, exposure.percentConsumed)}%` }}
                />
              </div>
              <p className={styles.meterLabel}>
                <span className="tnum">{exposure.usedHours.toFixed(1)}</span> of{" "}
                <span className="tnum">{exposure.allowedHours}</span> hours used
                {exposure.remainingHours > 0 && (
                  <>
                    {" "}
                    · <span className="tnum">{exposure.remainingHours.toFixed(1)}</span> remaining
                  </>
                )}
                {exposure.onDemurrageHours > 0 && (
                  <>
                    {" "}
                    · <span className="tnum">{exposure.onDemurrageHours.toFixed(1)}</span> on
                    demurrage
                  </>
                )}
              </p>

              {exposure.laytimeExhaustedAt && (
                <p className={styles.exhausted}>
                  <Clock size={12} /> Allowance{" "}
                  {Date.parse(exposure.laytimeExhaustedAt) > Date.now() ? "runs out" : "ran out"}{" "}
                  <strong>
                    {new Date(exposure.laytimeExhaustedAt)
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")}
                    Z
                  </strong>
                </p>
              )}

              <p className={styles.methodology}>
                Found by bisecting the engine, not by extrapolating a rate — weekends, excepted
                periods and weather all stop the clock, so a straight line would be wrong by
                exactly the amount that matters.
              </p>
            </>
          )}
        </section>

        {/* ── Settlement expectation ─────────────────────────────────── */}
        <section className={styles.col}>
          <h4 className={styles.colTitle}>
            <TrendingUp size={13} /> Likely settlement
          </h4>

          {!expectation ? (
            <p className={styles.none}>No settlement history is available for this claim.</p>
          ) : (
            <>
              {renderExpectation(expectation.own, "Your book")}
              {expectation.market ? (
                renderExpectation(expectation.market, "Market")
              ) : (
                <div className={styles.expBlock}>
                  <h5 className={styles.expTitle}>Market</h5>
                  {/* "Disabled" and "not enough data" are different statements
                      and the UI must not present one as the other. */}
                  <p className={styles.expNone}>
                    {expectation.marketUnavailableReason ??
                      "Market expectations are switched off for this deployment."}
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
