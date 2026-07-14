"use client";

// Claim intelligence strip for the workspace: time-bar countdown and claim-pack
// completeness, independent evidence verification, the counterparty claim room
// (share links + proposal review), and settlement recording. Collapsed by
// default to a chip summary; expands into three columns.

import { useCallback, useEffect, useState } from "react";
import styles from "./ClaimIntelPanel.module.css";
import { DraftingStudio, GeneratedDraft } from "./drafting-studio";

export interface TimeBarView {
  timeBarDays: number;
  anchorEventAt: string | null;
  deadline: string | null;
  daysRemaining: number | null;
  state: "no_anchor" | "ok" | "warning" | "critical" | "expired";
  completeness: Array<{ key: string; label: string; ok: boolean }>;
  complete: boolean;
}

// Result of POST /api/v1/claims/[id]/geofence-audit.
interface GeofenceSummary {
  verified: number;
  discrepancies: number;
  unverifiable: number;
  skipped: number;
  checks: Array<{
    eventId: string;
    eventType: string;
    occurredAt: string;
    verdict: "verified" | "discrepancy" | "unverifiable";
    distanceNm: number | null;
    allowedRadiusNm: number | null;
    summary: string;
  }>;
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

interface ComplianceCheck {
  id: string;
  subjectType: "vessel" | "counterparty";
  subject: string;
  verdict: "clear" | "possible_match" | "match" | "unavailable";
  riskScore: number | null;
}

interface EtsView {
  delayHours: number;
  co2Tonnes: number;
  estimatedCostEur: number;
  euaPriceEur: number;
}

interface DraftView {
  id: string;
  kind: string;
  tone: string;
  subject: string;
  contentMd: string;
  grounding: { verified: boolean; issues: Array<{ message: string }> };
  createdAt: string;
}

interface IntegrationView {
  id: string;
  provider: string;
  displayName: string;
  status: string;
}

interface SensitivityFinding {
  id: string;
  category: string;
  label: string;
  deltaNet: number;
}

interface SensitivityReport {
  baselineNet: number;
  currency: string;
  vulnerabilities: SensitivityFinding[];
  opportunities: SensitivityFinding[];
  maxSingleLoss: number;
}

interface Props {
  claimId: string;
  timeBar: TimeBarView | null;
  settledAmount: number | null;
  settledAt: string | null;
  currency: string;
  vesselImo: string | null;
  counterpartyName: string | null;
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

function complianceChipClass(verdict: ComplianceCheck["verdict"]): string {
  if (verdict === "clear") return styles.chipOk;
  if (verdict === "match") return styles.chipCrit;
  if (verdict === "possible_match") return styles.chipWarn;
  return "";
}

export function ClaimIntelPanel({
  claimId,
  timeBar,
  settledAmount,
  settledAt,
  currency,
  vesselImo,
  counterpartyName,
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
  const [compliance, setCompliance] = useState<ComplianceCheck[]>([]);
  const [ets, setEts] = useState<EtsView | null>(null);
  const [drafts, setDrafts] = useState<DraftView[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationView[]>([]);
  const [scanning, setScanning] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [pushing, setPushing] = useState<string | null>(null);
  const [imoInput, setImoInput] = useState(vesselImo ?? "");
  const [counterpartyInput, setCounterpartyInput] = useState(counterpartyName ?? "");
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [sensitivity, setSensitivity] = useState<SensitivityReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [geofence, setGeofence] = useState<GeofenceSummary | null>(null);
  const [geofencing, setGeofencing] = useState(false);

  const loadAll = useCallback(async () => {
    const [evRes, prRes, shRes, coRes, drRes, inRes] = await Promise.all([
      fetch(`/api/claims/${claimId}/verify-evidence`),
      fetch(`/api/claims/${claimId}/proposals`),
      fetch(`/api/claims/${claimId}/share`),
      fetch(`/api/claims/${claimId}/compliance`),
      fetch(`/api/claims/${claimId}/draft`),
      fetch(`/api/integrations`),
    ]);
    if (evRes.ok) setEvidence((await evRes.json()).checks || []);
    if (prRes.ok) {
      const d = await prRes.json();
      setProposals(d.proposals || []);
      setDelta(d.diff?.delta ?? null);
    }
    if (shRes.ok) setShares((await shRes.json()).shares || []);
    if (coRes.ok) {
      const d = await coRes.json();
      setCompliance(d.checks || []);
      setEts(d.ets ?? null);
    }
    if (drRes.ok) setDrafts((await drRes.json()).drafts || []);
    if (inRes.ok) setIntegrations((await inRes.json()).integrations || []);
  }, [claimId]);

  useEffect(() => {
    loadAll().catch(() => {});
  }, [loadAll]);

  // AIS geofence audit. The route sources the track from the configured
  // provider; with none configured it answers AIS_UNAVAILABLE, which we
  // surface verbatim rather than showing a green "all clear".
  const runGeofence = async () => {
    setGeofencing(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/claims/${claimId}/geofence-audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          body.error === "AIS_UNAVAILABLE"
            ? "No AIS track available for this vessel — set AIS_PROVIDER_URL/KEY, or POST a track to the audit endpoint."
            : body.error === "PORT_NOT_GEOCODED"
              ? "The claim's port could not be geocoded, so there is no geofence center to measure against."
              : body.error === "NO_EVENTS"
                ? "No events on this claim to audit yet."
                : "Geofence audit failed"
        );
      }
      setGeofence(body as GeofenceSummary);
      setExpanded(true);
      // Verdicts live on the events themselves — refresh the workspace so the
      // timeline badges match this audit.
      onClaimChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeofencing(false);
    }
  };

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

  const saveIdentity = async () => {
    setSavingIdentity(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vesselImo: imoInput.trim() || null,
          counterpartyName: counterpartyInput.trim() || null,
        }),
      });
      if (!res.ok) throw new Error("Could not save identity fields");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingIdentity(false);
    }
  };

  const runScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/compliance`, { method: "POST" });
      if (!res.ok) throw new Error("Compliance scan failed");
      const d = await res.json();
      setCompliance(d.checks || []);
      setEts(d.ets ?? null);
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const onDrafted = useCallback((d: GeneratedDraft) => {
    setDrafts((prev) => [d, ...prev]);
    setExpanded(true);
  }, []);

  const pushToErp = async (integrationId: string) => {
    setPushing(integrationId);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationId, kind: "push_invoice" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Push failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(null);
    }
  };

  const runSensitivity = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/sensitivity`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Sensitivity analysis failed");
      }
      setSensitivity((await res.json()).report);
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const copyDraft = async (d: DraftView) => {
    try {
      await navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.contentMd}`);
      setCopied(d.id);
    } catch {
      setError("Clipboard unavailable.");
    }
  };

  const pendingProposals = proposals.filter((p) => p.status === "pending");
  const contradicted = evidence.filter((c) => c.verdict === "contradicted").length;
  const corroborated = evidence.filter((c) => c.verdict === "corroborated").length;
  const activeShares = shares.filter((s) => !s.revokedAt);
  const sanctionsHit = compliance.some((c) => c.verdict === "match" || c.verdict === "possible_match");

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

        {compliance.length > 0 && (
          <span
            className={`${styles.chip} ${sanctionsHit ? styles.chipCrit : compliance.every((c) => c.verdict === "clear") ? styles.chipOk : ""} tnum`}
          >
            {sanctionsHit ? "SANCTIONS RISK" : compliance.every((c) => c.verdict === "clear") ? "SANCTIONS CLEAR" : "SANCTIONS ?"}
          </span>
        )}

        {ets && ets.estimatedCostEur > 0 && (
          <span className={`${styles.chip} ${styles.chipWarn} tnum`}>
            ETS ~€{ets.estimatedCostEur.toLocaleString("en-US")}
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

          {/* --- AIS geofence --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>
              AIS geofence
              <button className={styles.smallBtn} onClick={runGeofence} disabled={geofencing}>
                {geofencing ? "AUDITING…" : "AUDIT"}
              </button>
            </div>
            {!geofence ? (
              <div className={styles.muted}>
                Cross-checks each position-bound event (NOR, berthed, all fast,
                cargo ops) against the vessel&apos;s AIS track. Discrepancies are
                flagged on the timeline before anyone relies on the timestamp.
              </div>
            ) : (
              <>
                <div className={styles.itemList}>
                  <div className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={`${styles.chip} ${styles.chipOk} tnum`}>
                        {geofence.verified} VERIFIED
                      </span>
                      {geofence.discrepancies > 0 && (
                        <span className={`${styles.chip} ${styles.chipCrit} tnum`}>
                          {geofence.discrepancies} DISCREPANCY
                        </span>
                      )}
                      {geofence.unverifiable > 0 && (
                        <span className={`${styles.chip} ${styles.chipWarn} tnum`}>
                          {geofence.unverifiable} UNVERIFIABLE
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Lead with what the counterparty would attack. */}
                  {geofence.checks
                    .filter((c) => c.verdict === "discrepancy")
                    .map((c) => (
                      <div key={c.eventId} className={styles.item}>
                        <div className={styles.itemHead}>
                          <span className={`${styles.chip} ${styles.chipCrit} tnum`}>
                            {c.eventType.replace(/_/g, " ")}
                          </span>
                        </div>
                        <div className={styles.itemNote}>{c.summary}</div>
                      </div>
                    ))}
                </div>
                {geofence.discrepancies === 0 && geofence.verified > 0 && (
                  <div className={styles.muted}>
                    AIS corroborates every position-bound event on this claim.
                  </div>
                )}
              </>
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

            <div className={styles.colTitle} style={{ marginTop: "1rem" }}>
              Negotiation intel
              <button className={styles.smallBtn} onClick={runSensitivity} disabled={analyzing}>
                {analyzing ? "ANALYZING…" : "FIND WEAK POINTS"}
              </button>
            </div>
            {sensitivity ? (
              <div className={styles.itemList}>
                {sensitivity.vulnerabilities.length === 0 ? (
                  <div className={styles.muted}>
                    No material single-point attacks found — the claim is robust
                    to the standard counterparty arguments.
                  </div>
                ) : (
                  sensitivity.vulnerabilities.slice(0, 3).map((v) => (
                    <div key={v.id} className={styles.item}>
                      <div className={styles.itemHead}>
                        <span className={`${styles.chip} ${styles.chipCrit} tnum`}>
                          −{Math.abs(v.deltaNet).toLocaleString("en-US")} {sensitivity.currency}
                        </span>
                      </div>
                      <div className={styles.itemNote}>{v.label}</div>
                    </div>
                  ))
                )}
                {sensitivity.opportunities.slice(0, 2).map((o) => (
                  <div key={o.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={`${styles.chip} ${styles.chipOk} tnum`}>
                        +{o.deltaNet.toLocaleString("en-US")} {sensitivity.currency}
                      </span>
                    </div>
                    <div className={styles.itemNote}>{o.label}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.muted}>
                Simulates the amendments a counterparty would argue (late NOR,
                earlier completion, longer weather) and ranks each by money at
                stake — know your weakest point before they do.
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
          </div>

          {/* --- Compliance & drafting --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>
              Risk & compliance
              <button className={styles.smallBtn} onClick={runScan} disabled={scanning}>
                {scanning ? "SCANNING…" : "RUN SCAN"}
              </button>
            </div>
            <div className={styles.formRow}>
              <input
                className={`${styles.input} tnum`}
                type="text"
                placeholder="Vessel IMO"
                value={imoInput}
                onChange={(e) => setImoInput(e.target.value)}
              />
              {(() => {
                const v = compliance.find((c) => c.subjectType === "vessel");
                return v ? (
                  <span className={`${styles.chip} ${complianceChipClass(v.verdict)} tnum`}>
                    {v.verdict === "clear" ? "CLEAR" : v.verdict.replace(/_/g, " ").toUpperCase()}
                  </span>
                ) : null;
              })()}
              <input
                className={styles.input}
                type="text"
                placeholder="Counterparty name"
                value={counterpartyInput}
                onChange={(e) => setCounterpartyInput(e.target.value)}
                style={{ maxWidth: "200px" }}
              />
              {(() => {
                const c = compliance.find((c) => c.subjectType === "counterparty");
                return c ? (
                  <span className={`${styles.chip} ${complianceChipClass(c.verdict)} tnum`}>
                    {c.verdict === "clear" ? "CLEAR" : c.verdict.replace(/_/g, " ").toUpperCase()}
                  </span>
                ) : null;
              })()}
              <button className={styles.smallBtn} onClick={saveIdentity} disabled={savingIdentity}>
                {savingIdentity ? "SAVING…" : "SAVE"}
              </button>
            </div>
            {compliance.length === 0 ? (
              <div className={styles.muted} style={{ marginTop: "0.5rem" }}>
                Screens the vessel (IMO) and counterparty against OFAC/EU/UN
                sanctions lists and estimates EU ETS carbon cost of the delay.
              </div>
            ) : (
              <div className={styles.itemList} style={{ marginTop: "0.5rem" }}>
                {compliance.map((c) => (
                  <div key={c.id} className={styles.item}>
                    <span className={`${styles.chip} ${complianceChipClass(c.verdict)} tnum`}>
                      {c.subjectType.toUpperCase()} · {c.verdict.replace(/_/g, " ").toUpperCase()}
                    </span>{" "}
                    <span className={styles.itemNote}>{c.subject}</span>
                  </div>
                ))}
              </div>
            )}
            {ets && (
              <div className={styles.muted} style={{ marginTop: "0.5rem" }}>
                EU ETS exposure of the {ets.delayHours.toFixed(0)}h delay: ~
                <strong className="tnum">
                  {ets.co2Tonnes.toFixed(1)} tCO₂ ≈ €
                  {ets.estimatedCostEur.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                </strong>{" "}
                (@ €{ets.euaPriceEur}/t, estimate — not MRV data).
              </div>
            )}

            <div className={styles.colTitle} style={{ marginTop: "1rem" }}>
              Legal drafter
              <button className={styles.smallBtn} onClick={() => setStudioOpen(true)}>
                OPEN STUDIO
              </button>
            </div>
            {drafts.length === 0 && (
              <div className={styles.muted}>
                Generates clause-cited correspondence (demand letter, protest,
                counter-argument, settlement proposal) and verifies every figure
                against the claim record before you send it.
              </div>
            )}
            {drafts.length > 0 && (
              <div className={styles.itemList} style={{ marginTop: "0.5rem" }}>
                {drafts.slice(0, 3).map((d) => (
                  <div key={d.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span
                        className={`${styles.chip} ${d.grounding?.verified ? styles.chipOk : styles.chipWarn} tnum`}
                      >
                        {d.grounding?.verified ? "GROUNDED ✓" : "UNVERIFIED FIGURES"}
                      </span>
                      <button className={styles.smallBtn} onClick={() => copyDraft(d)}>
                        {copied === d.id ? "COPIED ✓" : "COPY"}
                      </button>
                    </div>
                    <div className={styles.itemNote}>
                      <strong>{d.subject}</strong>
                    </div>
                    <details>
                      <summary className={styles.muted}>
                        {d.kind.replace(/_/g, " ")} · {d.tone} · {d.createdAt.slice(0, 16).replace("T", " ")}
                      </summary>
                      <pre
                        style={{
                          whiteSpace: "pre-wrap",
                          font: "inherit",
                          fontSize: "0.8125rem",
                          marginTop: "0.375rem",
                        }}
                      >
                        {d.contentMd}
                      </pre>
                    </details>
                  </div>
                ))}
              </div>
            )}

            {integrations.length > 0 && (
              <>
                <div className={styles.colTitle} style={{ marginTop: "1rem" }}>
                  ERP sync
                </div>
                <div className={styles.itemList}>
                  {integrations
                    .filter((i) => i.status === "active")
                    .map((i) => (
                      <div key={i.id} className={styles.item}>
                        <div className={styles.itemHead}>
                          <span className={styles.itemNote}>
                            {i.displayName || i.provider}
                          </span>
                          <button
                            className={styles.smallBtn}
                            onClick={() => pushToErp(i.id)}
                            disabled={pushing === i.id}
                          >
                            {pushing === i.id ? "PUSHING…" : "PUSH INVOICE"}
                          </button>
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

      <DraftingStudio
        claimId={claimId}
        open={studioOpen}
        onClose={() => setStudioOpen(false)}
        onDrafted={onDrafted}
      />
    </div>
  );
}
