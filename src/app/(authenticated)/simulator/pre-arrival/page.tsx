"use client";

// Pre-arrival demurrage risk — the commercial view of the Monte Carlo engine.
//
// The audience is a chartering or operations desk, not a statistician, so the
// page leads with three numbers a commercial decision actually turns on and
// keeps the machinery underneath. The audit strip is not decoration: the seed
// and the input digest are what make a published figure something a
// counterparty can re-derive rather than take on trust.

import { useState } from "react";
import RiskDistributionChart, {
  type HistogramBin,
} from "@/components/laygrounded/RiskDistributionChart";
import styles from "./PreArrival.module.css";

const DAYS_BASES = [
  "SHINC", "SHEX", "SHEX-UU", "WWDSHEX-EIU", "SSHEX", "SSHEX-UU", "WWDSSHEX-EIU",
];

interface Estimate {
  value: number;
  standardError: number;
  ci95: [number, number];
}

interface Provenance {
  source: string;
  provider: string;
  observedAt: string | null;
  label: string;
  unavailableReason?: string;
}

interface Assessment {
  id: string;
  decisionGrade: boolean;
  vessel: string;
  port: string;
  cargo: string;
  eta: string;
  seed: string;
  trials: number;
  antithetic: boolean;
  inputsDigest: string;
  horizon: {
    leadTimeHours: number;
    mode: "ensemble" | "blended" | "climatology";
    ensembleWeight: number;
    description: string;
  };
  distribution: {
    trials: number;
    demurrageProbability: Estimate;
    expectedExposure: Estimate;
    conditionalExposure: Estimate;
    percentiles: { p10: Estimate; p50: Estimate; p90: Estimate; p95: Estimate };
    meanUsedHours: number;
    meanWaitingHours: number;
    meanStoppageHours: number;
    worstCase: number;
    bestCase: number;
    trajectoryMix: { ensemble: number; climatology: number };
    histogram: HistogramBin[];
  };
  provenance: {
    weather: Provenance;
    congestion: Provenance;
    cargoThresholds: Provenance;
    eta: Provenance;
  };
  caveats: string[];
}

function money(v: number, currency: string): string {
  return `${v < 0 ? "−" : ""}${currency} ${Math.abs(v).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
}

/**
 * Risk banding for the headline probability.
 *
 * Status colours, which by the design system's rule always ship with a text
 * label rather than carrying meaning by hue alone — so the band is legible to a
 * colourblind reader and in greyscale print.
 */
function band(p: number): { cls: string; label: string } {
  if (p >= 0.66) return { cls: styles.critical, label: "High risk" };
  if (p >= 0.33) return { cls: styles.serious, label: "Elevated risk" };
  if (p >= 0.1) return { cls: styles.warning, label: "Moderate risk" };
  return { cls: styles.good, label: "Low risk" };
}

/** ISO string for a datetime-local input, `n` days out, rounded to the hour. */
function defaultEta(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  d.setMinutes(0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

interface SpeedOption {
  speedKnots: number;
  etaISO: string;
  fuelTonnes: number;
  waitingHours: number;
}

interface VirtualArrivalPlan {
  decisionGrade: boolean;
  curve: { generic: boolean; source: string };
  queue: { hoursUsed: number; percentile: number; observations: number };
  action: "increase_speed" | "decrease_speed" | "maintain_speed";
  recommendation: string;
  current: SpeedOption;
  optimal: SpeedOption;
  savings: {
    fuelTonnes: number;
    fuelUsd: number;
    etsUsd: number;
    co2Tonnes: number;
    totalUsd: number;
  };
  actionRobust: boolean;
  sensitivity: Array<{
    percentile: number;
    queueHours: number;
    optimalSpeedKnots: number;
    action: string;
  }>;
  caveats: string[];
}

export default function PreArrivalRiskPage() {
  const [vessel, setVessel] = useState("");
  const [voyageRef, setVoyageRef] = useState("");
  const [port, setPort] = useState("Santos");
  const [cargo, setCargo] = useState("Grain");
  const [eta, setEta] = useState(defaultEta(7));
  const [operation, setOperation] = useState<"loading" | "discharge">("loading");
  const [opsHours, setOpsHours] = useState(96);
  const [allowedHours, setAllowedHours] = useState(120);
  const [daysBasis, setDaysBasis] = useState("WWDSHEX-EIU");
  const [demRate, setDemRate] = useState(24000);
  const [desRate, setDesRate] = useState(12000);
  const [trials, setTrials] = useState(5000);
  const currency = "USD";

  const [result, setResult] = useState<Assessment | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // ── Eco-Speed / JIT mitigation panel ───────────────────────────────────
  // Paired with the risk figure on purpose: the Monte Carlo says how exposed
  // this call is, and this says what can still be done about it.
  const [vesselClass, setVesselClass] = useState("supramax");
  const [currentSpeed, setCurrentSpeed] = useState(13);
  const [distanceNm, setDistanceNm] = useState(600);
  const [plan, setPlan] = useState<VirtualArrivalPlan | null>(null);
  const [planRunning, setPlanRunning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const run = async () => {
    if (!vessel.trim()) {
      setError("Vessel name is required.");
      return;
    }
    setRunning(true);
    setError(null);

    // The wait is dominated by the weather fetches, not the simulation, so the
    // stages describe what is actually happening rather than animating a bar
    // that means nothing.
    setStage("Resolving port and cargo thresholds…");
    const t1 = setTimeout(() => setStage("Fetching forecast ensemble and historical years…"), 900);
    const t2 = setTimeout(() => setStage(`Running ${trials.toLocaleString("en-US")} simulations…`), 2600);

    try {
      const res = await fetch("/api/risk/pre-arrival", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vessel: vessel.trim(),
          voyageRef: voyageRef.trim() || null,
          port,
          cargo,
          eta: new Date(eta).toISOString(),
          operation,
          opsDurationHours: opsHours,
          trials,
          cpTerms: {
            laytime_allowed_hours: allowedHours,
            days_basis: daysBasis,
            demurrage_rate: demRate,
            despatch_rate: desRate,
            currency,
          },
        }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        // The API's remedies are actionable, so they are shown rather than
        // flattened into "something went wrong".
        setError(
          body.message ||
            (body.error === "PORT_NOT_FOUND"
              ? "That port could not be geocoded. Try the city name on its own."
              : body.error === "WEATHER_UNAVAILABLE"
                ? "Neither a forecast nor historical weather could be retrieved for this port."
                : body.error === "VALIDATION_ERROR"
                  ? "Check the inputs and try again."
                  : body.error || "The assessment failed.")
        );
        return;
      }
      setResult(body as Assessment);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(t1);
      clearTimeout(t2);
      setRunning(false);
      setStage("");
    }
  };

  const optimise = async () => {
    setPlanRunning(true);
    setPlanError(null);
    try {
      const res = await fetch("/api/optimization/virtual-arrival", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          port,
          currentSpeedKnots: currentSpeed,
          distanceToPortNm: distanceNm,
          demurrageRatePerDay: demRate,
          vesselClass,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPlanError(body.message || body.error || "Could not compute an arrival plan.");
        setPlan(null);
        return;
      }
      setPlan(body as VirtualArrivalPlan);
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanRunning(false);
    }
  };

  const d = result?.distribution;
  const risk = d ? band(d.demurrageProbability.value) : null;

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Pre-arrival demurrage risk</h1>
        <p className={styles.pageSub}>
          Before she arrives: the probability this port call ends on demurrage, what it is
          likely to cost, and the tail you should be provisioning for. Every figure is
          reproducible from the seed and inputs recorded below it.
        </p>
      </header>

      <section className={styles.formCard} aria-label="Voyage inputs">
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="vessel">Vessel</label>
            <input id="vessel" className={styles.input} value={vessel}
              onChange={(e) => setVessel(e.target.value)} placeholder="MV Pacific Trader" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="voyageRef">Voyage ref</label>
            <input id="voyageRef" className={styles.input} value={voyageRef}
              onChange={(e) => setVoyageRef(e.target.value)} placeholder="optional" />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="port">Port</label>
            <input id="port" className={styles.input} value={port}
              onChange={(e) => setPort(e.target.value)} />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cargo">Cargo</label>
            <input id="cargo" className={styles.input} value={cargo}
              onChange={(e) => setCargo(e.target.value)} />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="eta">ETA</label>
            <input id="eta" type="datetime-local" className={styles.input} value={eta}
              onChange={(e) => setEta(e.target.value)} />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="operation">Operation</label>
            <select id="operation" className={styles.select} value={operation}
              onChange={(e) => setOperation(e.target.value as "loading" | "discharge")}>
              <option value="loading">Loading</option>
              <option value="discharge">Discharge</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="opsHours">Cargo hours</label>
            <input id="opsHours" type="number" min={1} max={480} className={styles.input}
              value={opsHours} onChange={(e) => setOpsHours(Number(e.target.value))} />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="allowedHours">Laytime allowed (h)</label>
            <input id="allowedHours" type="number" min={1} max={1000} className={styles.input}
              value={allowedHours} onChange={(e) => setAllowedHours(Number(e.target.value))} />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="daysBasis">Days basis</label>
            <select id="daysBasis" className={styles.select} value={daysBasis}
              onChange={(e) => setDaysBasis(e.target.value)}>
              {DAYS_BASES.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="demRate">Demurrage / day</label>
            <input id="demRate" type="number" min={0} className={styles.input} value={demRate}
              onChange={(e) => setDemRate(Number(e.target.value))} />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="desRate">Despatch / day</label>
            <input id="desRate" type="number" min={0} className={styles.input} value={desRate}
              onChange={(e) => setDesRate(Number(e.target.value))} />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="trials">Trials</label>
            <select id="trials" className={styles.select} value={trials}
              onChange={(e) => setTrials(Number(e.target.value))}>
              <option value={1000}>1,000 (fast)</option>
              <option value={5000}>5,000 (default)</option>
              <option value={20000}>20,000 (tighter)</option>
            </select>
          </div>
        </div>

        <div className={styles.formActions}>
          <button className={styles.runBtn} onClick={run} disabled={running}>
            {running ? "Assessing…" : "Assess risk"}
          </button>
          {running && stage && (
            <span className={styles.stage} role="status" aria-live="polite">
              <span className={styles.spinner} aria-hidden="true" />
              {stage}
            </span>
          )}
        </div>

        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>

      {running && !result && (
        <section className={styles.skeletonWrap} aria-hidden="true">
          <div className={styles.skeletonRow}>
            <div className={`${styles.skeleton} ${styles.skeletonHero}`} />
            <div className={`${styles.skeleton} ${styles.skeletonTile}`} />
            <div className={`${styles.skeleton} ${styles.skeletonTile}`} />
          </div>
          <div className={`${styles.skeleton} ${styles.skeletonChart}`} />
        </section>
      )}

      {result && d && risk && (
        <>
          {!result.decisionGrade && (
            <div className={styles.syntheticBanner} role="alert">
              <strong>Not decision-grade.</strong> At least one input is synthetic, so this
              assessment is for testing and demonstration only. It must not be used to price a
              fixture, support a claim, or inform a credit decision.
            </div>
          )}

          {/* Hero row. Exactly one hero figure — the probability — with the two
              money figures as stat tiles beside it. */}
          <section className={styles.heroRow} aria-label="Headline risk metrics">
            <div className={`${styles.heroCard} ${risk.cls}`}>
              <span className={styles.tileLabel}>Probability of demurrage</span>
              <span className={styles.heroValue}>
                {(d.demurrageProbability.value * 100).toFixed(0)}
                <span className={styles.heroUnit}>%</span>
              </span>
              <span className={styles.riskTag}>{risk.label}</span>
              <span className={styles.tileFoot}>
                ±{(d.demurrageProbability.standardError * 100).toFixed(1)} pts (95% CI{" "}
                {(d.demurrageProbability.ci95[0] * 100).toFixed(0)}–
                {(d.demurrageProbability.ci95[1] * 100).toFixed(0)}%)
              </span>
            </div>

            <div className={styles.tile}>
              <span className={styles.tileLabel}>Expected exposure</span>
              <span className={styles.tileValue}>{money(d.expectedExposure.value, currency)}</span>
              <span className={styles.tileFoot}>
                Average across every simulated voyage, including those costing nothing.
                <br />
                95% CI {money(d.expectedExposure.ci95[0], currency)} –{" "}
                {money(d.expectedExposure.ci95[1], currency)}
              </span>
            </div>

            <div className={styles.tile}>
              <span className={styles.tileLabel}>Tail risk (P90)</span>
              <span className={styles.tileValue}>{money(d.percentiles.p90.value, currency)}</span>
              <span className={styles.tileFoot}>
                One voyage in ten costs at least this much.
                <br />
                Worst simulated: {money(d.worstCase, currency)}
              </span>
            </div>
          </section>

          <section className={styles.chartCard} aria-label="Outcome distribution">
            <RiskDistributionChart
              histogram={d.histogram}
              trials={d.trials}
              currency={currency}
              meanValue={d.expectedExposure.value}
              p90Value={d.percentiles.p90.value}
              demurrageProbability={d.demurrageProbability.value}
            />
            <p className={styles.chartNote}>
              When it does go on demurrage it costs{" "}
              <strong>{money(d.conditionalExposure.value, currency)}</strong> on average — the
              number to plan the exception around, as distinct from the expected exposure above.
            </p>
          </section>

          {/* ── The mitigation, directly beneath the risk ──────────────────
              The pairing IS the pitch: the simulation says how exposed this
              call is, and this says what can still be done about it while the
              vessel is at sea. */}
          <section className={styles.mitigationCard} aria-label="Eco-speed / JIT optimisation">
            <div className={styles.mitigationHead}>
              <div>
                <h2 className={styles.sectionTitle}>Eco-speed / just-in-time arrival</h2>
                <p className={styles.sectionSub}>
                  Sailing fast into a queue buys nothing but bunkers and EUAs. Given the same
                  live queue used above, this prices every arrival speed against fuel, carbon,
                  waiting and the laycan.
                </p>
              </div>
            </div>

            <div className={styles.mitigationForm}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="vesselClass">Vessel class</label>
                <select id="vesselClass" className={styles.select} value={vesselClass}
                  onChange={(e) => setVesselClass(e.target.value)}>
                  <option value="handysize">Handysize (~30k dwt)</option>
                  <option value="supramax">Supramax (~58k dwt)</option>
                  <option value="panamax">Panamax (~82k dwt)</option>
                  <option value="capesize">Capesize (~180k dwt)</option>
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="currentSpeed">Current speed (kn)</label>
                <input id="currentSpeed" type="number" min={1} max={25} step={0.5}
                  className={styles.input} value={currentSpeed}
                  onChange={(e) => setCurrentSpeed(Number(e.target.value))} />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="distanceNm">Distance to port (nm)</label>
                <input id="distanceNm" type="number" min={1} max={20000}
                  className={styles.input} value={distanceNm}
                  onChange={(e) => setDistanceNm(Number(e.target.value))} />
              </div>
              <button className={styles.runBtn} onClick={optimise} disabled={planRunning}>
                {planRunning ? "Optimising…" : "Optimise arrival"}
              </button>
            </div>

            {planError && <p className={styles.error} role="alert">{planError}</p>}

            {plan && (
              <div className={styles.planResult}>
                <div className={styles.planHeadline}>
                  <span className={`${styles.actionTag} ${
                    plan.action === "decrease_speed" ? styles.actionSlow
                      : plan.action === "increase_speed" ? styles.actionFast : styles.actionHold
                  }`}>
                    {plan.action === "decrease_speed" ? "Slow down"
                      : plan.action === "increase_speed" ? "Speed up" : "Maintain"}
                  </span>
                  <span className={styles.planSpeed}>
                    {plan.current.speedKnots} → <strong>{plan.optimal.speedKnots} kn</strong>
                  </span>
                  {!plan.actionRobust && (
                    <span className={styles.fragile}>Not stable across queue uncertainty</span>
                  )}
                </div>

                <div className={styles.savingsRow}>
                  {[
                    { k: "Bunkers saved", v: `${plan.savings.fuelTonnes.toFixed(1)} t` },
                    { k: "Fuel cost", v: money(plan.savings.fuelUsd, currency) },
                    { k: "ETS avoided", v: money(plan.savings.etsUsd, currency) },
                    { k: "CO2 avoided", v: `${plan.savings.co2Tonnes.toFixed(1)} t` },
                    { k: "Total saving", v: money(plan.savings.totalUsd, currency) },
                  ].map((s) => (
                    <div key={s.k} className={styles.saving}>
                      <span className={styles.statKey}>{s.k}</span>
                      <span className={`${styles.savingVal} tnum`}>{s.v}</span>
                    </div>
                  ))}
                </div>

                <p className={styles.planNote}>{plan.recommendation}</p>

                <details className={styles.details}>
                  <summary className={styles.summary}>
                    How the advice holds as the queue moves ({plan.sensitivity.length} scenarios)
                  </summary>
                  <ul className={styles.caveatList}>
                    {plan.sensitivity.map((sc) => (
                      <li key={sc.percentile}>
                        P{Math.round(sc.percentile * 100)} queue {sc.queueHours}h →{" "}
                        {sc.optimalSpeedKnots} kn ({sc.action.replace("_", " ")})
                      </li>
                    ))}
                  </ul>
                  <ul className={styles.caveatList}>
                    {plan.caveats.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </details>
              </div>
            )}
          </section>

          <section className={styles.statsGrid} aria-label="Simulated voyage averages">
            {[
              { k: "Mean time in queue", v: `${d.meanWaitingHours.toFixed(1)} h` },
              { k: "Mean weather stoppage", v: `${d.meanStoppageHours.toFixed(1)} h` },
              { k: "Mean laytime used", v: `${d.meanUsedHours.toFixed(1)} h` },
              { k: "Median outcome (P50)", v: money(d.percentiles.p50.value, currency) },
              { k: "Best simulated", v: money(d.bestCase, currency) },
              { k: "P95", v: money(d.percentiles.p95.value, currency) },
            ].map((s) => (
              <div key={s.k} className={styles.stat}>
                <span className={styles.statKey}>{s.k}</span>
                <span className={`${styles.statVal} tnum`}>{s.v}</span>
              </div>
            ))}
          </section>

          {/* The moat, stated plainly. */}
          <section className={styles.auditCard} aria-label="Audit and provenance">
            <h2 className={styles.auditTitle}>Audit &amp; provenance</h2>
            <p className={styles.auditIntro}>
              This assessment is deterministic. Anyone holding the seed and the stored inputs
              reproduces these exact figures — no network, no clock, no trust in us required.
            </p>

            <dl className={styles.auditGrid}>
              <div className={styles.auditItem}>
                <dt>Simulation seed</dt>
                <dd className={`${styles.mono} tnum`}>{result.seed}</dd>
              </div>
              <div className={styles.auditItem}>
                <dt>Inputs digest (SHA-256)</dt>
                <dd className={`${styles.mono} tnum`}>{result.inputsDigest.slice(0, 32)}…</dd>
              </div>
              <div className={styles.auditItem}>
                <dt>Trials</dt>
                <dd className="tnum">
                  {result.trials.toLocaleString("en-US")}
                  {result.antithetic && (
                    <span className={styles.chipNeutral}>antithetic variates</span>
                  )}
                </dd>
              </div>
              <div className={styles.auditItem}>
                <dt>Assessment ID</dt>
                <dd className={`${styles.mono} tnum`}>{result.id}</dd>
              </div>
            </dl>

            <div className={styles.flags}>
              <span
                className={`${styles.flag} ${
                  result.provenance.congestion.source === "mock" ? styles.flagMock : styles.flagLive
                }`}
              >
                <span className={styles.flagKey}>AIS queue</span>
                {result.provenance.congestion.source === "mock"
                  ? "Mocked"
                  : result.provenance.congestion.source === "assumption"
                    ? "Your assumption"
                    : `Live · ${result.provenance.congestion.provider}`}
              </span>

              <span className={`${styles.flag} ${styles.flagLive}`}>
                <span className={styles.flagKey}>Weather</span>
                {result.horizon.mode === "blended"
                  ? `Hybrid · ${d.trajectoryMix.ensemble.toLocaleString("en-US")} ensemble / ${d.trajectoryMix.climatology.toLocaleString("en-US")} climatology`
                  : result.horizon.mode === "ensemble"
                    ? `Forecast ensemble · ${d.trajectoryMix.ensemble.toLocaleString("en-US")} members drawn`
                    : `Climatology · ${d.trajectoryMix.climatology.toLocaleString("en-US")} historical years drawn`}
              </span>

              <span className={`${styles.flag} ${styles.flagLive}`}>
                <span className={styles.flagKey}>Cargo thresholds</span>
                {result.provenance.cargoThresholds.label}
              </span>
            </div>

            <p className={styles.horizonNote}>{result.horizon.description}</p>

            <details className={styles.details}>
              <summary className={styles.summary}>
                Assumptions and limits ({result.caveats.length})
              </summary>
              <ul className={styles.caveatList}>
                {result.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              <ul className={styles.caveatList}>
                <li>{result.provenance.weather.label}</li>
                <li>{result.provenance.congestion.label}</li>
                <li>{result.provenance.eta.label}</li>
              </ul>
            </details>
          </section>
        </>
      )}
    </div>
  );
}
