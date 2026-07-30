"use client";

import { useEffect, useState } from "react";
import { RotateCcw, Check } from "lucide-react";
import styles from "./CargoProfileSettings.module.css";

interface Baseline {
  precipMmPerHr: number | null;
  windKn: number | null;
  gustKn: number | null;
  minStoppageMinutes: number;
}

interface Profile extends Baseline {
  cargoKey: string;
  label: string;
  baseline: Baseline;
  overridden: boolean;
  overriddenDimensions: string[];
  sourceLabel: string;
  notes: string | null;
}

type Field = "precipMmPerHr" | "windKn" | "gustKn" | "minStoppageMinutes";

const FIELDS: Array<{
  key: Field;
  label: string;
  unit: string;
  step: number;
  dimension: string;
  nullable: boolean;
}> = [
  { key: "precipMmPerHr", label: "Rain", unit: "mm/h", step: 0.1, dimension: "precipitation", nullable: true },
  { key: "windKn", label: "Wind", unit: "kn", step: 1, dimension: "wind", nullable: true },
  { key: "gustKn", label: "Gusts", unit: "kn", step: 1, dimension: "gust", nullable: true },
  { key: "minStoppageMinutes", label: "Min. stoppage", unit: "min", step: 5, dimension: "duration", nullable: false },
];

/**
 * Tenant tuning for every weather threshold.
 *
 * Editing writes a tenant-scoped override; the shared baseline is never
 * touched. Each changed threshold is labelled, and the resolver attributes any
 * stoppage it decides to this company rather than to LayGrounded — which is
 * what makes offering the control safe rather than a way to quietly engineer a
 * number.
 */
export function CargoProfileSettings() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/settings/cargo-profiles").then((x) => x.json());
      setProfiles(r.profiles ?? []);
      setError(null);
    } catch {
      setError("Could not load cargo profiles.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(cargoKey: string, patch: Partial<Record<Field, number | null>>) {
    setSavingKey(cargoKey);
    setError(null);
    try {
      const res = await fetch("/api/settings/cargo-profiles", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cargoKey, ...patch }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setSavedKey(cargoKey);
      setTimeout(() => setSavedKey(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingKey(null);
      // Always reload from the server. The inputs are locally controlled, so a
      // value that was never accepted would otherwise sit on screen looking
      // saved — and the server may have reverted the row to baseline entirely.
      await load();
    }
  }

  if (loading) return <p className={styles.loading}>Loading cargo profiles…</p>;

  return (
    <div className={styles.wrap}>
      <p className={styles.intro}>
        What weather stops work for each cargo. Changing any figure creates an override for your
        company — the shared baseline is untouched for everyone else. Blank means{" "}
        <strong>insensitive</strong> to that condition, which is different from zero.
      </p>
      <p className={styles.provenanceNote}>
        Every threshold you change is recorded. When a custom threshold decides an excepted hour,
        the resolver labels that stoppage <em>tenant custom threshold</em> rather than{" "}
        <em>LayGrounded baseline</em>, so a counterparty always knows whose rule was applied.
      </p>

      {error && <p className={styles.error}>{error}</p>}

      <ul className={styles.list}>
        {profiles.map((p) => (
          <li key={p.cargoKey} className={styles.row}>
            <div className={styles.main}>
              <div className={styles.head}>
                <strong>{p.label}</strong>
                {p.overridden && <span className={styles.tag}>custom</span>}
                {savedKey === p.cargoKey && (
                  <span className={styles.saved}>
                    <Check size={13} /> saved
                  </span>
                )}
              </div>
              {p.overridden && p.overriddenDimensions.length > 0 && (
                <p className={styles.overrideNote}>
                  Custom: {p.overriddenDimensions.join(", ")} — the rest use the baseline.
                </p>
              )}
            </div>

            <div className={styles.fields}>
              {FIELDS.map((f) => {
                const value = p[f.key];
                const base = p.baseline[f.key];
                const changed = value !== base;
                return (
                  <div key={f.key} className={styles.field}>
                    <label htmlFor={`${f.key}-${p.cargoKey}`} className={styles.fieldLabel}>
                      {f.label}
                    </label>
                    <div className={styles.inputRow}>
                      <input
                        id={`${f.key}-${p.cargoKey}`}
                        type="number"
                        min={0}
                        step={f.step}
                        placeholder={f.nullable ? "—" : undefined}
                        value={value === null ? "" : value}
                        disabled={savingKey === p.cargoKey}
                        className={changed ? styles.changed : undefined}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const v = raw === "" ? null : Number(raw);
                          setProfiles((prev) =>
                            prev.map((x) => (x.cargoKey === p.cargoKey ? { ...x, [f.key]: v } : x))
                          );
                        }}
                        onBlur={(e) => {
                          const raw = e.target.value;
                          // Blank on a non-nullable field is not "insensitive",
                          // it is a mistake — reload rather than store nonsense.
                          if (raw === "" && !f.nullable) return void load();
                          const v = raw === "" ? null : Number(raw);
                          if (v !== null && (!Number.isFinite(v) || v < 0)) return void load();
                          if (v === base && !p.overridden) return;
                          void save(p.cargoKey, { [f.key]: v });
                        }}
                      />
                      <span className={styles.unit}>{f.unit}</span>
                    </div>
                    {changed && (
                      <button
                        type="button"
                        className={styles.reset}
                        title={`Reset to the baseline (${base === null ? "insensitive" : base} ${f.unit})`}
                        onClick={() => void save(p.cargoKey, { [f.key]: base })}
                      >
                        <RotateCcw size={11} /> {base === null ? "—" : base}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
