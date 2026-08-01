"use client";

// Fleet Schedules — forward port calls synced from the ERP.
//
// A schedule is a PLAN, not a fact, and this page says so rather than looking
// like the claims list. Nothing here creates a claim: an ETA that became a claim
// would fill the book with port calls that have not happened, which is the rule
// `erp_vessel_schedules` was created to enforce.
//
// The point of the page is the bridge. A forward schedule is the one moment
// where demurrage exposure is still avoidable — before arrival — so every row
// carries an action into the pre-arrival Monte Carlo and the Virtual Arrival
// panel beside it. A table an operator has to retype into a simulator is a table
// nobody uses twice.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Anchor,
  CalendarClock,
  Fuel,
  Gauge,
  Navigation,
  PackageOpen,
  Ship,
} from "lucide-react";
import { buildPreArrivalQuery } from "@/lib/simulator/prefill";
import styles from "./Schedules.module.css";

interface ScheduleView {
  id: string;
  vessel: string;
  vesselImo: string | null;
  voyageRef: string;
  port: string;
  portFunction: "load" | "discharge" | "bunker" | "transit" | "unknown";
  eta: string | null;
  etb: string | null;
  etd: string | null;
  laycanFrom: string | null;
  laycanTo: string | null;
  cargo: string | null;
  cargoQuantityMt: number | null;
  sourceUpdatedAt: string | null;
  externalRef: string;
  source: { provider: string; displayName: string; mode: "live" | "mock"; mappingVerified: boolean };
}

const FUNCTION_ICON = {
  load: PackageOpen,
  discharge: Anchor,
  bunker: Fuel,
  transit: Navigation,
  unknown: Ship,
} as const;

const FUNCTION_LABEL = {
  load: "Load",
  discharge: "Discharge",
  bunker: "Bunker",
  transit: "Transit",
  unknown: "—",
} as const;

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Days until an ETA. Negative means it has passed. */
function leadDays(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86_400_000);
}

/**
 * How the lead time reads.
 *
 * Not a risk score — this page has no weather and no queue data, and a coloured
 * "risk" badge derived from a date alone would be exactly the invented figure
 * the rest of the system refuses to produce. It reports proximity, and the
 * action next to it is what produces an actual assessment.
 */
function leadLabel(days: number | null): { text: string; cls: string } {
  if (days === null) return { text: "no ETA", cls: styles.leadNone };
  if (days < 0) return { text: `${Math.abs(days)}d ago`, cls: styles.leadPast };
  if (days === 0) return { text: "today", cls: styles.leadNow };
  if (days <= 3) return { text: `in ${days}d`, cls: styles.leadNow };
  if (days <= 10) return { text: `in ${days}d`, cls: styles.leadSoon };
  return { text: `in ${days}d`, cls: styles.leadFar };
}

export default function FleetSchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [hasIntegration, setHasIntegration] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    // `cancelled` guards every write: toggling "include past calls" twice in
    // quick succession must not let the slower response overwrite the newer one.
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const d = await fetch(
          `/api/integrations/schedules${showAll ? "?window=all" : ""}`
        ).then((r) => r.json());
        if (cancelled) return;
        if (d.error) throw new Error(d.error);
        setSchedules(d.schedules ?? []);
        setHasIntegration(Boolean(d.hasIntegration));
        setError(null);
      } catch {
        if (!cancelled) setError("Could not load vessel schedules.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [showAll]);

  const anyMock = useMemo(() => schedules.some((s) => s.source.mode === "mock"), [schedules]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            <CalendarClock size={20} /> Fleet Schedules
          </h1>
          <p className={styles.subtitle}>
            Forward port calls synced from your ERP. These are <strong>plans, not claims</strong> —
            nothing here is in your claims book, and an ETA never becomes one on its own. This is
            the window where demurrage is still avoidable, so each call links straight into the
            pre-arrival risk engine.
          </p>
        </div>
        <label className={styles.toggle}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          <span>Include past calls</span>
        </label>
      </header>

      {anyMock && (
        <p className={styles.mockWarn}>
          <AlertCircle size={14} /> Some rows come from a <strong>mock</strong> ERP integration and
          are fixture data, not a real schedule. Any assessment run from them is a rehearsal.
        </p>
      )}

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {loading ? (
        <p className={styles.loading}>Loading schedules…</p>
      ) : schedules.length === 0 ? (
        <div className={styles.empty}>
          {hasIntegration ? (
            <>
              <h2>No upcoming port calls</h2>
              <p>
                Your ERP integration is connected but has returned no forward schedules
                {showAll ? "" : " for the period ahead"}. Schedules arrive on the{" "}
                <code>pull_schedules</code> sync.
              </p>
              {!showAll && (
                <button className={styles.linkBtn} onClick={() => setShowAll(true)}>
                  Include past calls
                </button>
              )}
            </>
          ) : (
            <>
              <h2>No ERP connected</h2>
              <p>
                Fleet schedules are pulled from your ERP — Veson IMOS, Danaos, Fortune or Ulysses.
                Connect one under <Link href="/settings">Settings → API &amp; Developers</Link> and
                run a <code>pull_schedules</code> sync.
              </p>
            </>
          )}
        </div>
      ) : null}

      {schedules.length > 0 && (
        <ul className={styles.list}>
          {schedules.map((s) => {
            const Icon = FUNCTION_ICON[s.portFunction] ?? Ship;
            const days = leadDays(s.eta);
            const lead = leadLabel(days);
            const query = buildPreArrivalQuery(s);
            // A past call cannot be de-risked; the action would open a
            // simulator for a decision already taken.
            const actionable = days !== null && days >= 0;

            return (
              <li key={s.id} className={styles.row}>
                <div className={styles.fn} title={FUNCTION_LABEL[s.portFunction]}>
                  <Icon size={16} />
                </div>

                <div className={styles.main}>
                  <div className={styles.headLine}>
                    <strong className={styles.vessel}>{s.vessel}</strong>
                    {s.voyageRef && <span className={styles.voyage}>{s.voyageRef}</span>}
                    <span className={`${styles.lead} ${lead.cls}`}>{lead.text}</span>
                    {s.source.mode === "mock" && <span className={styles.mockTag}>mock</span>}
                  </div>
                  <div className={styles.portLine}>
                    <span className={styles.port}>{s.port || "—"}</span>
                    <span className={styles.fnLabel}>{FUNCTION_LABEL[s.portFunction]}</span>
                    {s.cargo && (
                      <span className={styles.cargo}>
                        {s.cargo}
                        {s.cargoQuantityMt
                          ? ` · ${s.cargoQuantityMt.toLocaleString("en-US")} mt`
                          : ""}
                      </span>
                    )}
                  </div>
                  <div className={styles.times}>
                    <span>
                      <em>ETA</em> {fmt(s.eta)}
                    </span>
                    <span>
                      <em>ETB</em> {fmt(s.etb)}
                    </span>
                    <span>
                      <em>ETD</em> {fmt(s.etd)}
                    </span>
                    {(s.laycanFrom || s.laycanTo) && (
                      <span>
                        <em>Laycan</em> {fmt(s.laycanFrom)} – {fmt(s.laycanTo)}
                      </span>
                    )}
                  </div>
                  <p className={styles.provenance}>
                    {s.source.displayName} · <span className="tnum">{s.externalRef}</span>
                    {s.sourceUpdatedAt && <> · ERP updated {fmt(s.sourceUpdatedAt)}</>}
                    {!s.source.mappingVerified && (
                      <span className={styles.unverified}>
                        {" "}
                        · field mapping not verified against vendor documentation
                      </span>
                    )}
                  </p>
                </div>

                <div className={styles.actions}>
                  {actionable ? (
                    <Link
                      className={styles.assess}
                      href={`/simulator/pre-arrival?${query}`}
                      title="Open the pre-arrival Monte Carlo with this port call's details filled in"
                    >
                      <Gauge size={14} /> Assess risk
                    </Link>
                  ) : (
                    <span className={styles.assessOff} title="This call has already happened.">
                      <Gauge size={14} /> Assess risk
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {schedules.length > 0 && (
        <p className={styles.footNote}>
          “Assess risk” carries the vessel, port, ETA, cargo and operation into the simulator.
          Charterparty terms — laytime allowance, days basis, demurrage and despatch rates — are{" "}
          <strong>not</strong> carried, because an ERP schedule does not contain them. They stay at
          the simulator&apos;s defaults until you set them, rather than producing an exposure figure
          that looks derived from your ERP and is not.
        </p>
      )}
    </div>
  );
}
