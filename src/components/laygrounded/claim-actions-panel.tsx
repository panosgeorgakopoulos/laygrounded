"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./ClaimActionsPanel.module.css";

// ---- Wire shapes (subset of each endpoint's JSON; full payloads are shown
// in a collapsible <pre> so nothing the backend returns is hidden). ----

interface EligibilityCriteria {
  voyage_complete: boolean;
  erp_matched: boolean;
  calculation_present: boolean;
  evidence_fully_corroborated: boolean;
  no_pending_disputes: boolean;
  not_already_settled: boolean;
  nonzero_amount: boolean;
}
interface Eligibility {
  eligible: boolean;
  criteria: EligibilityCriteria;
  failures: string[];
  amount: number;
  direction: "collect" | "pay";
  currency: string;
}
interface SettlementOutcome {
  settlementId: string;
  status: "cleared" | "failed";
  amount: number;
  currency: string;
  direction: "collect" | "pay";
  provider: string;
  providerRef: string | null;
  simulated: boolean;
  error: string | null;
}

interface LedgerEntry {
  id: string;
  entry_kind: string;
  cryptographic_signature: string | null;
  eua_liability_eur: number | null;
  mrv_co2_tonnes: number | null;
  recorded_at: string;
}

interface ChainNode {
  id: string;
  vessel: string;
  voyageRef?: string;
  counterpartyName: string | null;
  chainRole: string | null;
  chainDepth: number | null;
}

interface NegotiationRoom {
  id: string;
  agent_rounds_completed: number | null;
  final_settlement_probability: number | null;
  created_at: string;
  settlement_matrix?: { recommendedSettlement?: number; currency?: string; converged?: boolean };
}

interface EftiExport {
  id: string;
  cryptographic_signature: string | null;
  recorded_at: string;
}

const CRITERIA_LABELS: Record<keyof EligibilityCriteria, string> = {
  voyage_complete: "Voyage complete",
  erp_matched: "ERP-anchored",
  calculation_present: "Calculation on file",
  evidence_fully_corroborated: "Evidence 100% corroborated",
  no_pending_disputes: "No pending proposals",
  not_already_settled: "Not already settled",
  nonzero_amount: "Non-zero amount",
};

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function ClaimActionsPanel({
  claimId,
  onClaimChanged,
}: {
  claimId: string;
  onClaimChanged?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Settlement
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [settlement, setSettlement] = useState<SettlementOutcome | null>(null);

  // Notary
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [isLocked, setIsLocked] = useState(false);
  const [notaryResult, setNotaryResult] = useState<any>(null);
  const [notaryMrv, setNotaryMrv] = useState(false);
  const [notaryLock, setNotaryLock] = useState(false);

  // Charter chain
  const [chain, setChain] = useState<ChainNode[]>([]);
  const [subCounterparty, setSubCounterparty] = useState("");
  const [subRole, setSubRole] = useState<"head_charterer" | "sub_charterer" | "receiver">(
    "sub_charterer"
  );

  // Negotiation
  const [rooms, setRooms] = useState<NegotiationRoom[]>([]);
  const [ownerBudget, setOwnerBudget] = useState("5000");
  const [chartererBudget, setChartererBudget] = useState("5000");
  const [negotiationResult, setNegotiationResult] = useState<any>(null);

  // Arrest
  const [arrest, setArrest] = useState<any>(null);

  // eFTI
  const [eftiExports, setEftiExports] = useState<EftiExport[]>([]);
  const [eftiResult, setEftiResult] = useState<any>(null);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [settleRes, notarizeRes, chainRes, roomsRes, eftiRes] = await Promise.all([
        fetch(`/api/claims/${claimId}/settle`),
        fetch(`/api/v1/claims/${claimId}/notarize`),
        fetch(`/api/claims/${claimId}/sub-claim`),
        fetch(`/api/v1/claims/${claimId}/negotiate`),
        fetch(`/api/v1/interoperability/efti?claimId=${claimId}`),
      ]);
      const settleJson = await readJson(settleRes);
      if (settleRes.ok && settleJson?.eligibility) setEligibility(settleJson.eligibility);

      const notJson = await readJson(notarizeRes);
      if (notarizeRes.ok && notJson) {
        setLedger(notJson.entries ?? []);
        setIsLocked(notJson.isLocked === true);
      }

      const chainJson = await readJson(chainRes);
      if (chainRes.ok && chainJson?.chain) setChain(chainJson.chain);

      const roomsJson = await readJson(roomsRes);
      if (roomsRes.ok && roomsJson?.rooms) setRooms(roomsJson.rooms);

      const eftiJson = await readJson(eftiRes);
      if (eftiRes.ok && eftiJson?.exports) setEftiExports(eftiJson.exports);
    } catch {
      setError("Failed to load claim actions.");
    } finally {
      setLoaded(true);
    }
  }, [claimId]);

  useEffect(() => {
    if (expanded && !loaded) void loadAll();
  }, [expanded, loaded, loadAll]);

  // ---- Settlement ----
  const clearSettlement = async () => {
    setBusy("settle");
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ human_approved: true }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `Settlement failed (${res.status}).`);
        return;
      }
      setSettlement(json.settlement);
      onClaimChanged?.();
    } finally {
      setBusy(null);
    }
  };

  // ---- Notary ----
  const notarize = async () => {
    setBusy("notarize");
    setError(null);
    try {
      const res = await fetch(`/api/v1/claims/${claimId}/notarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeMrv: notaryMrv, lock: notaryLock }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `Notarization failed (${res.status}).`);
        return;
      }
      setNotaryResult(json);
      if (json.locked) setIsLocked(true);
      // Refresh ledger.
      const g = await fetch(`/api/v1/claims/${claimId}/notarize`);
      const gj = await readJson(g);
      if (g.ok && gj) {
        setLedger(gj.entries ?? []);
        setIsLocked(gj.isLocked === true);
      }
      onClaimChanged?.();
    } finally {
      setBusy(null);
    }
  };

  const downloadDossier = async () => {
    setBusy("dossier");
    setError(null);
    try {
      const res = await fetch(`/api/v1/claims/${claimId}/dossier?format=markdown`);
      if (!res.ok) {
        const json = await readJson(res);
        setError(
          json?.error === "NO_PROOF_AS_OF"
            ? "No notary proof yet — notarize the claim first."
            : json?.error || `Dossier unavailable (${res.status}).`
        );
        return;
      }
      const text = await res.text();
      const blob = new Blob([text], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dossier-${claimId.slice(0, 8)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  };

  // ---- Charter chain ----
  const createSubClaim = async () => {
    setBusy("subclaim");
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/sub-claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          counterpartyName: subCounterparty.trim() || undefined,
          chainRole: subRole,
        }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `Sub-claim failed (${res.status}).`);
        return;
      }
      setSubCounterparty("");
      // Refresh chain.
      const g = await fetch(`/api/claims/${claimId}/sub-claim`);
      const gj = await readJson(g);
      if (g.ok && gj?.chain) setChain(gj.chain);
    } finally {
      setBusy(null);
    }
  };

  // ---- Negotiation ----
  const runNegotiation = async () => {
    setBusy("negotiate");
    setError(null);
    try {
      const owner = Number(ownerBudget);
      const charterer = Number(chartererBudget);
      if (!Number.isFinite(owner) || !Number.isFinite(charterer)) {
        setError("Concession budgets must be numbers.");
        return;
      }
      const res = await fetch(`/api/v1/claims/${claimId}/negotiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerLimits: { maxConcessionUsd: owner, hardStopClauses: [] },
          chartererLimits: { maxConcessionUsd: charterer, hardStopClauses: [] },
        }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `Negotiation failed (${res.status}).`);
        return;
      }
      setNegotiationResult(json);
      const g = await fetch(`/api/v1/claims/${claimId}/negotiate`);
      const gj = await readJson(g);
      if (g.ok && gj?.rooms) setRooms(gj.rooms);
    } finally {
      setBusy(null);
    }
  };

  // ---- Arrest ----
  const runArrest = async () => {
    setBusy("arrest");
    setError(null);
    try {
      const res = await fetch(`/api/v1/claims/${claimId}/arrest-prefiling`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `Arrest pre-filing failed (${res.status}).`);
        return;
      }
      setArrest(json);
    } finally {
      setBusy(null);
    }
  };

  // ---- eFTI ----
  const runEfti = async () => {
    setBusy("efti");
    setError(null);
    try {
      const res = await fetch(`/api/v1/interoperability/efti`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId, includeLaytime: true }),
      });
      const json = await readJson(res);
      if (!res.ok) {
        setError(json?.error || `eFTI export failed (${res.status}).`);
        return;
      }
      setEftiResult(json);
      const g = await fetch(`/api/v1/interoperability/efti?claimId=${claimId}`);
      const gj = await readJson(g);
      if (g.ok && gj?.exports) setEftiExports(gj.exports);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.panel}>
      <div
        className={styles.summaryRow}
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
      >
        <span className={`${styles.summaryTitle} tnum`}>LEGAL &amp; SETTLEMENT ACTIONS</span>
        {isLocked && <span className={`${styles.chip} ${styles.chipInfo} tnum`}>NOTARIZED · LOCKED</span>}
        {settlement?.status === "cleared" && (
          <span className={`${styles.chip} ${styles.chipOk} tnum`}>SETTLEMENT CLEARED</span>
        )}
        {chain.length > 0 && (
          <span className={`${styles.chip} tnum`}>CHAIN {chain.length} TIER{chain.length === 1 ? "" : "S"}</span>
        )}
        <span className={`${styles.expandHint} tnum`}>{expanded ? "COLLAPSE ▲" : "EXPAND ▼"}</span>
      </div>

      {expanded && (
        <div className={styles.body}>
          {/* --- Settlement --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>Zero-day settlement</div>
            {!eligibility ? (
              <div className={styles.muted}>Loading eligibility…</div>
            ) : (
              <>
                <div className={styles.muted}>
                  {eligibility.direction === "collect" ? "Collect" : "Pay"}{" "}
                  <strong className="tnum">
                    {eligibility.currency} {eligibility.amount.toLocaleString("en-US")}
                  </strong>{" "}
                  — {eligibility.eligible ? "eligible for instant clearing." : "not yet eligible."}
                </div>
                <ul className={styles.checklist}>
                  {(Object.keys(eligibility.criteria) as Array<keyof EligibilityCriteria>).map((k) => (
                    <li key={k} className={styles.checkItem}>
                      <span className={eligibility.criteria[k] ? styles.checkOk : styles.checkMissing}>
                        {eligibility.criteria[k] ? "✓" : "✗"}
                      </span>
                      <span>{CRITERIA_LABELS[k]}</span>
                    </li>
                  ))}
                </ul>
                <div className={styles.formRow}>
                  <button
                    className={styles.smallBtn}
                    onClick={clearSettlement}
                    disabled={!eligibility.eligible || busy === "settle" || settlement?.status === "cleared"}
                  >
                    {busy === "settle" ? "CLEARING…" : "APPROVE & CLEAR FUNDS"}
                  </button>
                </div>
                {settlement && (
                  <div className={styles.item} style={{ marginTop: "0.5rem" }}>
                    <span className={`${styles.chip} ${settlement.status === "cleared" ? styles.chipOk : styles.chipCrit} tnum`}>
                      {settlement.status.toUpperCase()}
                    </span>{" "}
                    <span className={styles.itemNote}>
                      {settlement.provider}
                      {settlement.simulated ? " (simulated)" : ""}
                      {settlement.error ? ` — ${settlement.error}` : ""}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* --- Cryptographic notary --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>
              Cryptographic notary
              <button className={styles.smallBtn} onClick={downloadDossier} disabled={busy === "dossier"}>
                {busy === "dossier" ? "…" : "DOSSIER"}
              </button>
            </div>
            <div className={styles.muted}>
              Merkle-notarizes the confirmed timeline, breakdown and CP clauses into the
              append-only compliance ledger — tamper-evident proof of record integrity.
            </div>
            <label className={styles.checkboxRow}>
              <input type="checkbox" checked={notaryMrv} onChange={(e) => setNotaryMrv(e.target.checked)} />
              Also ledger MRV / EU-ETS emissions entry
            </label>
            <label className={styles.checkboxRow}>
              <input type="checkbox" checked={notaryLock} onChange={(e) => setNotaryLock(e.target.checked)} />
              Freeze the claim record after notarizing
            </label>
            <div className={styles.formRow}>
              <button className={styles.smallBtn} onClick={notarize} disabled={busy === "notarize"}>
                {busy === "notarize" ? "NOTARIZING…" : "NOTARIZE SNAPSHOT"}
              </button>
            </div>
            {notaryResult && (
              <div className={styles.item} style={{ marginTop: "0.5rem" }}>
                <span className={`${styles.chip} ${styles.chipOk} tnum`}>ROOT</span>{" "}
                <span className={styles.mono}>{notaryResult.merkleRoot?.slice(0, 24)}…</span>
                <div className={styles.muted}>{notaryResult.leafCount} leaves hashed</div>
              </div>
            )}
            {ledger.length > 0 && (
              <div className={styles.itemList} style={{ marginTop: "0.5rem" }}>
                {ledger.slice(0, 4).map((e) => (
                  <div key={e.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={`${styles.chip} tnum`}>{e.entry_kind.replace(/_/g, " ").toUpperCase()}</span>
                      <span className={styles.muted}>{e.recorded_at.slice(0, 16).replace("T", " ")}</span>
                    </div>
                    <div className={styles.mono}>{e.cryptographic_signature?.slice(0, 32)}…</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* --- Charter chain --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>Charter chain (ripple)</div>
            <div className={styles.muted}>
              Clone this claim&apos;s verified record one tier down the charter chain — evidence-
              corroborated facts are locked in the sub-claim.
            </div>
            {chain.length > 0 && (
              <div className={styles.itemList} style={{ marginTop: "0.5rem" }}>
                {chain.map((n) => (
                  <div key={n.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={styles.itemNote}>
                        {n.vessel}
                        {n.counterpartyName ? ` · ${n.counterpartyName}` : ""}
                      </span>
                      <span className={`${styles.chip} tnum`}>
                        {(n.chainRole || "owner").replace(/_/g, " ").toUpperCase()}
                        {n.chainDepth != null ? ` T${n.chainDepth}` : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className={styles.formRow}>
              <input
                className={styles.input}
                type="text"
                placeholder="Counterparty name"
                value={subCounterparty}
                onChange={(e) => setSubCounterparty(e.target.value)}
              />
              <select
                className={styles.select}
                value={subRole}
                onChange={(e) => setSubRole(e.target.value as typeof subRole)}
              >
                <option value="head_charterer">Head charterer</option>
                <option value="sub_charterer">Sub charterer</option>
                <option value="receiver">Receiver</option>
              </select>
              <button className={styles.smallBtn} onClick={createSubClaim} disabled={busy === "subclaim"}>
                {busy === "subclaim" ? "CLONING…" : "CREATE SUB-CLAIM"}
              </button>
            </div>
          </div>

          {/* --- Autonomous negotiation --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>Autonomous negotiation</div>
            <div className={styles.muted}>
              Two deterministic strategy agents trade evidence-grounded concessions over the
              claim&apos;s sensitivity agenda. The recommendation is queued for human approval —
              nothing settles automatically.
            </div>
            <div className={styles.formRow}>
              <label className={styles.checkboxRow} style={{ marginTop: 0 }}>
                Owner budget
                <input
                  className={styles.input}
                  style={{ maxWidth: 100 }}
                  type="number"
                  value={ownerBudget}
                  onChange={(e) => setOwnerBudget(e.target.value)}
                />
              </label>
              <label className={styles.checkboxRow} style={{ marginTop: 0 }}>
                Charterer budget
                <input
                  className={styles.input}
                  style={{ maxWidth: 100 }}
                  type="number"
                  value={chartererBudget}
                  onChange={(e) => setChartererBudget(e.target.value)}
                />
              </label>
              <button className={styles.smallBtn} onClick={runNegotiation} disabled={busy === "negotiate"}>
                {busy === "negotiate" ? "NEGOTIATING…" : "RUN AGENTS"}
              </button>
            </div>
            {negotiationResult?.matrix && (
              <div className={styles.item} style={{ marginTop: "0.5rem" }}>
                <div className={styles.itemHead}>
                  <span className={`${styles.chip} ${negotiationResult.matrix.converged ? styles.chipOk : styles.chipWarn} tnum`}>
                    {negotiationResult.matrix.converged ? "CONVERGED" : "GAP REMAINS"}
                  </span>
                  <span className={styles.muted}>{negotiationResult.review}</span>
                </div>
                <div className={styles.itemNote}>
                  Recommend settle at{" "}
                  <strong className="tnum">
                    {negotiationResult.matrix.currency} {Number(negotiationResult.matrix.recommendedSettlement).toLocaleString("en-US")}
                  </strong>{" "}
                  after {negotiationResult.matrix.roundsCompleted} round(s) · p=
                  {negotiationResult.matrix.settlementProbability}
                </div>
              </div>
            )}
            {rooms.length > 0 && (
              <div className={styles.muted} style={{ marginTop: "0.375rem" }}>
                {rooms.length} prior run{rooms.length === 1 ? "" : "s"} on record.
              </div>
            )}
          </div>

          {/* --- Arrest pre-filing --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>
              Arrest pre-filing
              <button className={styles.smallBtn} onClick={runArrest} disabled={busy === "arrest"}>
                {busy === "arrest" ? "ASSESSING…" : "ASSESS"}
              </button>
            </div>
            <div className={styles.muted}>
              Assesses enforcement posture and organizes a counsel-ready dossier — nothing is
              filed or served, and no output is legal advice.
            </div>
            {arrest?.assessment && (
              <div className={styles.item} style={{ marginTop: "0.5rem" }}>
                <div className={styles.itemHead}>
                  <span className={`${styles.chip} ${arrest.assessment.eligible ? styles.chipOk : styles.chipWarn} tnum`}>
                    {arrest.assessment.eligible ? "ELIGIBLE" : "BLOCKED"}
                  </span>
                  <span className="tnum">
                    {arrest.assessment.currency} {Number(arrest.assessment.claimAmount).toLocaleString("en-US")}
                  </span>
                </div>
                {arrest.assessment.blockers?.length > 0 && (
                  <ul className={styles.checklist}>
                    {arrest.assessment.blockers.map((b: string, i: number) => (
                      <li key={i} className={styles.checkItem}>
                        <span className={styles.checkMissing}>✗</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {arrest.assessment.cautions?.length > 0 && (
                  <div className={styles.muted} style={{ marginTop: "0.375rem" }}>
                    {arrest.assessment.cautions.length} caution(s) for counsel.
                  </div>
                )}
                {arrest.draftId && (
                  <div className={styles.muted} style={{ marginTop: "0.375rem" }}>
                    Dossier filed to drafts · {arrest.review}
                  </div>
                )}
                <details>
                  <summary className={styles.muted}>Full assessment</summary>
                  <pre className={styles.pre}>{JSON.stringify(arrest.assessment, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>

          {/* --- eFTI export --- */}
          <div className={styles.column}>
            <div className={styles.colTitle}>
              eFTI interoperability
              <button className={styles.smallBtn} onClick={runEfti} disabled={busy === "efti"}>
                {busy === "efti" ? "SIGNING…" : "EXPORT PACKET"}
              </button>
            </div>
            <div className={styles.muted}>
              Packages the verified voyage record into a signed, standardized consignment packet
              for port authorities and inland logistics — every export is ledgered.
            </div>
            {eftiResult && (
              <div className={styles.item} style={{ marginTop: "0.5rem" }}>
                <span className={`${styles.chip} ${styles.chipOk} tnum`}>SIGNED</span>
                <details>
                  <summary className={styles.muted}>Consignment packet</summary>
                  <pre className={styles.pre}>{JSON.stringify(eftiResult.consignment, null, 2)}</pre>
                </details>
              </div>
            )}
            {eftiExports.length > 0 && (
              <div className={styles.muted} style={{ marginTop: "0.375rem" }}>
                {eftiExports.length} prior export{eftiExports.length === 1 ? "" : "s"} ledgered.
              </div>
            )}
          </div>
        </div>
      )}

      {error && <div className={styles.error} style={{ padding: "0 0.875rem 0.75rem" }}>{error}</div>}
    </div>
  );
}
