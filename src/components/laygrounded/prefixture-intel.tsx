"use client";

// Pre-fixture intelligence: before terms are agreed, replay a broker's
// proposed laytime allowance against the network's verified voyage history
// (pricing oracle) and check what the port's paper history is worth
// (honesty index). Both APIs are aggregate-only privacy boundaries — no
// claim or company identifiers ever reach this component.

import { useCallback, useEffect, useState } from "react";
import styles from "./PrefixtureIntel.module.css";

interface RiskExposure {
  sampleSize: number;
  verifiedShare: number;
  demurrageProbability: number;
  meanExposure: number;
  medianExposure: number;
  p90Exposure: number;
  worstExposure: number;
  meanWeatherDelayHours: number;
  meanUsedHours: number;
  assessment: string;
}

interface PricingResult {
  exposure: RiskExposure;
  currency: string;
  basis: {
    port: string;
    month: number;
    cargo: string | null;
    sampleSize: number;
    verifiedOnly: boolean;
    cargoFallback: boolean;
  };
}

interface HonestyScore {
  subjectType: "port" | "agent";
  subjectLabel: string;
  checkType: string;
  band: "clean" | "caution" | "high_risk" | "insufficient_data";
  falseClaimRate: number | null;
  decisiveChecks: number;
  contradictedChecks: number;
  claimsCovered: number;
  warning: string | null;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function bandClass(band: HonestyScore["band"]): string {
  if (band === "clean") return styles.chipOk;
  if (band === "caution") return styles.chipWarn;
  if (band === "high_risk") return styles.chipCrit;
  return styles.chipMuted;
}

function bandLabel(band: HonestyScore["band"]): string {
  return band.replace(/_/g, " ").toUpperCase();
}

export function PrefixtureIntel() {
  const [port, setPort] = useState("");
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [cargo, setCargo] = useState("");
  const [allowedHours, setAllowedHours] = useState("72");
  const [demurrageRate, setDemurrageRate] = useState("25000");

  const [pricing, setPricing] = useState<PricingResult | null>(null);
  const [portHonesty, setPortHonesty] = useState<HonestyScore[] | null>(null);
  const [watchlist, setWatchlist] = useState<HonestyScore[]>([]);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadWatchlist = useCallback(async () => {
    const res = await fetch(`/api/intel/honesty-index?limit=8`);
    if (res.ok) setWatchlist((await res.json()).scores ?? []);
  }, []);

  useEffect(() => {
    loadWatchlist().catch(() => {});
  }, [loadWatchlist]);

  const runLookup = async () => {
    const allowed = parseFloat(allowedHours);
    const rate = parseFloat(demurrageRate);
    if (!port.trim() || !(allowed > 0) || !(rate > 0)) {
      setPricingError("Port, a positive laytime allowance, and a demurrage rate are required.");
      return;
    }
    setLoading(true);
    setPricingError(null);
    setPricing(null);
    setPortHonesty(null);
    try {
      const [priceRes, honestyRes] = await Promise.all([
        fetch(`/api/oracle/pricing`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            port: port.trim(),
            month,
            cargo: cargo.trim() || undefined,
            laytimeAllowedHours: allowed,
            demurrageRatePerDay: rate,
          }),
        }),
        fetch(
          `/api/intel/honesty-index?subject=${encodeURIComponent(port.trim().toLowerCase())}&type=port`
        ),
      ]);

      if (priceRes.ok) {
        setPricing(await priceRes.json());
      } else {
        const body = await priceRes.json().catch(() => ({}));
        setPricingError(
          body.error === "INSUFFICIENT_DATA"
            ? "Not enough voyage history at this port/month to price on — the oracle refuses to guess from a thin sample."
            : body.error || `Pricing failed (${priceRes.status})`
        );
      }
      if (honestyRes.ok) {
        setPortHonesty((await honestyRes.json()).scores ?? []);
      }
    } catch (e) {
      setPricingError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const refreshIndexes = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        fetch(`/api/oracle/refresh`, { method: "POST" }),
        fetch(`/api/intel/honesty-index`, { method: "POST" }),
      ]);
      await loadWatchlist();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.headRow}>
        <div>
          <div className={styles.cardTitle}>Pre-fixture intelligence</div>
          <div className={styles.cardDesc}>
            Price a broker&apos;s proposed terms against the network&apos;s verified
            voyage history, and see how honest the port&apos;s paperwork has been.
          </div>
        </div>
        <button className={styles.smallBtn} onClick={refreshIndexes} disabled={refreshing}>
          {refreshing ? "REFRESHING…" : "REFRESH INDEX DATA"}
        </button>
      </div>

      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Port</span>
          <input
            className={styles.input}
            type="text"
            placeholder="e.g. Santos"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Month</span>
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
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Cargo (optional)</span>
          <input
            className={styles.input}
            type="text"
            placeholder="e.g. soybeans"
            value={cargo}
            onChange={(e) => setCargo(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Proposed laytime (hours)</span>
          <input
            className={`${styles.input} tnum`}
            type="number"
            min="1"
            value={allowedHours}
            onChange={(e) => setAllowedHours(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Demurrage (USD/day)</span>
          <input
            className={`${styles.input} tnum`}
            type="number"
            min="1"
            value={demurrageRate}
            onChange={(e) => setDemurrageRate(e.target.value)}
          />
        </label>
        <button className={styles.primaryBtn} onClick={runLookup} disabled={loading}>
          {loading ? "PRICING…" : "PRICE THE RISK"}
        </button>
      </div>

      {pricingError && <div className={styles.errorBox}>{pricingError}</div>}

      {loading && (
        <div className={styles.tileRow}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`${styles.tile} ${styles.tileSkeleton}`} />
          ))}
        </div>
      )}

      {pricing && !loading && (
        <>
          <div className={styles.tileRow}>
            <div className={`${styles.tile} ${styles.tileHero}`}>
              <div className={styles.tileLabel}>P90 demurrage exposure</div>
              <div className={`${styles.tileValue} tnum`}>
                {money(pricing.exposure.p90Exposure, pricing.currency)}
              </div>
              <div className={styles.tileNote}>
                1-in-10 voyages at these terms cost at least this
              </div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileLabel}>Median exposure</div>
              <div className={`${styles.tileValue} tnum`}>
                {money(pricing.exposure.medianExposure, pricing.currency)}
              </div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileLabel}>Mean exposure</div>
              <div className={`${styles.tileValue} tnum`}>
                {money(pricing.exposure.meanExposure, pricing.currency)}
              </div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileLabel}>Demurrage probability</div>
              <div className={`${styles.tileValue} tnum`}>
                {(pricing.exposure.demurrageProbability * 100).toFixed(0)}%
              </div>
              <div className={styles.tileNote}>
                worst seen {money(pricing.exposure.worstExposure, pricing.currency)}
              </div>
            </div>
          </div>
          <div className={styles.assessment}>{pricing.exposure.assessment}</div>
          <div className={styles.basisLine}>
            Basis: {pricing.basis.sampleSize} voyage{pricing.basis.sampleSize === 1 ? "" : "s"} at{" "}
            {pricing.basis.port} in {MONTHS[pricing.basis.month - 1]}
            {pricing.basis.cargo ? ` carrying ${pricing.basis.cargo}` : ""}
            {pricing.basis.verifiedOnly ? " · evidence-verified voyages only" : ""}
            {pricing.basis.cargoFallback
              ? " · cargo filter widened to the whole port (thin cargo sample)"
              : ""}
            {" · mean weather delay "}
            {pricing.exposure.meanWeatherDelayHours.toFixed(1)}h
          </div>
        </>
      )}

      {portHonesty && (
        <div className={styles.honestyBlock}>
          <div className={styles.subTitle}>Port honesty — {port.trim()}</div>
          {portHonesty.length === 0 ? (
            <div className={styles.mutedNote}>
              No verification history for this port in the network yet.
            </div>
          ) : (
            <div className={styles.chipRow}>
              {portHonesty.map((s, i) => (
                <span key={i} className={`${styles.chip} ${bandClass(s.band)} tnum`}>
                  {s.checkType.toUpperCase()} · {bandLabel(s.band)}
                  {s.falseClaimRate != null
                    ? ` · ${(s.falseClaimRate * 100).toFixed(0)}% contradicted`
                    : ""}
                </span>
              ))}
            </div>
          )}
          {portHonesty.some((s) => s.warning) && (
            <div className={styles.warningNote}>
              {portHonesty.find((s) => s.warning)?.warning}
            </div>
          )}
        </div>
      )}

      <div className={styles.honestyBlock}>
        <div className={styles.subTitle}>Network watchlist — most-contradicted subjects</div>
        {watchlist.length === 0 ? (
          <div className={styles.mutedNote}>
            No subjects above the anonymity floor yet — the index lists a port or
            agent only once enough independent checks exist.
          </div>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>Check</th>
                  <th style={{ textAlign: "right" }}>Contradicted</th>
                  <th>Band</th>
                </tr>
              </thead>
              <tbody>
                {watchlist.map((s, i) => (
                  <tr key={i}>
                    <td>
                      {s.subjectLabel}{" "}
                      <span className={styles.mutedNote}>({s.subjectType})</span>
                    </td>
                    <td>{s.checkType}</td>
                    <td style={{ textAlign: "right" }} className="tnum">
                      {s.falseClaimRate != null
                        ? `${(s.falseClaimRate * 100).toFixed(0)}% of ${s.decisiveChecks}`
                        : "—"}
                    </td>
                    <td>
                      <span className={`${styles.chip} ${bandClass(s.band)} tnum`}>
                        {bandLabel(s.band)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
