"use client";

// Interactive half of the claim room: the counterparty proposes amendments,
// additions, and removals against the shared event timeline. Submissions go
// to the token-scoped public API; the server component re-renders the shared
// state (including the recomputed redline) on refresh.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EVENT_TYPE_VALUES } from "@/lib/laytime/types";
import type { RoomEvent, RoomProposal } from "@/lib/rooms";
import styles from "./Room.module.css";

interface Props {
  token: string;
  events: RoomEvent[];
  proposals: RoomProposal[];
}

function fmtUtc(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

// datetime-local yields "YYYY-MM-DDTHH:mm" with no zone; the room works in
// UTC throughout, so pin the suffix rather than trusting the browser zone.
function localInputToUtcIso(value: string): string {
  return new Date(`${value}:00Z`).toISOString();
}

function utcIsoToLocalInput(iso: string): string {
  return iso.slice(0, 16);
}

export function RoomClient({ token, events, proposals }: Props) {
  const router = useRouter();
  const [amendingId, setAmendingId] = useState<string | null>(null);
  const [amendTime, setAmendTime] = useState("");
  const [amendNote, setAmendNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [addTime, setAddTime] = useState("");
  const [addType, setAddType] = useState<string>(EVENT_TYPE_VALUES[0]);
  const [addNote, setAddNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/rooms/${token}/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      setAmendingId(null);
      setAdding(false);
      setAmendNote("");
      setAddNote("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pendingByEvent = new Map<string, RoomProposal[]>();
  for (const p of proposals) {
    if (p.status === "pending" && p.eventId) {
      const list = pendingByEvent.get(p.eventId) ?? [];
      list.push(p);
      pendingByEvent.set(p.eventId, list);
    }
  }

  return (
    <>
      <section className={styles.card}>
        <div className={styles.cardTitle}>Statement of Facts — agreed timeline</div>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Event</th>
                <th>SoF verbatim</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="tnum">{fmtUtc(e.occurredAt)}</td>
                  <td className={styles.eventType}>{e.eventType.replace(/_/g, " ")}</td>
                  <td className={styles.rawText}>{e.rawText || "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    {(pendingByEvent.get(e.id) ?? []).map((p) => (
                      <span key={p.id} className={`${styles.badge} ${styles.badgePending}`}>
                        {p.action} proposed
                      </span>
                    ))}
                    {amendingId !== e.id && (
                      <>
                        {" "}
                        <button
                          className={styles.proposeBtn}
                          onClick={() => {
                            setAmendingId(e.id);
                            setAmendTime(utcIsoToLocalInput(e.occurredAt));
                            setAmendNote("");
                          }}
                        >
                          Propose change
                        </button>{" "}
                        <button
                          className={styles.proposeBtn}
                          onClick={() =>
                            submit({ action: "remove", eventId: e.id, note: "Event disputed — removal proposed." })
                          }
                          disabled={busy}
                        >
                          Dispute
                        </button>
                      </>
                    )}
                    {amendingId === e.id && (
                      <div className={styles.inlineForm}>
                        <input
                          type="datetime-local"
                          className={styles.input}
                          value={amendTime}
                          onChange={(ev) => setAmendTime(ev.target.value)}
                        />
                        <input
                          type="text"
                          className={styles.input}
                          placeholder="Why? (e.g. per terminal log)"
                          value={amendNote}
                          onChange={(ev) => setAmendNote(ev.target.value)}
                          style={{ minWidth: "220px" }}
                        />
                        <button
                          className={styles.submitBtn}
                          disabled={busy || !amendTime}
                          onClick={() =>
                            submit({
                              action: "amend",
                              eventId: e.id,
                              proposedOccurredAt: localInputToUtcIso(amendTime),
                              note: amendNote,
                            })
                          }
                        >
                          Submit
                        </button>
                        <button className={styles.cancelBtn} onClick={() => setAmendingId(null)}>
                          Cancel
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {events.length === 0 && (
                <tr>
                  <td colSpan={4} className={styles.emptyNote}>
                    No confirmed events on this claim yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: "1rem" }}>
          {!adding ? (
            <button className={styles.proposeBtn} onClick={() => setAdding(true)}>
              + Propose a missing event
            </button>
          ) : (
            <div className={styles.inlineForm}>
              <input
                type="datetime-local"
                className={styles.input}
                value={addTime}
                onChange={(ev) => setAddTime(ev.target.value)}
              />
              <select
                className={styles.select}
                value={addType}
                onChange={(ev) => setAddType(ev.target.value)}
              >
                {EVENT_TYPE_VALUES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className={styles.input}
                placeholder="Supporting note"
                value={addNote}
                onChange={(ev) => setAddNote(ev.target.value)}
                style={{ minWidth: "220px" }}
              />
              <button
                className={styles.submitBtn}
                disabled={busy || !addTime}
                onClick={() =>
                  submit({
                    action: "add",
                    proposedOccurredAt: localInputToUtcIso(addTime),
                    proposedEventType: addType,
                    note: addNote,
                  })
                }
              >
                Submit
              </button>
              <button className={styles.cancelBtn} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          )}
          <div className={styles.hint} style={{ marginTop: "0.5rem" }}>
            All times are UTC. Proposals are reviewed by the claim owner; nothing changes until they accept.
          </div>
          {error && <div className={styles.errorText}>{error}</div>}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>Negotiation history</div>
        {proposals.length === 0 ? (
          <div className={styles.emptyNote}>No proposals yet — the timeline above is undisputed.</div>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Filed</th>
                  <th>By</th>
                  <th>Proposal</th>
                  <th>Note</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => (
                  <tr key={p.id}>
                    <td className="tnum">{fmtUtc(p.createdAt)}</td>
                    <td>{p.proposedByLabel}</td>
                    <td>
                      <span className={styles.eventType}>{p.action.toUpperCase()}</span>{" "}
                      {p.proposedEventType ? p.proposedEventType.replace(/_/g, " ") : ""}
                      {p.proposedOccurredAt ? ` → ${fmtUtc(p.proposedOccurredAt)}` : ""}
                    </td>
                    <td className={styles.rawText}>{p.note || "—"}</td>
                    <td>
                      <span
                        className={`${styles.badge} ${
                          p.status === "pending"
                            ? styles.badgePending
                            : p.status === "accepted"
                              ? styles.badgeAccepted
                              : styles.badgeRejected
                        }`}
                      >
                        {p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
