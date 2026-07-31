"use client";

// Terminal efficiency: what the berth achieved, and what the gap is worth.
//
// THE FRAMING IS THE FEATURE. The headline number is a priced NEGOTIATING
// POSITION — a commercial claim against the terminal operator — and not a
// deduction from the counterparty's laytime. A stipulated rate derives the
// laytime allowance rather than warranting the terminal, so deducting the
// shortfall would double-count the rate and reverse the risk the parties
// allocated. The page says that where the number is, not in a footnote.

import { use, useCallback, useEffect, useState } from "react";
import styles from "./Efficiency.module.css";

interface RateComparison {
  label: string;
  benchmarkTonnesPerDay: number;
  achievedTonnesPerDay: number;
  shortfallTonnesPerDay: number;
  shortfallPct: number;
  hoursLost: number;
  source: string;
}

interface Attribution {
  achieved: {
    tonnesPerDay: number;
    basis: "gross" | "net";
    hoursUsed: number;
    quantity: { tonnes: number; raw: string; confident: boolean };
    workingTime: {
      grossHours: number;
      netHours: number;
      interruptions: { weatherHours: number; shiftingHours: number; exceptedHours: number };
    };
  };
  contractual: RateComparison | null;
  market: RateComparison | null;
  marketUnavailableReason: string | null;
  attributedTo: string;
  deductibleHours: number;
  shortfallValue: number;
  currency: string;
  statement: string;
  evidence: Array<{ clause_ref: string; finding: string }>;
  caveats: string[];
}

interface Payload {
  vessel: string;
  port: string;
  terminalName: string | null;
  cargo: string | null;
  operation: "loading" | "discharge";
  attribution: Attribution;
}

const num = (n: number, dp = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export default function ClaimEfficiencyPage({
  params,
}: {
  params: Promise<{ claimId: string }>;
}) {
  const { claimId } = use(params);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [basis, setBasis] = useState<"net" | "gross">("net");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/efficiency`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basis }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError({
          message: body.message || body.error || "Could not assess terminal efficiency.",
          hint:
            body.error === "RATE_UNAVAILABLE"
              ? `Cargo on file: ${body.cargo ?? "none"}`
              : undefined,
        });
        setData(null);
        return;
      }
      setData(body as Payload);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [claimId, basis]);

  useEffect(() => {
    void load();
  }, [load]);

  const a = data?.attribution;
  const primary = a?.contractual ?? a?.market ?? null;
  const behind = (primary?.hoursLost ?? 0) > 0;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Terminal efficiency</h1>
        {data && (
          <p className={styles.pageSub}>
            {data.vessel} · {data.port}
            {data.terminalName ? ` / ${data.terminalName}` : ""} ·{" "}
            {data.operation === "discharge" ? "Discharge" : "Loading"}
          </p>
        )}
      </header>

      {loading && <div className={`${styles.skeleton} ${styles.skeletonBlock}`} aria-hidden="true" />}

      {error && (
        <div className={styles.error} role="alert">
          <p>{error.message}</p>
          {error.hint && <p className={styles.errorHint}>{error.hint}</p>}
        </div>
      )}

      {data && a && (
        <>
          {/* The headline, with its own framing attached. */}
          <section
            className={`${styles.headline} ${behind ? styles.headlineBehind : styles.headlineOk}`}
            aria-label="Priced negotiating position"
          >
            <span className={styles.headlineLabel}>
              {behind ? "Priced negotiating position" : "Terminal met the agreed rate"}
            </span>
            <span className={styles.headlineValue}>
              {a.currency} {num(a.shortfallValue)}
            </span>
            {behind && (
              <p className={styles.notDeduction}>
                <strong>This is a commercial metric for terminal recovery, NOT an automatic
                deduction from the counterparty&apos;s laytime.</strong>{" "}
                A stipulated rate derives the laytime allowance rather than warranting the
                terminal&apos;s performance, so slow working by the charterer&apos;s terminal is the
                charterer&apos;s risk and is what demurrage prices. Deducting it would double-count
                the rate.
              </p>
            )}
            <p className={styles.statement}>{a.statement}</p>
          </section>

          {/* Actual vs contractual, the comparison the page exists for. */}
          <section className={styles.rateCard} aria-label="Achieved against benchmarks">
            <div className={styles.rateHead}>
              <h2 className={styles.sectionTitle}>Achieved rate</h2>
              <div className={styles.basisToggle} role="group" aria-label="Rate basis">
                {(["net", "gross"] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`${styles.choice} ${basis === b ? styles.choiceOn : ""}`}
                    aria-pressed={basis === b}
                    onClick={() => setBasis(b)}
                  >
                    {b === "net" ? "Net of stoppages" : "Gross"}
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.bars}>
              {[
                {
                  key: "achieved",
                  label: "Achieved",
                  value: a.achieved.tonnesPerDay,
                  cls: behind ? styles.barBehind : styles.barOk,
                },
                ...(a.contractual
                  ? [
                      {
                        key: "cp",
                        label: "Charterparty",
                        value: a.contractual.benchmarkTonnesPerDay,
                        cls: styles.barBenchmark,
                      },
                    ]
                  : []),
                ...(a.market
                  ? [
                      {
                        key: "market",
                        label: a.market.label,
                        value: a.market.benchmarkTonnesPerDay,
                        cls: styles.barMarket,
                      },
                    ]
                  : []),
              ].map((row, _i, rows) => {
                const max = Math.max(...rows.map((r) => r.value), 1);
                return (
                  <div key={row.key} className={styles.barRow}>
                    <span className={styles.barLabel}>{row.label}</span>
                    <span className={styles.barTrack}>
                      <span
                        className={`${styles.bar} ${row.cls}`}
                        style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
                        aria-hidden="true"
                      />
                    </span>
                    <span className={`${styles.barValue} tnum`}>
                      {num(row.value)} <span className={styles.unit}>MT/day</span>
                    </span>
                  </div>
                );
              })}
            </div>

            {a.contractual && (
              <p className={styles.gapLine}>
                {a.contractual.shortfallPct < 0
                  ? `${Math.abs(a.contractual.shortfallPct)}% below the charterparty rate — ${num(a.contractual.hoursLost, 1)} hours longer than the agreed rate would have taken.`
                  : `${a.contractual.shortfallPct}% above the charterparty rate.`}
              </p>
            )}
          </section>

          {/* Market state, handled explicitly. */}
          <section className={styles.marketCard} aria-label="Market benchmark">
            <h2 className={styles.sectionTitle}>Market benchmark</h2>
            {a.market ? (
              <p className={styles.marketOk}>
                {a.market.label}: <strong>{num(a.market.benchmarkTonnesPerDay)} MT/day</strong> (
                {a.market.source}).
              </p>
            ) : (
              <div className={styles.locked}>
                <span className={styles.lockedTag}>Insufficient data</span>
                <p className={styles.lockedBody}>
                  {a.marketUnavailableReason ??
                    "No comparable calls are available for this lane yet."}
                </p>
                <p className={styles.lockedHint}>
                  Market comparison unlocks automatically as more terminal calls are recorded
                  across companies. The floors exist so an aggregate can never identify an
                  individual counterparty&apos;s book — the contractual comparison above needs no
                  pooled data and is unaffected.
                </p>
              </div>
            )}
          </section>

          <section className={styles.detailGrid} aria-label="How the rate was measured">
            {[
              { k: "Cargo", v: `${num(a.achieved.quantity.tonnes)} MT` },
              { k: `Working time (${a.achieved.basis})`, v: `${num(a.achieved.hoursUsed, 1)} h` },
              { k: "Gross span", v: `${num(a.achieved.workingTime.grossHours, 1)} h` },
              {
                k: "Weather excluded",
                v: `${num(a.achieved.workingTime.interruptions.weatherHours, 1)} h`,
              },
              {
                k: "Shifting excluded",
                v: `${num(a.achieved.workingTime.interruptions.shiftingHours, 1)} h`,
              },
              {
                k: "Deductible from laytime",
                v: `${num(a.deductibleHours, 1)} h`,
              },
            ].map((s) => (
              <div key={s.k} className={styles.stat}>
                <span className={styles.statKey}>{s.k}</span>
                <span className={`${styles.statVal} tnum`}>{s.v}</span>
              </div>
            ))}
          </section>

          {(a.evidence.length > 0 || a.caveats.length > 0) && (
            <section className={styles.notesCard} aria-label="Evidence and limits">
              <h2 className={styles.sectionTitle}>Evidence &amp; limits</h2>
              {a.evidence.length > 0 && (
                <ul className={styles.evidence}>
                  {a.evidence.map((e, i) => (
                    <li key={i}>
                      <span className={styles.clauseRef}>{e.clause_ref}</span>
                      {e.finding}
                    </li>
                  ))}
                </ul>
              )}
              {/* The market-unavailable reason has its own card above; repeating
                  it here made the same sentence appear twice on one screen. */}
              {(() => {
                const shown = a.caveats.filter(
                  (c) => !a.marketUnavailableReason || !c.includes(a.marketUnavailableReason)
                );
                return shown.length > 0 ? (
                  <ul className={styles.caveats}>
                    {shown.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : null;
              })()}
            </section>
          )}
        </>
      )}
    </div>
  );
}
