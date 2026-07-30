"use client";

import { useEffect, useState } from "react";
import { RotateCcw, Check } from "lucide-react";
import styles from "./CargoProfileSettings.module.css";

interface Profile {
  cargoKey: string;
  label: string;
  precipMmPerHr: number | null;
  windKn: number | null;
  gustKn: number | null;
  minStoppageMinutes: number;
  defaultMinStoppageMinutes: number;
  overridden: boolean;
  sourceLabel: string;
  notes: string | null;
}

/**
 * Tenant tuning for the minimum stoppage duration.
 *
 * Only this one parameter is editable. The thresholds themselves decide money
 * and belong behind a review step, not a settings input — but how long an
 * interruption must last before it counts is genuinely local: it varies by
 * terminal practice and by what a desk has historically been able to argue.
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
    } catch {
      setError("Could not load cargo profiles.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(cargoKey: string, minutes: number) {
    setSavingKey(cargoKey);
    setError(null);
    try {
      const res = await fetch("/api/settings/cargo-profiles", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cargoKey, minStoppageMinutes: minutes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setProfiles((prev) =>
        prev.map((p) =>
          p.cargoKey === cargoKey
            ? { ...p, minStoppageMinutes: minutes, overridden: minutes !== p.defaultMinStoppageMinutes }
            : p
        )
      );
      setSavedKey(cargoKey);
      setTimeout(() => setSavedKey(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      void load(); // never leave a figure on screen the server did not accept
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) return <p className={styles.loading}>Loading cargo profiles…</p>;

  return (
    <div className={styles.wrap}>
      <p className={styles.intro}>
        How long a weather interruption must last before it counts as lost time. Shorter
        interruptions are ignored — a ten-minute shower is not a stoppage. Changing this creates an
        override for your company; the shared baseline is untouched.
      </p>

      {error && <p className={styles.error}>{error}</p>}

      <ul className={styles.list}>
        {profiles.map((p) => (
          <li key={p.cargoKey} className={styles.row}>
            <div className={styles.main}>
              <div className={styles.head}>
                <strong>{p.label}</strong>
                {p.overridden && <span className={styles.tag}>tuned</span>}
              </div>
              <p className={styles.thresholds}>
                {p.precipMmPerHr !== null
                  ? `rain ≥ ${p.precipMmPerHr} mm/h`
                  : "insensitive to rain"}
                {p.windKn !== null ? ` · wind ≥ ${p.windKn} kn` : ""}
                {p.gustKn !== null ? ` · gusts ≥ ${p.gustKn} kn` : ""}
              </p>
            </div>

            <div className={styles.control}>
              <label htmlFor={`min-${p.cargoKey}`} className={styles.controlLabel}>
                Minimum stoppage
              </label>
              <div className={styles.inputRow}>
                <input
                  id={`min-${p.cargoKey}`}
                  type="number"
                  min={5}
                  max={1440}
                  step={5}
                  value={p.minStoppageMinutes}
                  disabled={savingKey === p.cargoKey}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setProfiles((prev) =>
                      prev.map((x) =>
                        x.cargoKey === p.cargoKey ? { ...x, minStoppageMinutes: v } : x
                      )
                    );
                  }}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    // Out of range: snap back rather than leave an unsaved
                    // figure on screen. The input is locally controlled, so a
                    // value that was never accepted would otherwise sit there
                    // looking saved — the same class of divergence the voyage
                    // P&L sheet had to fix.
                    if (!Number.isFinite(v) || v < 5 || v > 1440) {
                      void load();
                      return;
                    }
                    void save(p.cargoKey, v);
                  }}
                />
                <span className={styles.unit}>min</span>
                {savedKey === p.cargoKey && (
                  <span className={styles.saved}>
                    <Check size={13} /> saved
                  </span>
                )}
                {p.overridden && p.minStoppageMinutes !== p.defaultMinStoppageMinutes && (
                  <button
                    type="button"
                    className={styles.reset}
                    title={`Reset to the ${p.defaultMinStoppageMinutes}-minute baseline`}
                    onClick={() => void save(p.cargoKey, p.defaultMinStoppageMinutes)}
                  >
                    <RotateCcw size={12} /> {p.defaultMinStoppageMinutes}
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
