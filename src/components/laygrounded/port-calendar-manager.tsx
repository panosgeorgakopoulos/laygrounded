"use client";

// Tier 2 — master data. Every port calendar this company holds, what is in
// force, what is proposed, and the bulk import.
//
// The split between confirmed and pending is the point of the screen: only
// confirmed days reach the engine, so the table has to make "in force" and
// "suggested" visually distinct rather than showing a single list of dates.

import { useCallback, useEffect, useState } from "react";
import { parseCalendarFile, type CalendarParseResult } from "@/lib/laytime/calendar-import";
import styles from "./PortCalendarManager.module.css";

interface CalendarDay {
  id: string;
  date: string;
  kind: string;
  label: string | null;
  observedClaimId?: string | null;
}

interface PortCalendarRow {
  id: string;
  port: string;
  portKey: string;
  timezone: string | null;
  source: string;
  sourceKind: string;
  notes: string | null;
  confirmed: CalendarDay[];
  pending: CalendarDay[];
}

export function PortCalendarManager() {
  const [calendars, setCalendars] = useState<PortCalendarRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Import form
  const [port, setPort] = useState("");
  const [timezone, setTimezone] = useState("");
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<(CalendarParseResult & { fileName: string }) | null>(
    null,
  );

  const load = useCallback(async () => {
    const res = await fetch("/api/port-calendars");
    const json = await res.json().catch(() => null);
    if (res.ok && Array.isArray(json?.calendars)) setCalendars(json.calendars);
    else {
      setError(json?.error ?? "Could not load port calendars.");
      setCalendars([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/port-calendars");
      const json = await res.json().catch(() => null);
      if (cancelled) return;
      if (res.ok && Array.isArray(json?.calendars)) setCalendars(json.calendars);
      else {
        setError(json?.error ?? "Could not load port calendars.");
        setCalendars([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Parsing happens in the browser so the operator sees exactly what will be
  // imported — and which lines were rejected — BEFORE anything is written.
  async function onFile(file: File | null) {
    if (!file) {
      setPreview(null);
      return;
    }
    const text = await file.text();
    setPreview({ ...parseCalendarFile(file.name, text), fileName: file.name });
  }

  async function submitImport(e: React.FormEvent) {
    e.preventDefault();
    if (!preview || preview.days.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    const res = await fetch("/api/port-calendars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        port,
        timezone: timezone || undefined,
        source,
        days: preview.days,
      }),
    });
    const json = await res.json().catch(() => null);
    setBusy(false);

    if (!res.ok) {
      setError(json?.error ?? "Import failed.");
      return;
    }
    setNotice(
      `Imported ${json.imported} day${json.imported === 1 ? "" : "s"} for ${port}. ` +
        "These are in force immediately and will be applied the next time each " +
        "affected claim is recomputed.",
    );
    setPort("");
    setSource("");
    setTimezone("");
    setPreview(null);
    await load();
  }

  async function review(dayIds: string[], decision: "confirmed" | "rejected") {
    setBusy(true);
    const res = await fetch("/api/port-calendars/observe", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dayIds, decision }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error ?? "Could not record the decision.");
      return;
    }
    await load();
  }

  async function removeDays(dayIds: string[]) {
    setBusy(true);
    const res = await fetch(`/api/port-calendars?dayIds=${dayIds.join(",")}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      setError("Could not remove the day.");
      return;
    }
    await load();
  }

  return (
    <div>
      {error && <div className={styles.error}>{error}</div>}
      {notice && <div className={styles.notice}>{notice}</div>}

      {/* ── Import ─────────────────────────────────────────────────────── */}
      <section className={styles.card}>
        <h3 className={styles.cardTitle}>Import a port calendar</h3>
        <p className={styles.cardSub}>
          CSV or JSON. CSV is <code>date,label,kind</code> with a header row optional; dates
          must be <code>YYYY-MM-DD</code> in the port&apos;s local calendar. Imported days are
          treated as authoritative and take effect on the next recompute.
        </p>

        <form onSubmit={submitImport}>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>Port</span>
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                required
                placeholder="e.g. Newcastle, AU"
              />
            </label>
            <label className={styles.field}>
              <span>Timezone (optional)</span>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="e.g. Australia/Sydney"
              />
            </label>
            <label className={styles.field}>
              <span>Source</span>
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                required
                placeholder="Where this calendar came from"
              />
            </label>
            <label className={styles.field}>
              <span>File</span>
              <input
                type="file"
                accept=".csv,.json,.tsv,.txt"
                onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          {preview && (
            <div className={styles.preview}>
              <strong>
                {preview.fileName}: {preview.days.length} day
                {preview.days.length === 1 ? "" : "s"} ready
                {preview.duplicatesCollapsed > 0 &&
                  `, ${preview.duplicatesCollapsed} duplicate date${
                    preview.duplicatesCollapsed === 1 ? "" : "s"
                  } collapsed`}
              </strong>
              {preview.days.length > 0 && (
                <p className={styles.previewDates}>
                  {preview.days.slice(0, 8).map((d) => d.date).join(", ")}
                  {preview.days.length > 8 && ` … +${preview.days.length - 8} more`}
                </p>
              )}
              {preview.errors.length > 0 && (
                <div className={styles.parseErrors}>
                  <span>
                    {preview.errors.length} row{preview.errors.length === 1 ? "" : "s"} could
                    not be read and will not be imported:
                  </span>
                  <ul>
                    {preview.errors.slice(0, 5).map((err, i) => (
                      <li key={i}>
                        Line {err.line}: {err.value ? `"${err.value}" — ` : ""}
                        {err.reason}
                      </li>
                    ))}
                    {preview.errors.length > 5 && <li>… and {preview.errors.length - 5} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}

          <button
            type="submit"
            className={styles.primaryBtn}
            disabled={busy || !preview || preview.days.length === 0 || !port || !source}
          >
            {busy ? "Importing…" : "Import calendar"}
          </button>
        </form>
      </section>

      {/* ── Existing calendars ─────────────────────────────────────────── */}
      <section className={styles.card}>
        <h3 className={styles.cardTitle}>Port calendars</h3>
        {calendars === null ? (
          <p className={styles.muted}>Loading…</p>
        ) : calendars.length === 0 ? (
          <p className={styles.muted}>
            No port calendars yet. Until a port has one, the engine treats only Sundays (and
            Saturdays on an SSHEX basis) as non-working — midweek holidays are not recognised.
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Port</th>
                  <th>Source</th>
                  <th style={{ textAlign: "right" }}>In force</th>
                  <th style={{ textAlign: "right" }}>Awaiting review</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {calendars.map((c) => (
                  <>
                    <tr key={c.id}>
                      <td>
                        <strong>{c.port}</strong>
                        {c.timezone && <span className={styles.dim}> · {c.timezone}</span>}
                      </td>
                      <td>
                        <span className={styles.source}>{c.source}</span>
                        {c.sourceKind === "observed_from_sof" && (
                          <span className={styles.inferredTag}>inferred</span>
                        )}
                      </td>
                      <td className="tnum" style={{ textAlign: "right" }}>
                        {c.confirmed.length}
                      </td>
                      <td className="tnum" style={{ textAlign: "right" }}>
                        {c.pending.length > 0 ? (
                          <span className={styles.pendingCount}>{c.pending.length}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className={styles.ghostBtn}
                          onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                        >
                          {expanded === c.id ? "Hide" : "Manage"}
                        </button>
                      </td>
                    </tr>
                    {expanded === c.id && (
                      <tr key={`${c.id}-detail`}>
                        <td colSpan={5} className={styles.detailCell}>
                          {c.pending.length > 0 && (
                            <div className={styles.detailBlock}>
                              <h4 className={styles.detailTitle}>
                                Awaiting review — not applied to any calculation
                              </h4>
                              <ul className={styles.dayList}>
                                {c.pending.map((d) => (
                                  <li key={d.id} className={styles.dayRow}>
                                    <span className={`${styles.date} tnum`}>{d.date}</span>
                                    <span className={styles.dayLabel}>{d.label}</span>
                                    <span className={styles.dayActions}>
                                      <button
                                        className={styles.approve}
                                        disabled={busy}
                                        onClick={() => review([d.id], "confirmed")}
                                      >
                                        Approve
                                      </button>
                                      <button
                                        className={styles.ghostBtn}
                                        disabled={busy}
                                        onClick={() => review([d.id], "rejected")}
                                      >
                                        Reject
                                      </button>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                              <button
                                className={styles.approve}
                                disabled={busy}
                                onClick={() =>
                                  review(c.pending.map((d) => d.id), "confirmed")
                                }
                              >
                                Approve all {c.pending.length}
                              </button>
                            </div>
                          )}

                          <div className={styles.detailBlock}>
                            <h4 className={styles.detailTitle}>
                              In force — excluded from laytime on an excepted basis
                            </h4>
                            {c.confirmed.length === 0 ? (
                              <p className={styles.muted}>
                                No confirmed days. This calendar has no effect on any
                                calculation.
                              </p>
                            ) : (
                              <ul className={styles.dayList}>
                                {c.confirmed.map((d) => (
                                  <li key={d.id} className={styles.dayRow}>
                                    <span className={`${styles.date} tnum`}>{d.date}</span>
                                    <span className={styles.dayLabel}>{d.label}</span>
                                    <span className={styles.dayActions}>
                                      <button
                                        className={styles.ghostBtn}
                                        disabled={busy}
                                        onClick={() => removeDays([d.id])}
                                      >
                                        Remove
                                      </button>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
