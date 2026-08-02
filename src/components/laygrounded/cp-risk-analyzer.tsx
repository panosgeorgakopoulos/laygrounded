"use client";

// Paste a charter party, see what it will cost you.
//
// The parser reads what the recap actually says and prices each risky clause
// against the route's own history. Two honesty rules run through the whole
// view, and both matter more than the numbers:
//
//   1. FIELDS THE PARSER DID NOT FIND ARE NAMED. Every figure resting on an
//      unparsed term is indicative, and the panel says which terms those were
//      rather than presenting a complete-looking analysis of a partial read.
//   2. AN UNPRICED RISK IS STILL SHOWN. A structural risk with no historical
//      sample behind it has `expectedCost: null` and a `costBasis` explaining
//      why. Dropping those would make the total look like the whole exposure
//      when it is only the part that could be priced.

import { useState } from "react";
import { AlertCircle, AlertTriangle, FileSearch, Loader2 } from "lucide-react";
import styles from "./CpRiskAnalyzer.module.css";

interface CpRisk {
  key: string;
  severity: "critical" | "high" | "medium" | "low";
  headline: string;
  detail: string;
  expectedCost: number | null;
  costBasis: string;
  recommendation: string;
  clauseRef: string | null;
}

interface AnalyzeResult {
  terms: Record<string, unknown>;
  matched: string[];
  missing: string[];
  parseWarnings: string[];
  report: {
    risks: CpRisk[];
    totalExpectedCost: number | null;
    currency: string;
    sampleSize: number;
    limitations: string[];
  };
  knowledge: Array<{ clauseRef: string; slug: string; title: string }>;
  sampleRoute: { port: string | null; month: number };
}

const SEVERITY_CLASS: Record<CpRisk["severity"], string> = {
  critical: styles.critical,
  high: styles.high,
  medium: styles.medium,
  low: styles.low,
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function CpRiskAnalyzer() {
  const [text, setText] = useState("");
  const [port, setPort] = useState("");
  const [cargo, setCargo] = useState("");
  const [month, setMonth] = useState(new Date().getUTCMonth() + 1);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/prefixture/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          month,
          ...(port.trim() ? { port: port.trim() } : {}),
          ...(cargo.trim() ? { cargo: cargo.trim() } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail ?? json.error ?? "The analysis failed.");
      setResult(json.result as AnalyzeResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The analysis failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <h3 className={styles.title}>
        <FileSearch size={15} /> Charterparty risk analyzer
      </h3>
      <p className={styles.intro}>
        Paste a charter party or fixture recap <strong>before you fix</strong>. The laytime terms
        are extracted and each risky clause is priced against what voyages on this route actually
        did — so a concession can be argued with a number rather than an instinct.
      </p>

      <textarea
        className={styles.textarea}
        rows={6}
        value={text}
        placeholder={
          "Paste the recap or CP text…\n\n" +
          "e.g. LAYTIME 72 HRS SHEX EIU, DEM USD 24,000 PDPR, DESPATCH HALF DEM, WIBON/WIPON/WICCON/WIFPON"
        }
        onChange={(e) => setText(e.target.value)}
      />

      <div className={styles.grid}>
        <label className={styles.field}>
          <span className={styles.label}>
            Port <span className={styles.hint}>optional — the recap&apos;s own is used otherwise</span>
          </span>
          <input
            className={styles.input}
            value={port}
            placeholder="Santos"
            onChange={(e) => setPort(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>
            Cargo <span className={styles.hint}>optional</span>
          </span>
          <input
            className={styles.input}
            value={cargo}
            placeholder="Soybeans"
            onChange={(e) => setCargo(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>
            Laycan month <span className={styles.hint}>drives the seasonal sample</span>
          </span>
          <select
            className={styles.input}
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="button"
        className={styles.primary}
        disabled={running || text.trim().length < 20}
        onClick={() => void analyze()}
      >
        {running ? <Loader2 size={13} className={styles.spin} /> : <FileSearch size={13} />} Analyze
      </button>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {result && (
        <div className={styles.result}>
          <div className={styles.summary}>
            <div>
              <span className={styles.sumLabel}>Priced exposure per voyage</span>
              <strong className={`${styles.sumValue} tnum`}>
                {result.report.totalExpectedCost != null
                  ? `${result.report.currency} ${Math.round(
                      result.report.totalExpectedCost
                    ).toLocaleString("en-US")}`
                  : "not priceable"}
              </strong>
            </div>
            <span className={styles.sample}>
              {result.report.sampleSize} historical voyage
              {result.report.sampleSize === 1 ? "" : "s"}
              {result.sampleRoute.port && ` · ${result.sampleRoute.port}`} ·{" "}
              {MONTHS[result.sampleRoute.month - 1]}
            </span>
          </div>

          {result.missing.length > 0 && (
            <p className={styles.missing}>
              <AlertTriangle size={13} />
              <span>
                <strong>Not found in the text:</strong> {result.missing.join(", ")}. Any figure
                resting on these is indicative — the analysis used a default, not your fixture.
              </span>
            </p>
          )}

          {result.parseWarnings.length > 0 && (
            <ul className={styles.warnings}>
              {result.parseWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <ul className={styles.risks}>
            {result.report.risks.map((r) => (
              <li key={r.key} className={styles.risk}>
                <div className={styles.riskHead}>
                  <span className={`${styles.severity} ${SEVERITY_CLASS[r.severity]}`}>
                    {r.severity}
                  </span>
                  <strong className={styles.headline}>{r.headline}</strong>
                  <span className={`${styles.cost} tnum`}>
                    {r.expectedCost != null
                      ? `${result.report.currency} ${Math.round(r.expectedCost).toLocaleString("en-US")}`
                      : "unpriced"}
                  </span>
                </div>
                <p className={styles.detail}>{r.detail}</p>
                <p className={styles.recommendation}>
                  <strong>Ask for:</strong> {r.recommendation}
                </p>
                <p className={styles.basis}>
                  {r.costBasis}
                  {r.clauseRef && (
                    <>
                      {" · "}
                      <a className={styles.clauseLink} href={`/knowledge?ref=${encodeURIComponent(r.clauseRef)}`}>
                        {r.clauseRef}
                      </a>
                    </>
                  )}
                </p>
              </li>
            ))}
            {result.report.risks.length === 0 && (
              <li className={styles.clean}>
                No priced risks found in this recap against the available sample. That is not the
                same as a clean charterparty — see the limitations below.
              </li>
            )}
          </ul>

          {result.report.limitations.length > 0 && (
            <div className={styles.limitations}>
              <strong>What this analysis does not tell you</strong>
              <ul>
                {result.report.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
