"use client";

// Who you are actually dealing with, computed from your own book.
//
// THE PRIVACY SHAPE IS THE PRODUCT DECISION, and the UI states it rather than
// burying it. Every figure here comes from the viewing company's OWN claims —
// their settlements, their evidence checks, their proposal history. No other
// tenant's data is used, and no score computed here is shared with anyone. That
// is what makes it defensible to show a named counterparty's behaviour at all.
//
// Nothing is cached. The profile is a view over live claims, which is what makes
// the correction path real: a counterparty who disputes what is recorded gets it
// fixed by correcting the underlying claim, and the profile changes on the next
// read. A stored score would need a separate correction mechanism nobody would
// build.
//
// Sanctions are reported ALONGSIDE the band, never folded into it. A screening
// hit is public-record fact about an entity; a risk band is a summary of how
// they have behaved with you. Merging them would let a name collision look like
// a payment history.

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, ShieldAlert, Users } from "lucide-react";
import styles from "./CounterpartyIntel.module.css";

interface RiskSignal {
  key: string;
  label: string;
  verdict: string;
  value: number | null;
  unit: "percent" | "days" | "count";
  observations: number;
  detail: string;
}

interface Profile {
  counterpartyName: string;
  band: "low" | "moderate" | "elevated" | "unrated";
  drivers: string[];
  totalClaims: number;
  settledClaims: number;
  signals: RiskSignal[];
  sanctions: { verdict?: string; summary?: string } | null;
  methodology: string;
  correctionPath: string;
}

const BAND_CLASS: Record<Profile["band"], string> = {
  low: "low",
  moderate: "moderate",
  elevated: "elevated",
  unrated: "unrated",
};

function fmt(v: number | null, unit: RiskSignal["unit"]): string {
  if (v === null) return "—";
  if (unit === "percent") return `${Math.round(v)}%`;
  if (unit === "days") return `${Math.round(v)}d`;
  return String(v);
}

export function CounterpartyIntel() {
  const [list, setList] = useState<Array<{ name: string; claims: number }>>([]);
  const [selected, setSelected] = useState<string>("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const d = await fetch("/api/intel/counterparty").then((r) => r.json());
        if (cancelled) return;
        if (d.error) throw new Error(d.error);
        setList(d.counterparties ?? []);
        setError(null);
      } catch {
        if (!cancelled) setError("Could not load your counterparties.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadProfile = useCallback(async (name: string) => {
    setLoadingProfile(true);
    setError(null);
    try {
      const d = await fetch(`/api/intel/counterparty?name=${encodeURIComponent(name)}`).then((r) =>
        r.json()
      );
      if (d.error) throw new Error(d.error);
      setProfile((d.profile ?? d) as Profile);
    } catch {
      setError(`Could not load the profile for ${name}.`);
      setProfile(null);
    } finally {
      setLoadingProfile(false);
    }
  }, []);

  if (loading) {
    return (
      <div className={styles.wrap}>
        <p className={styles.loading}>
          <Loader2 size={13} className={styles.spin} /> Loading counterparties…
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h3 className={styles.title}>
          <Users size={15} /> Counterparty intelligence
        </h3>
      </header>

      <p className={styles.intro}>
        How each counterparty has actually behaved <strong>with you</strong> — recovery rates,
        settlement speed, how often their position survived evidence. Computed from your own book
        only: no other customer&apos;s data is used, and nothing computed here is shared.
      </p>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {list.length === 0 ? (
        <p className={styles.empty}>
          No counterparties are recorded yet. Set a counterparty name on a claim and its history
          starts accumulating here.
        </p>
      ) : (
        <label className={styles.picker}>
          <span className={styles.label}>Counterparty</span>
          <select
            className={styles.select}
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              if (e.target.value) void loadProfile(e.target.value);
              else setProfile(null);
            }}
          >
            <option value="">Select…</option>
            {list.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.claims} claim{c.claims === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        </label>
      )}

      {loadingProfile && (
        <p className={styles.loading}>
          <Loader2 size={13} className={styles.spin} /> Computing profile…
        </p>
      )}

      {profile && !loadingProfile && (
        <div className={styles.profile}>
          <div className={styles.bandRow}>
            <strong className={styles.name}>{profile.counterpartyName}</strong>
            <span className={`${styles.band} ${styles[BAND_CLASS[profile.band]]}`}>
              {profile.band}
            </span>
            <span className={styles.counts}>
              {profile.totalClaims} claim{profile.totalClaims === 1 ? "" : "s"} ·{" "}
              {profile.settledClaims} settled
            </span>
          </div>

          {profile.drivers.length > 0 && (
            <ul className={styles.drivers}>
              {profile.drivers.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}

          <ul className={styles.signals}>
            {profile.signals.map((s) => (
              <li key={s.key} className={styles.signal}>
                <span className={styles.sigLabel}>{s.label}</span>
                <span
                  className={`${styles.sigValue} tnum ${
                    s.verdict === "insufficient_data" ? styles.thin : ""
                  }`}
                >
                  {fmt(s.value, s.unit)}
                </span>
                <span className={styles.sigDetail}>{s.detail}</span>
              </li>
            ))}
          </ul>

          {profile.sanctions && (
            <p className={styles.sanctions}>
              <ShieldAlert size={13} /> Sanctions screening:{" "}
              <strong>{profile.sanctions.verdict ?? "unavailable"}</strong>
              {profile.sanctions.summary ? ` — ${profile.sanctions.summary}` : ""}
              <span className={styles.sanctionsNote}>
                Public-record data, reported as the provider returned it and deliberately{" "}
                <em>not</em> folded into the band above — a name collision must not read as a
                payment history.
              </span>
            </p>
          )}

          <p className={styles.methodology}>{profile.methodology}</p>
          <p className={styles.methodology}>{profile.correctionPath}</p>
        </div>
      )}
    </div>
  );
}
