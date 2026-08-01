"use client";

// Counterparty negotiation: raising disputes on specific events, and the
// workflow from open → negotiating → agreed.
//
// THE PHASE IS DERIVED, NOT STORED AS A LABEL. A claim with a live dispute
// always reads as negotiating even if nobody clicked "open", because the
// alternative is a claim that says it is settled while somebody is arguing
// about it. The server owns that derivation; this component renders it.
//
// A DISPUTE IS AN `event_proposals` ROW — the same table the claim room writes
// when a counterparty proposes an amendment, reviewed through the same
// accept/reject. Only the provenance differs (a guest proposal carries a
// share id, an owner's does not), which is worth preserving: "the charterer
// disputes this" and "we expect them to" are different facts.
//
// A COUNTER-DURATION IS EXPRESSED AS A NEW TIMESTAMP. "Shorten this rain delay
// by 4 hours" is an amendment to the END event's time, which is what the engine
// actually consumes. Storing a duration beside it would create a second source
// of truth for the same interval.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Gavel,
  Handshake,
  Loader2,
  MessageSquare,
  X,
} from "lucide-react";
import styles from "./ClaimNegotiationPanel.module.css";

type Phase = "open" | "negotiating" | "agreed";

interface Proposal {
  id: string;
  shareId: string | null;
  action: "amend" | "add" | "remove";
  eventId: string | null;
  proposedOccurredAt: string | null;
  proposedEventType: string | null;
  note: string;
  proposedByLabel: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

/**
 * `ScenarioDiff` from the engine package, as the proposals route returns it.
 *
 * `delta` is null when either side failed to compute (a claim with no NOR, say),
 * and the currency lives on the baseline result rather than beside the delta —
 * so both are read defensively and the redline simply does not render when the
 * comparison could not be made. A redline showing "undefined NaN" is worse than
 * no redline: it looks like a figure.
 */
interface Diff {
  baseline: { totals: { currency: string } } | null;
  amended: { totals: { currency: string } } | null;
  baselineError: string | null;
  amendedError: string | null;
  delta: {
    used_hours: number;
    demurrage_amount: number;
    despatch_amount: number;
    /** Positive = amendments increase what the owner is owed. */
    net_amount: number;
  } | null;
}

interface NegotiationState {
  phase: Phase;
  negotiationOpenedAt: string | null;
  agreedAt: string | null;
  counts: { pending: number; resolved: number };
  blockedFromAgreement: string | null;
}

interface EventRow {
  id: string;
  event_type: string;
  occurred_at: string;
  status: string;
}

const PHASES: Array<{ key: Phase; label: string; hint: string }> = [
  { key: "open", label: "Open", hint: "Nobody has disputed anything" },
  { key: "negotiating", label: "Negotiating", hint: "Disputes raised and under review" },
  { key: "agreed", label: "Agreed", hint: "Figures final — settlement unlocked" },
];

function money(n: number, ccy: string): string {
  return `${n < 0 ? "−" : ""}${ccy} ${Math.abs(n).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}`;
}

/** ISO → the `datetime-local` format, in the viewer's timezone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ClaimNegotiationPanel({
  claimId,
  events,
  onClaimChanged,
}: {
  claimId: string;
  events: EventRow[];
  onClaimChanged: () => void;
}) {
  const [state, setState] = useState<NegotiationState | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Dispute composer
  const [targetId, setTargetId] = useState("");
  const [newTime, setNewTime] = useState("");
  const [note, setNote] = useState("");

  const confirmed = useMemo(
    () => events.filter((e) => e.status === "accepted" || e.status === "edited"),
    [events]
  );
  const target = confirmed.find((e) => e.id === targetId) ?? null;

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        fetch(`/api/claims/${claimId}/negotiation`).then((r) => r.json()),
        fetch(`/api/claims/${claimId}/proposals`).then((r) => r.json()),
      ]);
      if (s.error) throw new Error(s.error);
      setState(s as NegotiationState);
      setProposals(p.proposals ?? []);
      setDiff(p.diff ?? null);
      setError(null);
    } catch {
      setError("Could not load the negotiation state.");
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Selecting an event seeds the composer with its current time, so an operator
  // adjusts a real value rather than typing a timestamp from scratch.
  useEffect(() => {
    if (target) setNewTime(toLocalInput(target.occurred_at));
  }, [target]);

  async function post(url: string, body: unknown, key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail ?? json.error ?? "Request failed");
      await load();
      onClaimChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function raiseDispute() {
    if (!target || !note.trim()) return;
    const changed = newTime && toLocalInput(target.occurred_at) !== newTime;
    const ok = await post(
      `/api/claims/${claimId}/proposals`,
      {
        action: "amend",
        eventId: target.id,
        // The server requires an amendment to propose SOMETHING, so the event's
        // current time is sent when the operator changed nothing. That records
        // a pure objection — grounds, no counter-time — which applies as a
        // no-op if accepted. The objection is the point; a dispute you cannot
        // raise without inventing a counter-time is a dispute nobody files.
        proposedOccurredAt: changed ? new Date(newTime).toISOString() : target.occurred_at,
        note: note.trim(),
      },
      "dispute"
    );
    if (ok) {
      setNote("");
      setTargetId("");
    }
  }

  async function decide(proposalId: string, decision: "accepted" | "rejected") {
    setBusy(proposalId);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/proposals/${proposalId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: decision }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail ?? json.error ?? "Could not record the decision");
      await load();
      onClaimChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the decision");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className={styles.wrap}>
        <p className={styles.loading}>
          <Loader2 size={13} className={styles.spin} /> Loading negotiation…
        </p>
      </div>
    );
  }
  if (!state) {
    return (
      <div className={styles.wrap}>
        <p className={styles.error}>
          <AlertCircle size={14} /> {error ?? "Unavailable."}
        </p>
      </div>
    );
  }

  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");
  const activeIndex = PHASES.findIndex((p) => p.key === state.phase);

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h3 className={styles.title}>
          <Handshake size={15} /> Counterparty negotiation
        </h3>
        {state.counts.pending > 0 && (
          <span className={styles.pendingChip}>{state.counts.pending} open</span>
        )}
      </header>

      {/* ── Workflow ─────────────────────────────────────────────────── */}
      <ol className={styles.phases}>
        {PHASES.map((p, i) => (
          <li
            key={p.key}
            className={`${styles.phase} ${
              i < activeIndex ? styles.phaseDone : i === activeIndex ? styles.phaseActive : ""
            }`}
          >
            <span className={styles.phaseDot}>{i < activeIndex ? <Check size={11} /> : i + 1}</span>
            <span className={styles.phaseText}>
              <strong>{p.label}</strong>
              <span className={styles.phaseHint}>{p.hint}</span>
            </span>
            {i < PHASES.length - 1 && <ArrowRight size={13} className={styles.phaseArrow} />}
          </li>
        ))}
      </ol>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {state.phase === "agreed" ? (
        <p className={styles.agreed}>
          <Check size={14} /> Agreed {state.agreedAt?.slice(0, 10)}. The figures are final and the
          settlement instruction is unlocked. Disputes can no longer be raised.
        </p>
      ) : (
        <>
          {state.blockedFromAgreement && (
            <p className={styles.blocked}>
              <AlertCircle size={14} /> {state.blockedFromAgreement}
            </p>
          )}

          {state.phase === "open" && (
            <div className={styles.openRow}>
              <p className={styles.openNote}>
                Nothing is disputed. Raising a dispute below opens the negotiation phase
                automatically — or open it explicitly if talks have begun without a specific
                objection yet.
              </p>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy === "open"}
                onClick={() => void post(`/api/claims/${claimId}/negotiation`, { action: "open" }, "open")}
              >
                Open negotiation
              </button>
            </div>
          )}

          {/* ── Raise a dispute ────────────────────────────────────── */}
          <section className={styles.composer}>
            <h4 className={styles.composerTitle}>
              <Gavel size={13} /> Dispute an event
            </h4>
            <div className={styles.composerGrid}>
              <label className={styles.field}>
                <span className={styles.label}>Event</span>
                <select
                  className={styles.input}
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  <option value="">Select a confirmed event…</option>
                  {confirmed.map((e) => (
                    <option key={e.id} value={e.id}>
                      {new Date(e.occurred_at).toISOString().slice(0, 16).replace("T", " ")}Z —{" "}
                      {e.event_type.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.label}>
                  Counter-time <span className={styles.hint}>what you say it should be</span>
                </span>
                <input
                  type="datetime-local"
                  className={styles.input}
                  value={newTime}
                  disabled={!target}
                  onChange={(e) => setNewTime(e.target.value)}
                />
              </label>
            </div>

            {target && newTime && toLocalInput(target.occurred_at) !== newTime && (
              <p className={styles.delta}>
                Moves this event by{" "}
                <strong>
                  {(
                    (new Date(newTime).getTime() - new Date(target.occurred_at).getTime()) /
                    3_600_000
                  ).toFixed(1)}
                  h
                </strong>
                . The money impact appears in the redline once the dispute is raised.
              </p>
            )}

            <label className={styles.field}>
              <span className={styles.label}>
                <MessageSquare size={11} /> Grounds
              </span>
              <textarea
                className={styles.textarea}
                rows={2}
                value={note}
                placeholder="e.g. Rain ceased at 07:40 per the port log; the SoF overstates the stoppage by 4 hours."
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            <button
              type="button"
              className={styles.primary}
              disabled={!target || !note.trim() || busy === "dispute"}
              onClick={() => void raiseDispute()}
            >
              {busy === "dispute" ? <Loader2 size={13} className={styles.spin} /> : null} Raise
              dispute
            </button>
          </section>
        </>
      )}

      {/* ── Redline ──────────────────────────────────────────────────── */}
      {pending.length > 0 && diff?.delta && diff.baseline && (
        <div className={styles.redline}>
          <span className={styles.redlineLabel}>If every open dispute were accepted</span>
          <strong className={diff.delta.net_amount < 0 ? styles.down : styles.up}>
            {money(diff.delta.net_amount, diff.baseline.totals.currency)}
          </strong>
          <span className={styles.redlineNote}>
            net change to the claim, from the owner&apos;s perspective
            {diff.delta.used_hours !== 0 && (
              <> · {diff.delta.used_hours > 0 ? "+" : ""}
                {diff.delta.used_hours.toFixed(1)}h used</>
            )}
          </span>
        </div>
      )}
      {pending.length > 0 && diff && !diff.delta && (
        <p className={styles.redlineUnavailable}>
          The money impact could not be computed:{" "}
          {diff.amendedError ?? diff.baselineError ?? "the amended timeline does not compute"}.
        </p>
      )}

      {/* ── Open disputes ────────────────────────────────────────────── */}
      {pending.length > 0 && (
        <ul className={styles.list}>
          {pending.map((p) => {
            const ev = events.find((e) => e.id === p.eventId);
            return (
              <li key={p.id} className={styles.proposal}>
                <div className={styles.pMain}>
                  <div className={styles.pHead}>
                    <span className={styles.pAction}>{p.action}</span>
                    <strong>{ev ? ev.event_type.replace(/_/g, " ") : "new event"}</strong>
                    <span className={p.shareId ? styles.fromGuest : styles.fromOwner}>
                      {p.shareId ? "counterparty" : "internal"}
                    </span>
                    <span className={styles.pBy}>{p.proposedByLabel}</span>
                  </div>
                  {p.proposedOccurredAt && ev && (
                    <p className={styles.pChange}>
                      <span className={`${styles.strike} tnum`}>
                        {new Date(ev.occurred_at).toISOString().slice(0, 16).replace("T", " ")}Z
                      </span>{" "}
                      →{" "}
                      <span className="tnum">
                        {new Date(p.proposedOccurredAt).toISOString().slice(0, 16).replace("T", " ")}
                        Z
                      </span>
                    </p>
                  )}
                  <p className={styles.pNote}>{p.note}</p>
                </div>
                <div className={styles.pActions}>
                  <button
                    type="button"
                    className={styles.accept}
                    disabled={busy === p.id}
                    onClick={() => void decide(p.id, "accepted")}
                    title="Apply this amendment to the timeline and recompute"
                  >
                    <Check size={13} /> Accept
                  </button>
                  <button
                    type="button"
                    className={styles.reject}
                    disabled={busy === p.id}
                    onClick={() => void decide(p.id, "rejected")}
                  >
                    <X size={13} /> Reject
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {decided.length > 0 && (
        <details className={styles.history}>
          <summary>Resolved ({decided.length})</summary>
          <ul className={styles.list}>
            {decided.map((p) => (
              <li key={p.id} className={styles.resolved}>
                <span className={p.status === "accepted" ? styles.ok : styles.muted}>
                  {p.status}
                </span>
                <span className={styles.pBy}>{p.proposedByLabel}</span>
                <span className={styles.pNote}>{p.note}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {state.phase !== "agreed" && pending.length === 0 && state.counts.resolved > 0 && (
        <p className={styles.clear}>
          <Check size={14} /> Every dispute is resolved. The claim can be agreed from the
          <strong> Agreement &amp; settlement</strong> panel, which checks the remaining criteria.
        </p>
      )}
    </div>
  );
}
