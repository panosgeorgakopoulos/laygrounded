"use client";

import { useState } from "react";
import {
  CpTerms,
  CpForm,
  LaytimeResult,
  NorVariant,
  DaysBasis,
  NOR_VARIANTS,
  DAYS_BASES,
  CP_FORMS,
} from "@/lib/laytime/types";
import styles from "./CalculationPane.module.css";
import { Button } from "@/components/core/Button";

interface ClauseFlag {
  id: string;
  eventId: string;
  clauseRef: string;
  severity: "info" | "warning" | "critical";
  note: string;
}

interface CalculationPaneProps {
  claimId: string;
  cpTerms: CpTerms;
  onCpTermsChange: (t: CpTerms) => void;
  result: LaytimeResult | null;
  clauseFlags: ClauseFlag[];
  onRunClauseAnalysis: () => void;
  onExport: () => void;
  exporting: boolean;
  flagging: boolean;
}

export function CalculationPane({
  claimId,
  cpTerms,
  onCpTermsChange,
  result,
  clauseFlags,
  onRunClauseAnalysis,
  onExport,
  exporting,
  flagging,
}: CalculationPaneProps) {
  const [localCp, setLocalCp] = useState<CpTerms>(cpTerms);
  const [isDirty, setIsDirty] = useState(false);

  // Adopt new terms when the parent hands them down: state is adjusted
  // during render (the React-recommended replacement for a props-sync
  // effect) so there is no extra committed render with stale terms.
  const [prevCpTerms, setPrevCpTerms] = useState(cpTerms);
  if (prevCpTerms !== cpTerms) {
    setPrevCpTerms(cpTerms);
    setLocalCp(cpTerms);
    setIsDirty(false);
  }

  const handleChange = (field: keyof CpTerms, val: any) => {
    setLocalCp((prev) => {
      const next = { ...prev, [field]: val };
      return next;
    });
    setIsDirty(true);
  };

  const saveTerms = () => {
    onCpTermsChange(localCp);
    setIsDirty(false);
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={`${styles.headerTitle} tnum`}>TERMS & CALCULATIONS</div>
        {isDirty && (
          <button
            onClick={saveTerms}
            className={`${styles.actionBtn} tnum`}
          >
            APPLY CHANGES
          </button>
        )}
      </div>

      <div className={styles.scrollArea}>
        {/* CP Terms Form */}
        <div className={styles.section}>
          <div className={`${styles.sectionTitle} tnum`}>Charter Party Terms</div>
          <div className={styles.formGrid}>
            <div className={styles.formGroupFull}>
              <label className={styles.label}>CP Form</label>
              <select
                value={localCp.cp_form ?? "GENCON94"}
                onChange={(e) => handleChange("cp_form", e.target.value as CpForm)}
                className={styles.select}
              >
                {CP_FORMS.map((f) => (
                  <option key={f} value={f}>
                    {f === "ASBATANKVOY" ? "ASBATANKVOY (tanker)" : "GENCON 94 (dry bulk)"}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Laytime Allowed (Hrs)</label>
              <input
                type="number"
                value={localCp.laytime_allowed_hours ?? 0}
                onChange={(e) => handleChange("laytime_allowed_hours", parseFloat(e.target.value))}
                className={`${styles.input} tnum`}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Turn Time (Hrs)</label>
              <input
                type="number"
                value={localCp.turn_time_hours ?? 0}
                onChange={(e) => handleChange("turn_time_hours", parseFloat(e.target.value))}
                className={`${styles.input} tnum`}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Load Rate (MT/Day)</label>
              <input
                type="number"
                value={localCp.load_rate ?? 0}
                onChange={(e) => handleChange("load_rate", parseFloat(e.target.value))}
                className={`${styles.input} tnum`}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Discharge Rate (MT/Day)</label>
              <input
                type="number"
                value={localCp.discharge_rate ?? 0}
                onChange={(e) => handleChange("discharge_rate", parseFloat(e.target.value))}
                className={`${styles.input} tnum`}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>NOR Variant</label>
              <select
                value={localCp.nor_variant}
                onChange={(e) => handleChange("nor_variant", e.target.value as NorVariant)}
                className={styles.select}
              >
                {NOR_VARIANTS.map((v) => (
                  <option key={v} value={v}>
                    {v.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Days Basis</label>
              <select
                value={localCp.days_basis}
                onChange={(e) => handleChange("days_basis", e.target.value as DaysBasis)}
                className={styles.select}
              >
                {DAYS_BASES.map((v) => (
                  <option key={v} value={v}>
                    {v.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Demurrage Rate/Day</label>
              <input
                type="number"
                value={localCp.demurrage_rate ?? 0}
                onChange={(e) => handleChange("demurrage_rate", parseFloat(e.target.value))}
                className={`${styles.input} tnum`}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Despatch Rate/Day</label>
              <input
                type="number"
                value={localCp.despatch_rate ?? 0}
                onChange={(e) => handleChange("despatch_rate", parseFloat(e.target.value))}
                className={`${styles.input} tnum`}
              />
            </div>
            <div className={styles.formGroupFull}>
              <label className={styles.label}>Rate Currency</label>
              <input
                type="text"
                value={localCp.currency ?? ""}
                onChange={(e) => handleChange("currency", e.target.value)}
                className={`${styles.input} tnum`}
              />
            </div>
          </div>
        </div>

        {/* Results */}
        <div className={styles.section}>
          <div className={`${styles.sectionTitle} tnum`}>Result</div>
          {result ? (
            <div className={styles.resultCard}>
              <div className={styles.resultStats}>
                <div className={styles.statRow}>
                  <span className={styles.statLabel}>Allowed</span>
                  <span className={`${styles.statValue} tnum`}>{result.totals.allowed_hours.toFixed(2)} hrs</span>
                </div>
                <div className={styles.statRow}>
                  <span className={styles.statLabel}>Used</span>
                  <span className={`${styles.statValueHighlight} tnum`}>{result.totals.used_hours.toFixed(2)} hrs</span>
                </div>
                {(result.totals.demurrage_half_rate_hours ?? 0) > 0 && (
                  <div className={styles.statRow}>
                    <span className={styles.statLabel}>Half-rate demurrage (ASBA II-8)</span>
                    <span className={`${styles.statValue} tnum`}>
                      {result.totals.demurrage_half_rate_hours!.toFixed(2)} hrs
                    </span>
                  </div>
                )}
              </div>

              <div className={styles.resultAmount} style={{ marginTop: "1rem" }}>
                {result.totals.demurrage_amount > 0 ? (
                  <div className={`${styles.resultAmountDemurrage} tnum`}>
                    -{result.totals.demurrage_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} {result.totals.currency}
                    <div className={`${styles.statLabel} tnum`} style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>DEMURRAGE</div>
                  </div>
                ) : result.totals.despatch_amount > 0 ? (
                  <div className={`${styles.resultAmountDespatch} tnum`}>
                    +{result.totals.despatch_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} {result.totals.currency}
                    <div className={`${styles.statLabel} tnum`} style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>DESPATCH</div>
                  </div>
                ) : (
                  <div className={`${styles.resultAmountNeutral} tnum`}>
                    0.00 {result.totals.currency}
                    <div className={`${styles.statLabel} tnum`} style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>NEUTRAL</div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className={styles.emptyFlags} style={{ padding: "2rem" }}>
              Calculation not available. Accept events to compute.
            </div>
          )}
        </div>

        {/* Clause Analysis */}
        <div className={styles.section}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <div className={`${styles.sectionTitle} tnum`} style={{ marginBottom: 0 }}>Clause Analysis</div>
            <button
              onClick={onRunClauseAnalysis}
              disabled={flagging}
              className={`${styles.actionBtn} tnum`}
            >
              {flagging ? "ANALYZING…" : "ANALYZE"}
            </button>
          </div>
          {clauseFlags.length > 0 ? (
            <div className={styles.flagsList}>
              {clauseFlags.map((flag) => {
                const isWarning = flag.severity === "warning";
                const isCritical = flag.severity === "critical";
                const flagClass = isCritical ? styles.flagCritical : isWarning ? styles.flagWarning : styles.flagInfo;
                return (
                  <div key={flag.id} className={`${styles.flagItem} ${flagClass}`}>
                    <div className={styles.flagHeader}>
                      <span className={`${styles.flagRef} tnum`}>{flag.clauseRef}</span>
                      <span className={`${styles.flagSeverity} tnum`}>{flag.severity}</span>
                    </div>
                    <div className={styles.flagNote}>{flag.note}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.emptyFlags}>
              No clause flags detected.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
