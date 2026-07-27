"use client";

// Lane benchmarking — your book against the market on the same measures.
//
// Deliberately honest about gaps: a metric with too little data on either side
// says so and explains which side is thin, rather than showing a comparison the
// numbers cannot support.

import { useEffect, useState } from "react";
import styles from "./MarketBenchmark.module.css";

interface BenchmarkMetric {
  key: string;
  label: string;
  unit: "hours" | "percent" | "days";
  betterIsLower: boolean;
  yours: number | null;
  market: number | null;
  advantagePct: number | null;
  verdict: "ahead" | "behind" | "inline" | "insufficient_data";
  ownObservations: number;
  marketObservations: number;
  marketCompanies: number;
  note: string | null;
}

interface BenchmarkReport {
  metrics: BenchmarkMetric[];
  portFilter: string | null;
  generatedAt: string;
}

function format(value: number | null, unit: BenchmarkMetric["unit"]): string {
  if (value === null) return "—";
  if (unit === "hours") return `${value}h`;
  if (unit === "days") return `${value}d`;
  return `${value}%`;
}

export function MarketBenchmark() {
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [port, setPort] = useState("");
  const [applied, setApplied] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const qs = applied ? `?port=${encodeURIComponent(applied)}` : "";
      const res = await fetch(`/api/intel/benchmark${qs}`);
      const json = await res.json().catch(() => null);
      if (cancelled) return;
      if (res.ok && json?.metrics) {
        setReport(json);
        setError(null);
      } else {
        setError(json?.error ?? "Could not load the benchmark.");
        setReport({ metrics: [], portFilter: null, generatedAt: "" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applied]);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>Market benchmark</h2>
          <p className={styles.sub}>
            Your median against every other participating company&apos;s, on the same
            measures. Your own voyages are excluded from the market figure, and a lane needs
            at least three independent companies before a market number is shown.
          </p>
        </div>
        <form
          className={styles.filter}
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(port.trim());
          }}
        >
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="Filter by port"
            aria-label="Filter by port"
          />
          <button type="submit">Apply</button>
        </form>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {report === null ? (
        <p className={styles.muted}>Loading…</p>
      ) : (
        <div className={styles.metrics}>
          {report.metrics.map((m) => (
            <div key={m.key} className={styles.metric}>
              <span className={styles.metricLabel}>{m.label}</span>

              {m.verdict === "insufficient_data" ? (
                <>
                  <span className={styles.insufficient}>
                    {m.yours !== null ? format(m.yours, m.unit) : "Not enough data"}
                  </span>
                  <span className={styles.note}>{m.note}</span>
                </>
              ) : (
                <>
                  <div className={styles.comparison}>
                    <span className={`${styles.yours} tnum`}>{format(m.yours, m.unit)}</span>
                    <span className={styles.vs}>vs</span>
                    <span className={`${styles.market} tnum`}>{format(m.market, m.unit)}</span>
                  </div>
                  <span
                    className={
                      m.verdict === "ahead"
                        ? styles.ahead
                        : m.verdict === "behind"
                          ? styles.behind
                          : styles.inline
                    }
                  >
                    {m.verdict === "ahead"
                      ? `▲ ${m.advantagePct}% better than market`
                      : m.verdict === "behind"
                        ? `▼ ${Math.abs(m.advantagePct ?? 0)}% worse than market`
                        : "In line with market"}
                  </span>
                  <span className={styles.note}>
                    {m.ownObservations} of yours · {m.marketObservations} from{" "}
                    {m.marketCompanies} other companies
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
