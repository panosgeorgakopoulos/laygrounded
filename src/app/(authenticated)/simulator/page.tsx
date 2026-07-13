"use client";

// Fixture Risk Simulator — price laytime terms against real historical
// weather before fixing. Form in, distribution out.

import { useState } from "react";
import styles from "./Simulator.module.css";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAYS_BASES = ["SHINC", "SHEX", "SHEX-UU", "WWDSHEX-EIU", "SSHEX", "SSHEX-UU", "WWDSSHEX-EIU"];

interface YearOutcome {
  year: number;
  stoppageHours: number;
  usedHours: number;
  demurrageAmount: number;
  despatchAmount: number;
  net: number;
}

interface Report {
  portLabel: string;
  month: number;
  opsDurationHours: number;
  outcomes: YearOutcome[];
  skippedYears: number[];
  stats: {
    meanNet: number;
    medianNet: number;
    p90Net: number;
    meanStoppageHours: number;
    worstYear: number | null;
    bestYear: number | null;
    demurrageProbability: number;
  };
  assumptions: string[];
}

function money(v: number, currency: string): string {
  const abs = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "−" : ""}${currency} ${abs}`;
}

function NetCell({ value, currency }: { value: number; currency: string }) {
  if (value === 0) return <span className={`${styles.muted} tnum`}>—</span>;
  return (
    <span className={`${value > 0 ? styles.amountDem : styles.amountDes} tnum`}>
      {value > 0 ? "+" : ""}
      {money(value, currency)}
    </span>
  );
}

export default function SimulatorPage() {
  const [port, setPort] = useState("Santos");
  const [month, setMonth] = useState(3);
  const [opsHours, setOpsHours] = useState(96);
  const [allowedHours, setAllowedHours] = useState(72);
  const [daysBasis, setDaysBasis] = useState("WWDSHEX-EIU");
  const [demRate, setDemRate] = useState(25000);
  const [desRate, setDesRate] = useState(12500);
  const [currency] = useState("USD");
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/simulator/fixture-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          port,
          month,
          opsDurationHours: opsHours,
          cpTerms: {
            laytime_allowed_hours: allowedHours,
            days_basis: daysBasis,
            demurrage_rate: demRate,
            despatch_rate: desRate,
            currency,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.error === "PORT_NOT_FOUND" ? "Port not found — try a different spelling." : body.error || "Simulation failed"
        );
      }
      setReport((await res.json()).report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Fixture Risk Simulator</h1>
        <p className={styles.pageSub}>
          Prices a set of laytime terms against the last years of <em>actual</em>{" "}
          weather at the port: each historical year is replayed through the
          deterministic engine, producing a real demurrage distribution — not a
          rule of thumb. Use it before you fix.
        </p>
      </header>

      <div className={styles.formCard}>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label className={styles.label}>Port</label>
            <input className={styles.input} value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Laycan month</label>
            <select className={styles.select} value={month} onChange={(e) => setMonth(parseInt(e.target.value, 10))}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Cargo ops (working hrs)</label>
            <input
              className={`${styles.input} tnum`}
              type="number" min={12} max={480}
              value={opsHours}
              onChange={(e) => setOpsHours(parseInt(e.target.value || "0", 10))}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Laytime allowed (hrs)</label>
            <input
              className={`${styles.input} tnum`}
              type="number" min={1} max={1000}
              value={allowedHours}
              onChange={(e) => setAllowedHours(parseInt(e.target.value || "0", 10))}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Days basis</label>
            <select className={styles.select} value={daysBasis} onChange={(e) => setDaysBasis(e.target.value)}>
              {DAYS_BASES.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Demurrage rate /day</label>
            <input
              className={`${styles.input} tnum`}
              type="number" min={0}
              value={demRate}
              onChange={(e) => setDemRate(parseFloat(e.target.value || "0"))}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Despatch rate /day</label>
            <input
              className={`${styles.input} tnum`}
              type="number" min={0}
              value={desRate}
              onChange={(e) => setDesRate(parseFloat(e.target.value || "0"))}
            />
          </div>
          <div className={styles.field}>
            <button className={styles.runBtn} onClick={run} disabled={running}>
              {running ? "SIMULATING…" : "RUN SIMULATION"}
            </button>
          </div>
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </div>

      {report && (
        <>
          <div className={styles.tileRow}>
            <div className={`${styles.tile} ${styles.tileHero}`}>
              <div className={styles.tileLabel}>Median outcome</div>
              <div className={styles.tileValue}>{money(report.stats.medianNet, currency)}</div>
              <div className={styles.tileNote}>
                net position at {report.portLabel}, {MONTHS[report.month - 1]}
              </div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileLabel}>Mean outcome</div>
              <div className={styles.tileValue}>{money(report.stats.meanNet, currency)}</div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileLabel}>P90 (bad year)</div>
              <div className={styles.tileValue}>{money(report.stats.p90Net, currency)}</div>
              <div className={styles.tileNote}>
                worst weather year: {report.stats.worstYear ?? "—"}
              </div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileLabel}>Demurrage probability</div>
              <div className={styles.tileValue}>
                {(report.stats.demurrageProbability * 100).toFixed(0)}%
              </div>
              <div className={styles.tileNote}>
                avg weather stoppage {report.stats.meanStoppageHours}h
              </div>
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Year-by-year replay</div>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Year</th>
                    <th style={{ textAlign: "right" }}>Weather stoppage</th>
                    <th style={{ textAlign: "right" }}>Laytime used</th>
                    <th style={{ textAlign: "right" }}>Demurrage</th>
                    <th style={{ textAlign: "right" }}>Despatch</th>
                    <th style={{ textAlign: "right" }}>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {report.outcomes.map((o) => (
                    <tr key={o.year}>
                      <td className="tnum">{o.year}</td>
                      <td className="tnum" style={{ textAlign: "right" }}>{o.stoppageHours}h</td>
                      <td className="tnum" style={{ textAlign: "right" }}>{o.usedHours}h</td>
                      <td className="tnum" style={{ textAlign: "right" }}>
                        {o.demurrageAmount > 0 ? money(o.demurrageAmount, currency) : "—"}
                      </td>
                      <td className="tnum" style={{ textAlign: "right" }}>
                        {o.despatchAmount > 0 ? money(o.despatchAmount, currency) : "—"}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <NetCell value={o.net} currency={currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.skippedYears.length > 0 && (
              <div className={styles.muted} style={{ marginTop: "0.5rem" }}>
                Skipped (no archive data): {report.skippedYears.join(", ")}
              </div>
            )}
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>Assumptions</div>
            <ul className={styles.assumptions}>
              {report.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
