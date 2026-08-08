"use client";

// The tenant's tamper-evident audit trail, with a verification the user runs
// themselves. The point of the "VERIFY CHAIN" button is that it is theirs to
// press: an integrity check only the vendor can perform proves considerably
// less than one the customer can run unannounced, on demand.

import { Fragment, useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/core/Card";
import { ShieldCheck, ShieldAlert, RefreshCw } from "lucide-react";
import styles from "./SecurityTrail.module.css";

interface SecurityEvent {
  id: string;
  seq: number;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: "allowed" | "denied" | "error";
  metadata: Record<string, unknown>;
  entryHash: string;
}

interface ChainBreak {
  seq: number;
  reason: string;
  detail: string;
}

interface Verification {
  ok: boolean;
  checked: number;
  anchored: boolean;
  headHash: string | null;
  truncated: boolean;
  statement: string;
  breaks: ChainBreak[];
}

const ACTION_FILTERS = [
  { id: "", label: "All activity" },
  { id: "share.created", label: "Room links granted" },
  { id: "share.revoked", label: "Room links revoked" },
  { id: "settlement.cleared", label: "Settlements cleared" },
  { id: "api_key.created", label: "API keys issued" },
  { id: "api_key.revoked", label: "API keys revoked" },
  { id: "webhook.registered", label: "Webhooks registered" },
  { id: "member.invited", label: "Members invited" },
  // The filter an investigation actually reaches for: "how did this person get
  // access", which `member.invited` alone cannot answer now that an invitation
  // can be made and never taken up.
  { id: "invitation.accepted", label: "Invitations accepted" },
  { id: "invitation.revoked", label: "Invitations withdrawn" },
  { id: "member.removed", label: "Members removed" },
  { id: "proposal.accepted", label: "Amendments accepted" },
  { id: "claim.access_denied", label: "Access refused" },
] as const;

function short(hash: string | null): string {
  return hash ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : "—";
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function SecurityTrail() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [action, setAction] = useState("");
  const [deniedOnly, setDeniedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: "100" });
      if (action) qs.set("action", action);
      if (deniedOnly) qs.set("outcome", "denied");
      const res = await fetch(`/api/security/events?${qs}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // 503 means the table is not there yet — say which, rather than
        // showing an empty list that reads as "nothing ever happened".
        setError(
          res.status === 503
            ? "The audit trail is unavailable. If this is a new deployment, apply migration 20260717000000_security_audit_log.sql."
            : body?.error || `Request failed (${res.status})`
        );
        setEvents([]);
        return;
      }
      setEvents(body?.events ?? []);
    } catch {
      setError("Could not reach the audit trail.");
    } finally {
      setLoading(false);
    }
  }, [action, deniedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      const res = await fetch("/api/security/verify");
      const body = await res.json().catch(() => null);
      if (res.ok) setVerification(body?.verification ?? null);
      else setError(body?.error || `Verification failed (${res.status})`);
    } catch {
      setError("Could not reach the verifier.");
    } finally {
      setVerifying(false);
    }
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security trail</CardTitle>
        <CardDescription>
          An append-only record of every sensitive action in your company: room links granted to
          counterparties, settlements cleared, API keys issued, members added or removed, amendments
          accepted. Entries are hash-chained, so altering or deleting one is detectable — and no
          account, including yours, can write or edit this table.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className={styles.verifyRow}>
          <button className={styles.btn} onClick={verify} disabled={verifying}>
            {verifying ? "VERIFYING…" : "VERIFY CHAIN"}
          </button>
          {verification && (
            <div
              className={`${styles.verdict} ${verification.ok ? styles.verdictOk : styles.verdictBad}`}
            >
              {verification.ok ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
              <span>{verification.statement}</span>
            </div>
          )}
        </div>

        {verification?.headHash && (
          <p className={styles.headHash}>
            Head hash <code>{short(verification.headHash)}</code> over {verification.checked}{" "}
            entries. Record it externally to detect entries removed from the end of the chain.
          </p>
        )}

        {verification && verification.breaks.length > 0 && (
          <ul className={styles.breaks}>
            {verification.breaks.map((b, i) => (
              <li key={i}>
                <strong>#{b.seq}</strong> {b.reason.replace(/_/g, " ")} — {b.detail}
              </li>
            ))}
          </ul>
        )}

        <div className={styles.filters}>
          <select
            className={styles.select}
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            {ACTION_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={deniedOnly}
              onChange={(e) => setDeniedOnly(e.target.checked)}
            />
            Refused attempts only
          </label>
          <button className={styles.btn} onClick={load} disabled={loading}>
            <RefreshCw size={13} /> {loading ? "LOADING…" : "REFRESH"}
          </button>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {!error && !loading && events.length === 0 && (
          <p className={styles.empty}>
            No entries match. Sensitive actions are recorded from the moment the trail is enabled —
            actions taken before then are not retroactively present.
          </p>
        )}

        {events.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Resource</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <Fragment key={e.id}>
                    <tr className={e.outcome === "denied" ? styles.rowDenied : undefined}>
                      <td className={styles.seq}>{e.seq}</td>
                      <td>{when(e.occurredAt)}</td>
                      <td>
                        <span className={styles.action}>{e.action}</span>
                        {e.outcome !== "allowed" && (
                          <span className={styles.outcome}>{e.outcome}</span>
                        )}
                      </td>
                      <td>
                        {e.actorLabel || "—"}
                        {e.actorType !== "user" && (
                          <span className={styles.actorType}>{e.actorType}</span>
                        )}
                      </td>
                      <td className={styles.resource}>
                        {e.resourceType}
                        {e.resourceId ? ` ${e.resourceId.slice(0, 8)}…` : ""}
                      </td>
                      <td>
                        <button
                          className={styles.link}
                          onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                        >
                          {expanded === e.id ? "hide" : "detail"}
                        </button>
                      </td>
                    </tr>
                    {expanded === e.id && (
                      <tr>
                        <td colSpan={6}>
                          <pre className={styles.pre}>
                            {JSON.stringify(e.metadata, null, 2)}
                            {`\nentry hash: ${e.entryHash}`}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
