"use client";

// Compliance & regulatory surface — brings the server-side modules into the
// UI: EU MRV / ETS annual reporting, the FuelEU Maritime GHG-intensity
// calculator, the in-voyage Legal Shield alert inbox, and the
// parametric-insurance oracle's policy registry.

import { useCallback, useEffect, useState } from "react";
import styles from "./Compliance.module.css";

interface MrvReport {
  id: string;
  reportingPeriod: number;
  merkleRoot: string | null;
  submittable: boolean;
  verificationStatus: string;
  sealedAt: string;
  report: any;
}

interface ShieldAlert {
  id: string;
  claimId: string;
  alertType: string;
  status: string;
  detail: string | null;
  createdAt: string;
  vessel?: string;
  voyageRef?: string;
  port?: string;
}

interface Policy {
  id: string;
  insurerLabel: string;
  webhookUrl: string;
  thresholdHours: number;
}

const FUEL_OPTIONS = [
  "HFO",
  "LFO",
  "MDO/MGO",
  "LNG",
  "LPG-propane",
  "LPG-butane",
  "methanol",
  "ethanol",
] as const;

interface FuelRow {
  fuel: string;
  tonnes: string;
  wtwIntensity: string;
}

interface FuelEuResult {
  year: number;
  limit: number;
  reductionPct: number;
  attainedIntensity: number;
  totalEnergyMJ: number;
  complianceBalanceGco2eq: number;
  compliant: boolean;
  vlsfoEquivalentTonnes: number;
  penaltyEur: number;
  breakdown: Array<{
    fuel: string;
    tonnes: number;
    energyMJ: number;
    wtwIntensity: number;
    source: string;
  }>;
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export default function CompliancePage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // MRV
  const [mrvReports, setMrvReports] = useState<MrvReport[]>([]);
  const [mrvYear, setMrvYear] = useState(new Date().getUTCFullYear() - 1);

  // FuelEU Maritime calculator
  const [fuelEuYear, setFuelEuYear] = useState(new Date().getUTCFullYear());
  const [fuelRows, setFuelRows] = useState<FuelRow[]>([
    { fuel: "HFO", tonnes: "1000", wtwIntensity: "" },
  ]);
  const [fuelEuResult, setFuelEuResult] = useState<FuelEuResult | null>(null);

  // Voyage shield
  const [alerts, setAlerts] = useState<ShieldAlert[]>([]);

  // Insurance
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [insurerLabel, setInsurerLabel] = useState("");
  const [thresholdHours, setThresholdHours] = useState(48);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [newSecret, setNewSecret] = useState<{ apiKey: string; webhookSecret: string } | null>(null);

  const load = useCallback(async () => {
    const [mrvRes, alertsRes, policiesRes] = await Promise.all([
      fetch(`/api/v1/compliance/mrv-report`),
      fetch(`/api/voyage-shield/run`),
      fetch(`/api/insurance/policies`),
    ]);
    const mrvJson = await readJson(mrvRes);
    if (mrvRes.ok && mrvJson?.reports) setMrvReports(mrvJson.reports);
    const alertsJson = await readJson(alertsRes);
    if (alertsRes.ok && alertsJson?.alerts) setAlerts(alertsJson.alerts);
    const polJson = await readJson(policiesRes);
    if (policiesRes.ok && polJson?.policies) setPolicies(polJson.policies);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const generateMrv = async () => {
    setBusy("mrv");
    setError(null);
    try {
      const res = await fetch(`/api/v1/compliance/mrv-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportingPeriod: mrvYear, persist: true }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `MRV report failed (${res.status}).`);
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  const updateFuelRow = (i: number, patch: Partial<FuelRow>) =>
    setFuelRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addFuelRow = () =>
    setFuelRows((rows) => [...rows, { fuel: "MDO/MGO", tonnes: "", wtwIntensity: "" }]);
  const removeFuelRow = (i: number) =>
    setFuelRows((rows) => (rows.length > 1 ? rows.filter((_, idx) => idx !== i) : rows));

  const computeFuelEuReport = async () => {
    const fuels = fuelRows
      .map((r) => ({
        fuel: r.fuel,
        tonnes: parseFloat(r.tonnes),
        wtwIntensity: r.wtwIntensity.trim() ? parseFloat(r.wtwIntensity) : undefined,
      }))
      .filter((f) => !isNaN(f.tonnes) && f.tonnes > 0);
    if (fuels.length === 0) {
      setError("Add at least one fuel with a positive tonnage.");
      return;
    }
    setBusy("fueleu");
    setError(null);
    setFuelEuResult(null);
    try {
      const res = await fetch("/api/compliance/fueleu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year: fuelEuYear, fuels }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `FuelEU calculation failed (${res.status}).`);
        return;
      }
      setFuelEuResult(json.result);
    } finally {
      setBusy(null);
    }
  };

  const runSweep = async () => {
    setBusy("sweep");
    setError(null);
    try {
      const res = await fetch(`/api/voyage-shield/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `Sweep failed (${res.status}).`);
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  const createPolicy = async () => {
    if (!insurerLabel.trim()) {
      setError("Insurer label is required.");
      return;
    }
    setBusy("policy");
    setError(null);
    setNewSecret(null);
    try {
      const res = await fetch(`/api/insurance/policies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          insurerLabel: insurerLabel.trim(),
          thresholdHours,
          webhookUrl: webhookUrl.trim() || undefined,
        }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `Policy creation failed (${res.status}).`);
        return;
      }
      setNewSecret({ apiKey: json.apiKey, webhookSecret: json.webhookSecret });
      setInsurerLabel("");
      setWebhookUrl("");
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Compliance &amp; regulatory</h1>
        <p className={styles.pageSub}>
          EU MRV / ETS annual reporting, the FuelEU Maritime GHG-intensity calculator, the in-voyage
          Legal Shield alert inbox, and the parametric-insurance policy registry — the regulatory and
          risk-transfer modules that run across your whole book.
        </p>
      </header>

      <div className={styles.grid}>
        {/* --- MRV / ETS --- */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            EU MRV / ETS annual report
          </div>
          <div className={styles.cardSub}>
            Emits the real Reg (EU) 2015/757 structure. A fuel or CO₂ figure appears only where
            measured bunker data was supplied — every other field reports NOT MONITORED. Sealed
            reports are tamper-evident, never self-certified: only an accredited verifier confers
            regulatory standing.
          </div>
          <div className={styles.formRow}>
            <label className={styles.label}>Reporting year</label>
            <input
              className={`${styles.input} tnum`}
              type="number"
              min={2015}
              max={2100}
              value={mrvYear}
              onChange={(e) => setMrvYear(parseInt(e.target.value || "0", 10))}
              style={{ maxWidth: 100 }}
            />
            <button className={styles.btn} onClick={generateMrv} disabled={busy === "mrv"}>
              {busy === "mrv" ? "GENERATING…" : "GENERATE & SEAL"}
            </button>
          </div>
          {mrvReports.length === 0 ? (
            <div className={styles.muted}>No sealed reports yet.</div>
          ) : (
            <div className={styles.itemList}>
              {mrvReports.map((r) => (
                <div key={r.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span className="tnum">Period {r.reportingPeriod}</span>
                    <span
                      className={`${styles.chip} ${r.submittable ? styles.chipOk : styles.chipWarn}`}
                    >
                      {r.submittable ? "SUBMITTABLE" : "GAPS REMAIN"} · {r.verificationStatus.toUpperCase()}
                    </span>
                  </div>
                  <div className={styles.mono}>root {r.merkleRoot?.slice(0, 24)}…</div>
                  <div className={styles.muted}>sealed {r.sealedAt.slice(0, 16).replace("T", " ")}</div>
                  <details>
                    <summary className={styles.muted}>Full report</summary>
                    <pre className={styles.pre}>{JSON.stringify(r.report, null, 2)}</pre>
                  </details>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* --- FuelEU Maritime --- */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>FuelEU Maritime</div>
          <div className={styles.cardSub}>
            Reg (EU) 2023/1805: a well-to-wake GHG-intensity limit on the energy a ship uses,
            tightening to 2050. Enter a voyage or annual fuel mix for the attained intensity, the
            compliance balance and the Annex IV penalty on a deficit. Pathway-dependent fuels (LPG,
            methanol, ethanol) need a supplied WtW value — the calculator will not invent one.
          </div>
          <div className={styles.formRow}>
            <label className={styles.label}>Compliance year</label>
            <input
              className={`${styles.input} tnum`}
              type="number"
              min={2025}
              max={2100}
              value={fuelEuYear}
              onChange={(e) => setFuelEuYear(parseInt(e.target.value || "0", 10))}
              style={{ maxWidth: 100 }}
            />
          </div>
          {fuelRows.map((row, i) => (
            <div key={i} className={styles.formRow}>
              <select
                className={styles.input}
                value={row.fuel}
                onChange={(e) => updateFuelRow(i, { fuel: e.target.value })}
                style={{ maxWidth: 140 }}
              >
                {FUEL_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <input
                className={`${styles.input} tnum`}
                type="number"
                min={0}
                placeholder="tonnes"
                value={row.tonnes}
                onChange={(e) => updateFuelRow(i, { tonnes: e.target.value })}
                style={{ maxWidth: 100 }}
              />
              <input
                className={`${styles.input} tnum`}
                type="number"
                min={0}
                placeholder="WtW (opt.)"
                title="Well-to-wake gCO₂eq/MJ — required for LPG / methanol / ethanol"
                value={row.wtwIntensity}
                onChange={(e) => updateFuelRow(i, { wtwIntensity: e.target.value })}
                style={{ maxWidth: 110 }}
              />
              {fuelRows.length > 1 && (
                <button className={styles.btn} onClick={() => removeFuelRow(i)} title="Remove fuel">
                  ×
                </button>
              )}
            </div>
          ))}
          <div className={styles.formRow}>
            <button className={styles.btn} onClick={addFuelRow}>
              + FUEL
            </button>
            <button className={styles.btn} onClick={computeFuelEuReport} disabled={busy === "fueleu"}>
              {busy === "fueleu" ? "COMPUTING…" : "COMPUTE"}
            </button>
          </div>
          {fuelEuResult && (
            <div className={styles.item}>
              <div className={styles.itemHead}>
                <span className="tnum">
                  {fuelEuResult.attainedIntensity} vs {fuelEuResult.limit} gCO₂e/MJ
                </span>
                <span
                  className={`${styles.chip} ${fuelEuResult.compliant ? styles.chipOk : styles.chipCrit}`}
                >
                  {fuelEuResult.compliant ? "COMPLIANT" : "DEFICIT"}
                </span>
              </div>
              <div className={styles.muted}>
                {fuelEuResult.year} limit is 91.16 − {fuelEuResult.reductionPct}% ·{" "}
                {(fuelEuResult.totalEnergyMJ / 1e6).toLocaleString("en-US", {
                  maximumFractionDigits: 1,
                })}{" "}
                TJ energy
              </div>
              {!fuelEuResult.compliant && (
                <div className={styles.mono}>
                  Penalty €
                  {fuelEuResult.penaltyEur.toLocaleString("en-US", { maximumFractionDigits: 2 })} ·{" "}
                  {fuelEuResult.vlsfoEquivalentTonnes.toLocaleString("en-US", {
                    maximumFractionDigits: 3,
                  })}{" "}
                  t VLSFOe
                </div>
              )}
              <details>
                <summary className={styles.muted}>Fuel breakdown</summary>
                <pre className={styles.pre}>{JSON.stringify(fuelEuResult.breakdown, null, 2)}</pre>
              </details>
            </div>
          )}
        </div>

        {/* --- Voyage shield --- */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            Legal Shield alerts
            <button className={styles.btn} onClick={runSweep} disabled={busy === "sweep"}>
              {busy === "sweep" ? "SWEEPING…" : "RUN SWEEP"}
            </button>
          </div>
          <div className={styles.cardSub}>
            Re-verifies live claims&apos; weather events against the ERA5 archive. A contradicted
            check raises an alert and auto-drafts a grounded letter of protest.
          </div>
          {alerts.length === 0 ? (
            <div className={styles.muted}>No open alerts — the book is clean.</div>
          ) : (
            <div className={styles.itemList}>
              {alerts.map((a) => (
                <div key={a.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span className={`${styles.chip} ${styles.chipCrit}`}>
                      {a.alertType.replace(/_/g, " ").toUpperCase()}
                    </span>
                    <span className={styles.muted}>{a.createdAt.slice(0, 16).replace("T", " ")}</span>
                  </div>
                  <div>
                    <a href={`/claims/${a.claimId}/workspace`} className={styles.chip} style={{ border: "none", padding: 0 }}>
                      {a.vessel} · {a.voyageRef} · {a.port}
                    </a>
                  </div>
                  {a.detail && <div className={styles.muted}>{a.detail}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* --- Parametric insurance --- */}
        <div className={styles.card}>
          <div className={styles.cardTitle}>Parametric insurance policies</div>
          <div className={styles.cardSub}>
            Register an insurer policy: when a claim&apos;s longest continuous weather-delay window
            crosses the threshold, the oracle ledgers a trigger (at most once per window) and emits a
            signed webhook. The API key and webhook secret are shown once.
          </div>
          <div className={styles.formRow}>
            <input
              className={styles.input}
              type="text"
              placeholder="Insurer label"
              value={insurerLabel}
              onChange={(e) => setInsurerLabel(e.target.value)}
            />
            <label className={styles.label}>Threshold hrs</label>
            <input
              className={`${styles.input} tnum`}
              type="number"
              min={1}
              value={thresholdHours}
              onChange={(e) => setThresholdHours(parseInt(e.target.value || "0", 10))}
              style={{ maxWidth: 80 }}
            />
          </div>
          <div className={styles.formRow}>
            <input
              className={styles.input}
              type="text"
              placeholder="Webhook URL (optional)"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              style={{ maxWidth: 260 }}
            />
            <button className={styles.btn} onClick={createPolicy} disabled={busy === "policy"}>
              {busy === "policy" ? "CREATING…" : "ADD POLICY"}
            </button>
          </div>
          {newSecret && (
            <div className={styles.secretBox}>
              <strong>Store these now — shown once.</strong>
              <div className={styles.mono}>API key: {newSecret.apiKey}</div>
              <div className={styles.mono}>Webhook secret: {newSecret.webhookSecret}</div>
            </div>
          )}
          {policies.length === 0 ? (
            <div className={styles.muted} style={{ marginTop: "0.5rem" }}>No policies registered.</div>
          ) : (
            <div className={styles.itemList} style={{ marginTop: "0.5rem" }}>
              {policies.map((p) => (
                <div key={p.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span>{p.insurerLabel}</span>
                    <span className={`${styles.chip} tnum`}>≥ {p.thresholdHours}h</span>
                  </div>
                  {p.webhookUrl && <div className={styles.mono}>{p.webhookUrl}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
