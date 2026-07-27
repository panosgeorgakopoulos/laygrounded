"use client";

// Defense Mode — the inbound side of the desk.
//
// Every other surface in this app helps you build a claim. This one adjudicates
// a claim someone has sent to you: paste what they assert, and the same
// deterministic engine that computes our claims recomputes theirs, priced
// against their own submission.

import { useCallback, useEffect, useState } from "react";
import styles from "./Defense.module.css";

interface AuditSummary {
  defensiblePosition: number;
  totalChallenged: number;
  arithmeticDelta: number;
  computedAt: string;
}

interface InboundClaim {
  id: string;
  claimantName: string;
  vessel: string;
  voyageRef: string | null;
  port: string | null;
  cargo: string | null;
  claimedAmount: number;
  currency: string;
  receivedAt: string;
  respondBy: string | null;
  status: string;
  resolvedAmount: number | null;
  audit: AuditSummary | null;
}

interface Challenge {
  id: string;
  basis: "arithmetic" | "evidence" | "terms" | "clause";
  strength: "conclusive" | "strong" | "arguable";
  label: string;
  rationale: string;
  clauseRef?: string;
  reduction: number;
  eventIds: string[];
}

interface AuditResult {
  claimedAmount: number;
  recomputedAmount: number;
  currency: string;
  arithmeticDelta: number;
  challenges: Challenge[];
  defensiblePosition: number;
  totalChallenged: number;
  notes: string[];
}

const EVENT_TYPES = [
  "NOR_TENDERED",
  "ALL_FAST",
  "COMMENCED_LOADING",
  "COMMENCED_DISCHARGE",
  "COMPLETED_LOADING",
  "COMPLETED_DISCHARGE",
  "WEATHER_DELAY",
  "WEATHER_DELAY_END",
  "SHIFTING",
  "SHIFTING_END",
] as const;

const DAYS_BASES = [
  "SHINC",
  "SHEX",
  "SHEX-UU",
  "WWDSHEX-EIU",
  "SSHEX",
  "SSHEX-UU",
  "WWDSSHEX-EIU",
] as const;

interface EventRow {
  occurredAt: string;
  eventType: string;
}

function money(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function readJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export default function DefenseModePage() {
  const [claims, setClaims] = useState<InboundClaim[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [auditedId, setAuditedId] = useState<string | null>(null);

  // ── Intake form ─────────────────────────────────────────────────────────
  const [claimantName, setClaimantName] = useState("");
  const [vessel, setVessel] = useState("");
  const [voyageRef, setVoyageRef] = useState("");
  const [port, setPort] = useState("");
  const [claimedAmount, setClaimedAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [laytimeHours, setLaytimeHours] = useState("72");
  const [turnTime, setTurnTime] = useState("6");
  const [demurrageRate, setDemurrageRate] = useState("24000");
  const [despatchRate, setDespatchRate] = useState("12000");
  const [daysBasis, setDaysBasis] = useState<string>("WWDSHEX-EIU");
  const [ourLaytimeHours, setOurLaytimeHours] = useState("");
  const [ourDemurrageRate, setOurDemurrageRate] = useState("");
  const [events, setEvents] = useState<EventRow[]>([
    { occurredAt: "", eventType: "NOR_TENDERED" },
    { occurredAt: "", eventType: "ALL_FAST" },
    { occurredAt: "", eventType: "COMPLETED_LOADING" },
  ]);

  // `claims === null` IS the loading state, so there is no separate flag to set
  // unconditionally — every setState below sits behind a condition, which keeps
  // the mount effect free of a synchronous state update.
  const load = useCallback(async () => {
    const res = await fetch("/api/defense/claims");
    const json = await readJson(res);
    if (res.ok && json?.claims) setClaims(json.claims);
    else {
      setError(json?.error ?? "Could not load the inbound book.");
      setClaims([]);
    }
  }, []);

  // The fetch is kicked off inside a nested async closure and guarded by
  // `cancelled`, so no state update happens in the effect body itself and a
  // response arriving after unmount is dropped.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/defense/claims");
      const json = await readJson(res);
      if (cancelled) return;
      if (res.ok && json?.claims) setClaims(json.claims);
      else {
        setError(json?.error ?? "Could not load the inbound book.");
        setClaims([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const addEvent = () =>
    setEvents((rows) => [...rows, { occurredAt: "", eventType: "WEATHER_DELAY" }]);

  const updateEvent = (i: number, patch: Partial<EventRow>) =>
    setEvents((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const removeEvent = (i: number) =>
    setEvents((rows) => rows.filter((_, idx) => idx !== i));

  async function submitClaim(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const claimantEvents = events
      .filter((r) => r.occurredAt)
      .map((r, i) => ({
        id: `claimant-${i}`,
        // datetime-local gives no zone; the engine requires one, and treating a
        // counterparty's timestamps as anything but what they wrote would be
        // putting words in their mouth. UTC is stated explicitly in the UI.
        occurred_at: new Date(`${r.occurredAt}:00Z`).toISOString(),
        event_type: r.eventType,
      }));

    if (claimantEvents.length === 0) {
      setError("Add at least one event from the claimant's statement of facts.");
      setBusy(false);
      return;
    }

    const body = {
      claimantName,
      vessel,
      voyageRef: voyageRef || undefined,
      port: port || undefined,
      claimedAmount: Number(claimedAmount),
      currency,
      claimantEvents,
      claimantCpTerms: {
        laytime_allowed_hours: Number(laytimeHours),
        turn_time_hours: Number(turnTime),
        demurrage_rate: Number(demurrageRate),
        despatch_rate: Number(despatchRate),
        days_basis: daysBasis,
        nor_variant: "WIBON",
        currency,
        cp_form: "GENCON94",
        port_timezone: "UTC",
      },
      ourCpTerms:
        ourLaytimeHours || ourDemurrageRate
          ? {
              ...(ourLaytimeHours ? { laytime_allowed_hours: Number(ourLaytimeHours) } : {}),
              ...(ourDemurrageRate ? { demurrage_rate: Number(ourDemurrageRate) } : {}),
            }
          : undefined,
    };

    const res = await fetch("/api/defense/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await readJson(res);
    setBusy(false);

    if (!res.ok) {
      setError(json?.error ?? "Could not record the claim.");
      return;
    }
    setClaimantName("");
    setVessel("");
    setClaimedAmount("");
    setEvents([
      { occurredAt: "", eventType: "NOR_TENDERED" },
      { occurredAt: "", eventType: "ALL_FAST" },
      { occurredAt: "", eventType: "COMPLETED_LOADING" },
    ]);
    await load();
    await runAudit(json.id);
  }

  async function runAudit(id: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/defense/claims/${id}/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evidenceUnavailable: true }),
    });
    const json = await readJson(res);
    setBusy(false);
    if (!res.ok) {
      setError(json?.error ?? "The audit could not be run.");
      return;
    }
    setAudit(json.audit);
    setAuditedId(id);
    await load();
  }

  return (
    <div>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Defense Mode</h1>
        <p className={styles.pageSub}>
          Audit a demurrage claim made against you. The claimant&apos;s own events and own CP
          terms go through the same deterministic engine that computes our claims — so every
          reduction is one they can reproduce themselves, not an opinion.
        </p>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.grid}>
        {/* ── Intake ──────────────────────────────────────────────────────── */}
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Record an inbound claim</h2>
          <p className={styles.cardSub}>
            Enter what the claimant asserts. Timestamps are read as UTC.
          </p>

          <form onSubmit={submitClaim}>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>Claimant</span>
                <input
                  value={claimantName}
                  onChange={(e) => setClaimantName(e.target.value)}
                  required
                  placeholder="Owner / disponent owner"
                />
              </label>
              <label className={styles.field}>
                <span>Vessel</span>
                <input value={vessel} onChange={(e) => setVessel(e.target.value)} required />
              </label>
              <label className={styles.field}>
                <span>Voyage ref</span>
                <input value={voyageRef} onChange={(e) => setVoyageRef(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span>Port</span>
                <input value={port} onChange={(e) => setPort(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span>Amount invoiced</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={claimedAmount}
                  onChange={(e) => setClaimedAmount(e.target.value)}
                  required
                />
              </label>
              <label className={styles.field}>
                <span>Currency</span>
                <input
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  maxLength={3}
                />
              </label>
            </div>

            <h3 className={styles.subhead}>CP terms as the claimant applied them</h3>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>Laytime allowed (h)</span>
                <input
                  type="number"
                  value={laytimeHours}
                  onChange={(e) => setLaytimeHours(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>Turn time (h)</span>
                <input type="number" value={turnTime} onChange={(e) => setTurnTime(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span>Demurrage / day</span>
                <input
                  type="number"
                  value={demurrageRate}
                  onChange={(e) => setDemurrageRate(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>Despatch / day</span>
                <input
                  type="number"
                  value={despatchRate}
                  onChange={(e) => setDespatchRate(e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>Laytime basis</span>
                <select value={daysBasis} onChange={(e) => setDaysBasis(e.target.value)}>
                  {DAYS_BASES.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <h3 className={styles.subhead}>
              Your fixture, where it differs <span className={styles.optional}>optional</span>
            </h3>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>Laytime allowed (h)</span>
                <input
                  type="number"
                  value={ourLaytimeHours}
                  onChange={(e) => setOurLaytimeHours(e.target.value)}
                  placeholder="leave blank if agreed"
                />
              </label>
              <label className={styles.field}>
                <span>Demurrage / day</span>
                <input
                  type="number"
                  value={ourDemurrageRate}
                  onChange={(e) => setOurDemurrageRate(e.target.value)}
                  placeholder="leave blank if agreed"
                />
              </label>
            </div>

            <h3 className={styles.subhead}>Their statement of facts</h3>
            {events.map((row, i) => (
              <div key={i} className={styles.eventRow}>
                <input
                  type="datetime-local"
                  value={row.occurredAt}
                  onChange={(e) => updateEvent(i, { occurredAt: e.target.value })}
                />
                <select
                  value={row.eventType}
                  onChange={(e) => updateEvent(i, { eventType: e.target.value })}
                >
                  {EVENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => removeEvent(i)}
                  aria-label="Remove event"
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className={styles.ghostBtn} onClick={addEvent}>
              + Add event
            </button>

            <button type="submit" className={styles.primaryBtn} disabled={busy}>
              {busy ? "Auditing…" : "Record & audit"}
            </button>
          </form>
        </section>

        {/* ── Audit result ────────────────────────────────────────────────── */}
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Audit</h2>
          {!audit ? (
            <p className={styles.muted}>
              Record a claim, or re-audit one from the book below, to see the challenges.
            </p>
          ) : (
            <>
              <div className={styles.figures}>
                <div className={styles.figure}>
                  <span className={styles.figLabel}>They invoiced</span>
                  <span className={`${styles.figValue} tnum`}>
                    {money(audit.claimedAmount, audit.currency)}
                  </span>
                </div>
                <div className={styles.figure}>
                  <span className={styles.figLabel}>Their own facts give</span>
                  <span className={`${styles.figValue} tnum`}>
                    {money(audit.recomputedAmount, audit.currency)}
                  </span>
                </div>
                <div className={`${styles.figure} ${styles.figureStrong}`}>
                  <span className={styles.figLabel}>Defensible position</span>
                  <span className={`${styles.figValue} tnum`}>
                    {money(audit.defensiblePosition, audit.currency)}
                  </span>
                </div>
                <div className={`${styles.figure} ${styles.figureWin}`}>
                  <span className={styles.figLabel}>Challenged</span>
                  <span className={`${styles.figValue} tnum`}>
                    {money(audit.totalChallenged, audit.currency)}
                  </span>
                </div>
              </div>

              {audit.challenges.length === 0 ? (
                <p className={styles.muted}>
                  No challenge found. On the facts and terms supplied, the claim computes as
                  invoiced.
                </p>
              ) : (
                <ul className={styles.challenges}>
                  {audit.challenges.map((c) => (
                    <li key={c.id} className={styles.challenge}>
                      <div className={styles.challengeHead}>
                        <span className={`${styles.badge} ${styles[c.strength]}`}>
                          {c.strength.toUpperCase()}
                        </span>
                        <span className={styles.basis}>{c.basis}</span>
                        <span className={`${styles.reduction} tnum`}>
                          −{money(c.reduction, audit.currency)}
                        </span>
                      </div>
                      <p className={styles.challengeLabel}>{c.label}</p>
                      <p className={styles.challengeWhy}>{c.rationale}</p>
                      {c.clauseRef && <span className={styles.clauseRef}>{c.clauseRef}</span>}
                    </li>
                  ))}
                </ul>
              )}

              {audit.notes.length > 0 && (
                <div className={styles.notes}>
                  <strong>What this audit could not check</strong>
                  <ul>
                    {audit.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* ── The inbound book ──────────────────────────────────────────────── */}
      <section className={styles.card} style={{ marginTop: "1rem" }}>
        <h2 className={styles.cardTitle}>Inbound book</h2>
        {claims === null ? (
          <p className={styles.muted}>Loading…</p>
        ) : claims.length === 0 ? (
          <p className={styles.muted}>
            No claims have been recorded against you yet.
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Claimant</th>
                  <th>Vessel</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Invoiced</th>
                  <th style={{ textAlign: "right" }}>Defensible</th>
                  <th style={{ textAlign: "right" }}>Challenged</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id} className={c.id === auditedId ? styles.activeRow : undefined}>
                    <td>{c.claimantName}</td>
                    <td>
                      <strong>{c.vessel}</strong>
                      {c.voyageRef && <span className={styles.dim}> · {c.voyageRef}</span>}
                    </td>
                    <td>
                      <span className={styles.status}>{c.status.toUpperCase()}</span>
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>
                      {money(c.claimedAmount, c.currency)}
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>
                      {c.audit ? money(c.audit.defensiblePosition, c.currency) : "—"}
                    </td>
                    <td className="tnum" style={{ textAlign: "right" }}>
                      {c.audit ? (
                        <span className={styles.win}>
                          {money(c.audit.totalChallenged, c.currency)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className={styles.ghostBtn}
                        onClick={() => runAudit(c.id)}
                        disabled={busy}
                      >
                        {c.audit ? "Re-audit" : "Audit"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
