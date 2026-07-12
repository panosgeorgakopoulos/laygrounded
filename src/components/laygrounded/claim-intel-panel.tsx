"use client";

// Claim intelligence strip for the workspace: time-bar countdown and claim-pack
// completeness, independent evidence verification, the counterparty claim room
// (share links + proposal review), and settlement recording. Collapsed by
// default to a chip summary; expands into three columns.

import { useCallback, useEffect, useState } from "react";
import styles from "./ClaimIntelPanel.module.css";

export interface TimeBarView {
  timeBarDays: number;
  anchorEventAt: string | null;
  deadline: string | null;
  daysRemaining: number | null;
  state: "no_anchor" | "ok" | "warning" | "critical" | "expired";
  completeness: Array<{ key: string; label: string; ok: boolean }>;
  complete: boolean;
}

interface EvidenceCheck {
  id: string;
  eventId: string | null;
  checkType: "weather" | "position";
  verdict: "corroborated" | "contradicted" | "inconclusive" | "unavailable";
  summary: string;
}

interface Proposal {
  id: string;
  action: "amend" | "add" | "remove";
  proposedOccurredAt: string | null;
  proposedEventType: string | null;
  note: string;
  proposedByLabel: string;
  status: "pending" | "accepted" | "rejected";
}

interface Share {
  id: string;
  roomPath: string;
  counterpartyLabel: string;
  expiresAt: string;
  revokedAt: string | null;
}

interface DiffDelta {
  net_amount: number;
  demurrage_amount: number;
  despatch_amount: number;
  used_hours: number;
}

interface Props {
  claimId: string;
  timeBar: TimeBarView | null;
  settledAmount: number | null;
  settledAt: string | null;
  currency: string;
  // Fired after a decision changes the underlying events/calculation so the
  // workspace can re-fetch.
  onClaimChanged: () => void;
}

function verdictChipClass(verdict: EvidenceCheck["verdict"]): string {
  if (verdict === "corroborated") return styles.chipOk;
  if (verdict === "contradicted") return styles.chipCrit;
  if (verdict === "inconclusive") return styles.chipWarn;
  return "";
}

function timeBarChipClass(state: TimeBarView["state"]): string {
  if (state === "ok") return styles.chipOk;
  if (state === "warning") return styles.chipWarn;
  if (state === "critical" || state === "expired") return styles.chipCrit;
  return "";
}

export function ClaimIntelPanel({
  claimId,
  timeBar,
  settledAmount,
  settledAt,
  currency,
  onClaimChanged,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceCheck[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [delta, setDelta] = useState<DiffDelta | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settleAmount, setSettleAmount] = useState(settledAmount?.toString() ?? "");
  const [savingSettle, setSavingSettle] = useState(false);

  const loadAll = useCallback(async () => {
    const [evRes, prRes, shRes] = await Promise.all([
      fetch(`/api/claims/${claimId}/verify-evidence`),
      fetch(`/api/claims/${claimId}/proposals`),
      fetch(`/api/claims/${claimId}/share`),
    ]);
    if (evRes.ok) setEvidence((await evRes.json()).checks || []);
    if (prRes.ok) {
      const d = await prRes.json();
      setProposals(d.proposals || []);
      setDelta(d.diff?.delta ?? null);
    }
    if (shRes.ok) setShares((await shRes.json()).shares || []);
  }, [claimId]);

  useEffect(() => {
    loadAll().catch(() => {});
  }, [loadAll]);

  const runVerification = async () => {
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/verify-evidence`, { method: "POST" });
      if (!res.ok) throw new Error("Verification failed");
      setEvidence((await res.json()).checks || []);
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  };

  const createShare = async () => {
    setSharing(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Could not create claim room");
      const d = await res.json();
      const url = `${window.location.origin}${d.share.roomPath}`;
      try {
        await navigator.clipboard.writeText(url);
        setCopied(d.share.id);
      } catch {
        // Clipboard denied — the link is still shown in the list below.
      }
      await loadAll();
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSharing(false);
    }
  };

  const copyShare = async (share: Share) => {
    const url = `${window.location.origin}${share.roomPath}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(share.id);
    } catch {
      setError("Clipboard unavailable — copy the link manually.");
    }
  };

  const revokeShare = async (share: Share) => {
    await fetch(`/api/claims/${claimId}/share`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shareId: share.id }),
    });
    await loadAll();
  };

  const decide = async (proposal: Proposal, decision: "accepted" | "rejected") => {
    setDeciding(proposal.id);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/proposals/${proposal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Decision failed");
      }
      await loadAll();
      if (decision === "accepted") onClaimChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeciding(null);
    }
  };

  const saveSettlement = async () => {
    setSavingSettle(true);
    setError(null);
    try {
      const amount = settleAmount.trim() === "" ? null : parseFloat(settleAmount);
      if (amount !== null && (isNaN(amount) || amount < 0)) {
        throw new Error("Invalid settlement amount");
      }
      const res = await fetch(`/api/claims/${claimId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settledAmount: amount,
          settledAt: amount === null ? null : new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error("Could not save settlement");
      onClaimChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSettle(false);
    }
  };

  const pendingProposals = proposals.filter((p) => p.status === "pending");
  const contradicted = evidence.filter((c) => c.verdict === "contradicted").length;
  const corroborated = evidence.filter((c) => c.verdict === "corroborated").length;
  const activeShares = shares.filter((s) => !s.revokedAt);

  return (
    <div className={styles.panel}>
      <div
        className={styles.summaryRow}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        <span className={`${styles.summaryTitle} tnum`}>CLAIM INTELLIGENCE</span>

        {timeBar && timeBar.state !== "no_anchor" && (
          <span className={`${styles.chip} ${timeBarChipClass(timeBar.state)} tnum`}>
            {timeBar.state === "expired"
              ? "TIME BAR EXPIRED"
              : `TIME BAR ${timeBar.daysRemaining}D`}
          </span>
        )}
        {timeBar && timeBar.state === "no_anchor" && (
          <span className={`${styles.chip} tnum`}>TIME BAR: AWAITING COMPLETION</span>
        )}

        {evidence.length > 0 && (
          <span
            className={`${styles.chip} ${
              contradicted > 0 ? styles.chipCrit : corroborated > 0 ? styles.chipOk : ""
            } tnum`}
          >
            EVIDENCE {corroborated}✓ {contradicted}✗
          </span>
        )}

        {pendingProposals.length > 0 && (
          <span className={`${styles.chip} ${styles.chipInfo} tnum`}>
            {pendingProposals.length} PROPOSAL{pendingProposals.length === 1 ? "" : "S"} PENDING
          </span>
        )}

        {activeShares.length > 0 && (
          <span className={`${styles.chip} tnum`}>ROOM ACTIVE</span>
        )}

        {settledAmount != null && (
          <span className={`${styles.chip} ${styles.chipOk} tnum`}>
            SETTLED {currency} {settledAmount.toLocaleString("en-US")}
          </span>
        )}

        <span className={`${styles.expandHint} tnum`}>{expanded ? "COLLAPSE ▲" : "EXPAND ▼"}</span>
      </div>

      {expanded && (
        <div className={styles.body}>
          {/* --- Time bar & claim pack --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>Time bar & claim pack</div>
            {timeBar ? (
              <>
                {timeBar.deadline ? (
                  <div className={styles.muted}>
                    Present by{" "}
                    <strong className="tnum">{timeBar.deadline.slice(0, 10)}</strong>{" "}
                    ({timeBar.timeBarDays}d after completion
                    {timeBar.daysRemaining != null && timeBar.daysRemaining >= 0
                      ? ` — ${timeBar.daysRemaining} days left`
                      : " — EXPIRED"}
                    )
                  </div>
                ) : (
                  <div className={styles.muted}>
                    Countdown starts when a completion event is confirmed.
                  </div>
                )}
                <ul className={styles.checklist}>
                  {timeBar.completeness.map((c) => (
                    <li key={c.key} className={styles.checkItem}>
                      <span className={c.ok ? styles.checkOk : styles.checkMissing}>
                        {c.ok ? "✓" : "✗"}
                      </span>
                      <span>{c.label}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className={styles.muted}>No time-bar data.</div>
            )}

            <div className={styles.colTitle} style={{ marginTop: "1rem" }}>
              Settlement
            </div>
            <div className={styles.formRow}>
              <input
                className={`${styles.input} tnum`}
                type="number"
                min="0"
                placeholder={`Settled amount (${currency})`}
                value={settleAmount}
                onChange={(e) => setSettleAmount(e.target.value)}
              />
              <button className={styles.smallBtn} onClick={saveSettlement} disabled={savingSettle}>
                {savingSettle ? "SAVING…" : "RECORD"}
              </button>
            </div>
            {settledAt && (
              <div className={styles.muted} style={{ marginTop: "0.375rem" }}>
                Recorded {settledAt.slice(0, 10)}. Clear the field and record to unset.
              </div>
            )}
          </div>

          {/* --- Evidence --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>
              Independent evidence
              <button className={styles.smallBtn} onClick={runVerification} disabled={verifying}>
                {verifying ? "CHECKING…" : "VERIFY"}
              </button>
            </div>
            {evidence.length === 0 ? (
              <div className={styles.muted}>
                Cross-checks claimed weather delays against the historical weather
                archive, and NOR position against AIS when configured.
              </div>
            ) : (
              <div className={styles.itemList}>
                {evidence.map((c) => (
                  <div key={c.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={`${styles.chip} ${verdictChipClass(c.verdict)} tnum`}>
                        {c.checkType.toUpperCase()} · {c.verdict.toUpperCase()}
                      </span>
                    </div>
                    <div className={styles.itemNote}>{c.summary}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* --- Claim room / negotiation --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>
              Claim room
              <button className={styles.smallBtn} onClick={createShare} disabled={sharing}>
                {sharing ? "CREATING…" : "NEW SHARE LINK"}
              </button>
            </div>
            {activeShares.length === 0 ? (
              <div className={styles.muted}>
                Invite the counterparty into a shared negotiation room — both sides
                see the same clause-cited calculation and can propose amendments.
              </div>
            ) : (
              <div className={styles.itemList}>
                {activeShares.map((s) => (
                  <div key={s.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={styles.mono}>{s.roomPath}</span>
                      <span className={styles.smallBtnRow}>
                        <button className={styles.smallBtn} onClick={() => copyShare(s)}>
                          {copied === s.id ? "COPIED ✓" : "COPY LINK"}
                        </button>
                        <button className={styles.smallBtn} onClick={() => revokeShare(s)}>
                          REVOKE
                        </button>
                      </span>
                    </div>
                    <div className={styles.muted}>
                      {s.counterpartyLabel || "Counterparty"} · expires {s.expiresAt.slice(0, 10)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {pendingProposals.length > 0 && (
              <>
                <div className={styles.colTitle} style={{ marginTop: "1rem" }}>
                  Pending proposals
                </div>
                {delta && (
                  <div className={styles.muted} style={{ marginBottom: "0.5rem" }}>
                    Net effect if all accepted:{" "}
                    <strong className="tnum">
                      {delta.net_amount > 0 ? "+" : ""}
                      {delta.net_amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}{" "}
                      {currency}
                    </strong>
                  </div>
                )}
                <div className={styles.itemList}>
                  {pendingProposals.map((p) => (
                    <div key={p.id} className={styles.item}>
                      <div className={styles.itemHead}>
                        <span className={`${styles.chip} ${styles.chipInfo} tnum`}>
                          {p.action.toUpperCase()}
                          {p.proposedEventType ? ` ${p.proposedEventType.replace(/_/g, " ")}` : ""}
                          {p.proposedOccurredAt
                            ? ` → ${p.proposedOccurredAt.slice(0, 16).replace("T", " ")}Z`
                            : ""}
                        </span>
                        <span className={styles.smallBtnRow}>
                          <button
                            className={styles.smallBtn}
                            disabled={deciding === p.id}
                            onClick={() => decide(p, "accepted")}
                          >
                            ACCEPT
                          </button>
                          <button
                            className={styles.smallBtn}
                            disabled={deciding === p.id}
                            onClick={() => decide(p, "rejected")}
                          >
                            REJECT
                          </button>
                        </span>
                      </div>
                      <div className={styles.itemNote}>
                        {p.proposedByLabel}: {p.note || "(no note)"}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {error && <div className={styles.error}>{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
