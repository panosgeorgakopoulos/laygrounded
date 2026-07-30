"use client";

import { useState } from "react";
import { CloudRain, Wind, Thermometer, AlertTriangle, Check } from "lucide-react";
import styles from "./WwdResolverPanel.module.css";

interface ExceptedBlock {
  from: string;
  to: string;
  hours: number;
  dimensions: string[];
  reason: string;
}

interface Interval {
  from: string;
  to: string;
}

interface Resolution {
  blocks: ExceptedBlock[];
  totalExceptedHours: number;
  gaps: Interval[];
  gapHours: number;
  observedHours: number;
  agreement: { both: Interval[]; claimedOnly: Interval[]; resolvedOnly: Interval[] };
  profile: { cargoKey: string; label: string; sourceLabel: string };
  warnings: string[];
}

interface RunResult {
  resolution: Resolution | null;
  unavailable: string | null;
  window: Interval | null;
  port: { name: string; lat: number; lon: number } | null;
  createdEventIds: string[];
}

const DIMENSION_ICON: Record<string, typeof CloudRain> = {
  precipitation: CloudRain,
  wind: Wind,
  gust: Wind,
  temperature: Thermometer,
};

function fmt(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function hoursOf(list: Interval[]): number {
  return (
    Math.round(
      (list.reduce(
        (s, i) => s + (new Date(i.to).getTime() - new Date(i.from).getTime()),
        0
      ) /
        3_600_000) *
        10
    ) / 10
  );
}

/**
 * On-demand Weather Working Day resolver.
 *
 * Two steps on purpose. The first run only previews: nothing is written until
 * the operator has seen what would be suggested. A machine appending stoppages
 * to a Master's statement of facts unasked is exactly the behaviour that would
 * make an operator distrust the whole feature.
 */
export function WwdResolverPanel({
  claimId,
  onApplied,
}: {
  claimId: string;
  onApplied?: () => void;
}) {
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/wwd-resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apply }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Resolver failed");
      setResult(json);
      if (apply && json.createdEventIds?.length > 0) {
        setApplied(true);
        onApplied?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resolver failed");
    } finally {
      setBusy(false);
    }
  }

  const r = result?.resolution;
  // Only stoppages the SoF does not already claim become new suggestions.
  const newCount = r ? r.agreement.resolvedOnly.length : 0;

  return (
    <section className={styles.wrap} aria-label="Weather Working Day resolver">
      <header className={styles.head}>
        <div>
          <h3 className={styles.title}>Weather Working Day resolver</h3>
          <p className={styles.sub}>
            Overlays the hourly weather archive on this voyage and applies the cargo&rsquo;s own
            sensitivity thresholds. Deterministic — same readings, same result, every time.
          </p>
        </div>
        <button type="button" className={styles.runBtn} disabled={busy} onClick={() => run(false)}>
          {busy ? "Resolving…" : result ? "Re-run" : "Run resolver"}
        </button>
      </header>

      {error && <p className={styles.error}>{error}</p>}

      {result?.unavailable && (
        <div className={styles.unavailable}>
          <AlertTriangle size={15} />
          <p>{result.unavailable}</p>
        </div>
      )}

      {r && (
        <>
          <div className={styles.summaryRow}>
            <div className={styles.stat}>
              <span className={`${styles.statValue} tnum`}>{r.totalExceptedHours}h</span>
              <span className={styles.statLabel}>weather time resolved</span>
            </div>
            <div className={styles.stat}>
              <span className={`${styles.statValue} tnum`}>{r.blocks.length}</span>
              <span className={styles.statLabel}>stoppage{r.blocks.length === 1 ? "" : "s"}</span>
            </div>
            <div className={styles.stat}>
              <span className={`${styles.statValue} tnum`}>{r.observedHours}h</span>
              <span className={styles.statLabel}>hours observed</span>
            </div>
            {r.gapHours > 0 && (
              <div className={`${styles.stat} ${styles.statGap}`}>
                <span className={`${styles.statValue} tnum`}>{r.gapHours}h</span>
                <span className={styles.statLabel}>no data</span>
              </div>
            )}
          </div>

          <p className={styles.profileLine}>
            Cargo profile: <strong>{r.profile.label}</strong>
            <span className={styles.provenance}>{r.profile.sourceLabel}</span>
          </p>

          {/* Agreement — the honest part: what the SoF says vs what the sky did. */}
          <div className={styles.agreement}>
            <div className={styles.agreeCell}>
              <span className={`${styles.agreeValue} tnum`}>{hoursOf(r.agreement.both)}h</span>
              <span className={styles.agreeLabel}>agree with the SoF</span>
            </div>
            <div className={`${styles.agreeCell} ${styles.agreeAdd}`}>
              <span className={`${styles.agreeValue} tnum`}>
                {hoursOf(r.agreement.resolvedOnly)}h
              </span>
              <span className={styles.agreeLabel}>found, not on the SoF</span>
            </div>
            <div className={`${styles.agreeCell} ${styles.agreeDispute}`}>
              <span className={`${styles.agreeValue} tnum`}>
                {hoursOf(r.agreement.claimedOnly)}h
              </span>
              <span className={styles.agreeLabel}>claimed, data disagrees</span>
            </div>
          </div>

          {r.blocks.length > 0 && (
            <ul className={styles.blockList}>
              {r.blocks.map((b) => {
                const isNew = r.agreement.resolvedOnly.some((i) => i.from === b.from);
                const Icon = DIMENSION_ICON[b.dimensions[0]] ?? CloudRain;
                return (
                  <li key={b.from} className={styles.block}>
                    <span className={styles.blockIcon}>
                      <Icon size={14} />
                    </span>
                    <div className={styles.blockMain}>
                      <div className={styles.blockHead}>
                        <span className="tnum">{fmt(b.from)}</span>
                        <span className={styles.arrow}>→</span>
                        <span className="tnum">{fmt(b.to)}</span>
                        <span className={styles.blockHours}>{b.hours}h</span>
                        {isNew ? (
                          <span className={styles.newTag}>new</span>
                        ) : (
                          <span className={styles.knownTag}>already on SoF</span>
                        )}
                      </div>
                      <p className={styles.blockReason}>{b.reason}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {r.warnings.length > 0 && (
            <ul className={styles.warnings}>
              {r.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <footer className={styles.footer}>
            {applied ? (
              <p className={styles.applied}>
                <Check size={14} /> {result?.createdEventIds.length} suggested event
                {result?.createdEventIds.length === 1 ? "" : "s"} added to the timeline. Review and
                accept them there — nothing counts until you do.
              </p>
            ) : newCount > 0 ? (
              <>
                <p className={styles.footNote}>
                  Applying adds these as <strong>suggested</strong> events. They do not affect the
                  calculation until you accept them on the timeline.
                </p>
                <button
                  type="button"
                  className={styles.applyBtn}
                  disabled={busy}
                  onClick={() => run(true)}
                >
                  Add {newCount} suggested event{newCount === 1 ? "" : "s"}
                </button>
              </>
            ) : (
              <p className={styles.footNote}>
                Nothing new to suggest — the statement of facts already records every stoppage the
                archive supports.
              </p>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
