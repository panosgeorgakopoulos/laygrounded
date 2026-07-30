"use client";

import { useEffect, useState } from "react";
import { CloudRain, Wind, AlertTriangle, Lock, Check } from "lucide-react";
import styles from "./WeatherChecker.module.css";

interface Cargo {
  cargo_key: string;
  label: string;
  precip_mm_per_hr: number | null;
  wind_kn: number | null;
  gust_kn: number | null;
}

interface Block {
  from: string;
  to: string;
  hours: number;
  dimensions: string[];
  reason: string;
}

interface Report {
  port: { query: string; resolved: string; lat: number; lon: number };
  window: { from: string; to: string };
  profile: { cargoKey: string; label: string; sourceLabel: string };
  thresholds: {
    precipMmPerHr: number | null;
    windKn: number | null;
    gustKn: number | null;
    minStoppageMinutes: number;
  };
  totalExceptedHours: number;
  blocks: Block[];
  observedHours: number;
  gapHours: number;
  warnings: string[];
  quota: { used: number; limit: number };
}

const fmt = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ") + "Z";
const dateOnly = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export function WeatherCheckerClient() {
  const [cargoes, setCargoes] = useState<Cargo[]>([]);
  const [port, setPort] = useState("");
  const [cargoKey, setCargoKey] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/tools/weather-checker").then((x) => x.json());
        if (!cancelled) {
          setCargoes(r.cargoes ?? []);
          if (r.cargoes?.[0]) setCargoKey(r.cargoes[0].cargo_key);
        }
      } catch {
        /* the form still works; the select simply stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setReport(null);
    setUnlocked(false);
    try {
      const res = await fetch("/api/tools/weather-checker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          port,
          cargoKey,
          start: new Date(`${start}T00:00:00Z`).toISOString(),
          end: new Date(`${end}T23:59:59Z`).toISOString(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? json.error ?? "Check failed");
      setReport(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailBusy(true);
    try {
      const res = await fetch("/api/tools/weather-checker/lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          context: report
            ? {
                port: report.port.query,
                cargoKey: report.profile.cargoKey,
                start: report.window.from,
                end: report.window.to,
                totalExceptedHours: report.totalExceptedHours,
              }
            : {},
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? "Could not save that address");
      setUnlocked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that address");
    } finally {
      setEmailBusy(false);
    }
  }

  const selected = cargoes.find((c) => c.cargo_key === cargoKey);

  return (
    <div className={styles.wrap}>
      <header className={styles.hero}>
        <span className={styles.kicker}>Free tool</span>
        <h1 className={styles.title}>Weather dispute checker</h1>
        <p className={styles.lede}>
          Was it really too wet to work? Pick a port, a window and a cargo, and we replay the
          hour-by-hour weather archive against that cargo&rsquo;s own sensitivity thresholds — the
          same deterministic engine that settles demurrage claims inside LayGrounded.
        </p>
      </header>

      <form className={styles.form} onSubmit={check}>
        <div className={styles.field}>
          <label htmlFor="port">Port</label>
          <input
            id="port"
            required
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="Rotterdam"
            maxLength={120}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="cargo">Cargo</label>
          <select id="cargo" value={cargoKey} onChange={(e) => setCargoKey(e.target.value)}>
            {cargoes.map((c) => (
              <option key={c.cargo_key} value={c.cargo_key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="start">From</label>
          <input
            id="start"
            type="date"
            required
            value={start}
            max={dateOnly(new Date().toISOString())}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="end">To</label>
          <input
            id="end"
            type="date"
            required
            value={end}
            max={dateOnly(new Date().toISOString())}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
        <button type="submit" className={styles.submit} disabled={busy || !cargoKey}>
          {busy ? "Checking the archive…" : "Check the weather"}
        </button>
      </form>

      {selected && (
        <p className={styles.thresholdNote}>
          <strong>{selected.label}</strong> stops for
          {selected.precip_mm_per_hr !== null
            ? ` rain at ${selected.precip_mm_per_hr} mm/h`
            : " no amount of rain"}
          {selected.wind_kn !== null ? `, wind at ${selected.wind_kn} kn` : ""}
          {selected.gust_kn !== null ? `, gusts at ${selected.gust_kn} kn` : ""}.
        </p>
      )}

      {error && (
        <p className={styles.error}>
          <AlertTriangle size={15} /> {error}
        </p>
      )}

      {report && (
        <section className={styles.report} aria-label="Dispute report">
          <div className={styles.headline}>
            <span className={`${styles.bigNumber} tnum`}>{report.totalExceptedHours}h</span>
            <span className={styles.bigLabel}>
              of work stopped by weather at {report.port.resolved}
            </span>
          </div>

          <div className={styles.statRow}>
            <div className={styles.stat}>
              <span className={`${styles.statValue} tnum`}>{report.blocks.length}</span>
              <span className={styles.statLabel}>separate stoppages</span>
            </div>
            <div className={styles.stat}>
              <span className={`${styles.statValue} tnum`}>{report.observedHours}h</span>
              <span className={styles.statLabel}>hours examined</span>
            </div>
            {report.gapHours > 0 && (
              <div className={styles.stat}>
                <span className={`${styles.statValue} tnum`}>{report.gapHours}h</span>
                <span className={styles.statLabel}>no data</span>
              </div>
            )}
          </div>

          {report.blocks.length === 0 ? (
            <p className={styles.clean}>
              No stoppage on record. Every hour in this window was workable for{" "}
              {report.profile.label.toLowerCase()} — a weather claim over these dates would have
              nothing behind it.
            </p>
          ) : (
            <>
              {/* The first two are always visible. The rest is the hook. */}
              <ul className={styles.blocks}>
                {(unlocked ? report.blocks : report.blocks.slice(0, 2)).map((b) => (
                  <li key={b.from} className={styles.block}>
                    <span className={styles.blockIcon}>
                      {b.dimensions.includes("precipitation") ? (
                        <CloudRain size={14} />
                      ) : (
                        <Wind size={14} />
                      )}
                    </span>
                    <div>
                      <div className={styles.blockHead}>
                        <span className="tnum">{fmt(b.from)}</span>
                        <span className={styles.arrow}>→</span>
                        <span className="tnum">{fmt(b.to)}</span>
                        <strong className={styles.blockHours}>{b.hours}h</strong>
                      </div>
                      <p className={styles.blockReason}>{b.reason}</p>
                    </div>
                  </li>
                ))}
              </ul>

              {!unlocked && report.blocks.length > 2 && (
                <form className={styles.gate} onSubmit={submitEmail}>
                  <div className={styles.gateHead}>
                    <Lock size={15} />
                    <strong>
                      {report.blocks.length - 2} more stoppage
                      {report.blocks.length - 2 === 1 ? "" : "s"} in this window
                    </strong>
                  </div>
                  <p className={styles.gateNote}>
                    Enter your work email to see the full hour-by-hour breakdown. We will send it
                    to you and nothing else.
                  </p>
                  <div className={styles.gateRow}>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      aria-label="Work email"
                    />
                    <button type="submit" disabled={emailBusy}>
                      {emailBusy ? "Unlocking…" : "Show the full report"}
                    </button>
                  </div>
                </form>
              )}

              {unlocked && (
                <p className={styles.unlocked}>
                  <Check size={14} /> Full report unlocked.
                </p>
              )}
            </>
          )}

          {report.warnings.length > 0 && (
            <ul className={styles.warnings}>
              {report.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <footer className={styles.method}>
            <p>
              Thresholds used: {report.profile.label} —{" "}
              {report.thresholds.precipMmPerHr !== null
                ? `${report.thresholds.precipMmPerHr} mm/h rain`
                : "insensitive to rain"}
              {report.thresholds.windKn !== null ? `, ${report.thresholds.windKn} kn wind` : ""}
              {report.thresholds.gustKn !== null ? `, ${report.thresholds.gustKn} kn gusts` : ""}
              , ignoring interruptions under {report.thresholds.minStoppageMinutes} minutes.{" "}
              <em>{report.profile.sourceLabel}</em>
            </p>
            <p>
              Source: ERA5 hourly reanalysis via Open-Meteo. Deterministic — the same dates and
              cargo give the same answer every time, which is what makes it usable in a dispute.
              Free checks: {report.quota.used} of {report.quota.limit} today.
            </p>
          </footer>
        </section>
      )}
    </div>
  );
}
