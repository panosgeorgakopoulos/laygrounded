"use client";

// Tier 1 — pending observed non-working days, inline on the voyage they came
// from.
//
// This is where the review actually belongs. The days were inferred from THIS
// voyage's statement of facts, the operator is already looking at that timeline,
// and the decision changes THIS claim's laytime. A global settings queue asks
// someone to adjudicate a date they have no context for; here they can see the
// gap that produced it.
//
// Nothing shown here is in force yet: pending days are excluded from every
// calculation until approved. The copy says so, because a banner that looks like
// a warning about the current figures would misrepresent them.

import { useCallback, useEffect, useState } from "react";
import styles from "./PortCalendarAlert.module.css";

interface PendingDay {
  id: string;
  date: string;
  kind: string;
  rationale: string | null;
  port: string;
}

export function PortCalendarAlert({
  claimId,
  onCalendarChanged,
}: {
  claimId: string;
  onCalendarChanged?: () => void;
}) {
  const [pending, setPending] = useState<PendingDay[]>([]);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<{ approved: number; rejected: number } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/port-calendars/observe?claimId=${encodeURIComponent(claimId)}`);
    const json = await res.json().catch(() => null);
    if (res.ok && Array.isArray(json?.pending)) setPending(json.pending);
  }, [claimId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(
        `/api/port-calendars/observe?claimId=${encodeURIComponent(claimId)}`,
      );
      const json = await res.json().catch(() => null);
      if (cancelled) return;
      if (res.ok && Array.isArray(json?.pending)) setPending(json.pending);
    })();
    return () => {
      cancelled = true;
    };
  }, [claimId]);

  async function decide(dayIds: string[], decision: "confirmed" | "rejected") {
    setBusyIds((b) => [...b, ...dayIds]);
    setError(null);
    const res = await fetch("/api/port-calendars/observe", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dayIds, decision }),
    });
    const json = await res.json().catch(() => null);
    setBusyIds((b) => b.filter((id) => !dayIds.includes(id)));

    if (!res.ok) {
      setError(json?.error ?? "Could not record the decision.");
      return;
    }

    setResolved((r) => ({
      approved: (r?.approved ?? 0) + (decision === "confirmed" ? dayIds.length : 0),
      rejected: (r?.rejected ?? 0) + (decision === "rejected" ? dayIds.length : 0),
    }));
    await load();
    // Approving changes which hours count, so the claim's figures are now stale
    // until it is recomputed. Rejecting changes nothing, so it does not.
    if (decision === "confirmed") onCalendarChanged?.();
  }

  if (pending.length === 0) {
    if (!resolved) return null;
    return (
      <div className={`${styles.banner} ${styles.done}`}>
        <span className={styles.icon}>✓</span>
        <p className={styles.doneText}>
          Review complete
          {resolved.approved > 0 && (
            <>
              {" "}
              — {resolved.approved} day{resolved.approved === 1 ? "" : "s"} added to the port
              calendar. This voyage&apos;s laytime has been recomputed.
            </>
          )}
          {resolved.approved === 0 && " — no changes to the port calendar."}
        </p>
      </div>
    );
  }

  const allIds = pending.map((d) => d.id);
  const port = pending[0]?.port;

  return (
    <div className={styles.banner}>
      <div className={styles.head}>
        <span className={styles.icon}>?</span>
        <div>
          <h3 className={styles.title}>
            {pending.length} possible non-working day{pending.length === 1 ? "" : "s"} at{" "}
            {port}
          </h3>
          <p className={styles.sub}>
            This voyage was alongside for these full days with no cargo work recorded, and
            nothing on the timeline explains the idleness. That may be a port holiday — or a
            breakdown, congestion, or simply a gap in the paperwork.{" "}
            <strong>Nothing here affects the calculation until you approve it.</strong>
          </p>
        </div>
      </div>

      <ul className={styles.days}>
        {pending.map((d) => {
          const busy = busyIds.includes(d.id);
          return (
            <li key={d.id} className={styles.day}>
              <div className={styles.dayMain}>
                <span className={`${styles.date} tnum`}>{d.date}</span>
                {d.rationale && <span className={styles.rationale}>{d.rationale}</span>}
              </div>
              <div className={styles.actions}>
                <button
                  className={styles.approve}
                  disabled={busy}
                  onClick={() => decide([d.id], "confirmed")}
                >
                  Approve
                </button>
                <button
                  className={styles.reject}
                  disabled={busy}
                  onClick={() => decide([d.id], "rejected")}
                >
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {pending.length > 1 && (
        <div className={styles.bulk}>
          <button
            className={styles.approve}
            disabled={busyIds.length > 0}
            onClick={() => decide(allIds, "confirmed")}
          >
            Approve all {pending.length}
          </button>
          <button
            className={styles.reject}
            disabled={busyIds.length > 0}
            onClick={() => decide(allIds, "rejected")}
          >
            Reject all
          </button>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
