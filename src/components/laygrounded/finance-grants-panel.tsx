"use client";

// Bank access to this claim.
//
// This is the other half of the audit room. That panel shows what a
// counterparty would be handed; this issues the credential that lets them
// fetch it — scoped to ONE claim, expiring, revocable, and metered.
//
// THE TOKEN IS SHOWN ONCE. Only its hash is stored, so a lost token is
// replaced by issuing a new one and revoking the old — never recovered. The UI
// makes that a deliberate copy step rather than a line of text somebody
// scrolls past, because the alternative is a support request that cannot be
// satisfied.
//
// Every refusal on the redemption side returns the same opaque 404, so a
// probing holder cannot tell "revoked" from "expired" from "wrong claim". The
// consequence for this UI is that revocation is genuinely final from the
// holder's point of view, which is worth saying out loud before somebody
// clicks it.

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Ban,
  Check,
  Clock,
  Copy,
  Eye,
  KeyRound,
  Landmark,
  Loader2,
} from "lucide-react";
import styles from "./FinanceGrantsPanel.module.css";

interface Grant {
  id: string;
  institutionLabel: string;
  purpose: "factoring" | "audit" | "due_diligence";
  tokenPrefix: string;
  expiresAt: string;
  maxAccessCount: number | null;
  accessCount: number;
  lastAccessedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
}

const PURPOSES = [
  { key: "factoring", label: "Factoring", hint: "A lender advancing against this receivable" },
  { key: "audit", label: "Audit", hint: "An auditor checking the figures" },
  { key: "due_diligence", label: "Due diligence", hint: "A counterparty verifying before agreeing" },
] as const;

function day(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** A grant's live state, derived rather than stored — the same discipline as the negotiation phase. */
function status(g: Grant): { label: string; cls: string } {
  if (g.revokedAt) return { label: "revoked", cls: styles.revoked };
  if (Date.parse(g.expiresAt) < Date.now()) return { label: "expired", cls: styles.expired };
  if (g.maxAccessCount != null && g.accessCount >= g.maxAccessCount) {
    return { label: "exhausted", cls: styles.expired };
  }
  return { label: "live", cls: styles.live };
}

export function FinanceGrantsPanel({ claimId }: { claimId: string }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState<Grant["purpose"]>("factoring");
  const [expiryDays, setExpiryDays] = useState(30);
  const [limitReads, setLimitReads] = useState(false);
  const [maxReads, setMaxReads] = useState(5);

  const [issued, setIssued] = useState<{ token: string; notice: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/claims/${claimId}/finance-grants`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setGrants(d.grants ?? []);
      setError(null);
    } catch {
      setError("Could not load the access grants for this claim.");
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function issue() {
    if (!label.trim()) return;
    setBusy("issue");
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/finance-grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          institutionLabel: label.trim(),
          purpose,
          expiryDays,
          maxAccessCount: limitReads ? maxReads : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail ?? json.error ?? "Could not issue the grant");
      setIssued({ token: json.token, notice: json.tokenNotice });
      setCopied(false);
      setLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not issue the grant");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string, institution: string) {
    const reason = prompt(
      `Revoke access for ${institution}? They will stop being able to fetch this claim immediately, and the refusal is indistinguishable from "no such token" on their side.\n\nReason (recorded):`
    );
    if (reason === null) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/finance-grants/${id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || "revoked by the issuing tenant" }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail ?? j.error ?? "Could not revoke the grant");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke the grant");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className={styles.wrap}>
        <p className={styles.loading}>
          <Loader2 size={13} className={styles.spin} /> Loading access grants…
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h3 className={styles.title}>
          <Landmark size={15} /> Bank &amp; auditor access
        </h3>
        {grants.some((g) => status(g).label === "live") && (
          <span className={styles.liveCount}>
            {grants.filter((g) => status(g).label === "live").length} live
          </span>
        )}
      </header>

      <p className={styles.intro}>
        Issue a token that lets a lender or auditor fetch this claim&apos;s verification package —
        the facts, the figures, and the engine fingerprint — and check the arithmetic themselves
        offline. A grant opens <strong>this claim and nothing else</strong>, expires, and can be
        revoked at any time.
      </p>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {issued && (
        <div className={styles.tokenBox}>
          <div className={styles.tokenHead}>
            <KeyRound size={14} />
            <strong>Access token — shown once</strong>
          </div>
          <code className={styles.token}>{issued.token}</code>
          <button
            type="button"
            className={styles.copy}
            onClick={() => {
              void navigator.clipboard.writeText(issued.token);
              setCopied(true);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy token"}
          </button>
          <p className={styles.tokenNotice}>{issued.notice}</p>
          <button type="button" className={styles.dismiss} onClick={() => setIssued(null)}>
            I have copied it
          </button>
        </div>
      )}

      {/* ── Issue ────────────────────────────────────────────────────── */}
      <div className={styles.form}>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span className={styles.label}>Institution</span>
            <input
              className={styles.input}
              value={label}
              placeholder="e.g. Nordea Trade Finance"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Purpose</span>
            <select
              className={styles.input}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as Grant["purpose"])}
            >
              {PURPOSES.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className={styles.hint}>
              {PURPOSES.find((p) => p.key === purpose)?.hint}
            </span>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Expires in</span>
            <div className={styles.inline}>
              <input
                type="number"
                className={styles.narrow}
                min={1}
                max={365}
                value={expiryDays}
                onChange={(e) =>
                  setExpiryDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))
                }
              />
              <span className={styles.unit}>days</span>
            </div>
          </label>
        </div>

        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={limitReads}
            onChange={(e) => setLimitReads(e.target.checked)}
          />
          <span>
            Burn after a fixed number of reads
            <span className={styles.hint}>
              {" "}
              — a lender usually needs one or two; unlimited until expiry otherwise
            </span>
          </span>
          {limitReads && (
            <input
              type="number"
              className={styles.narrow}
              min={1}
              max={1000}
              value={maxReads}
              onChange={(e) => setMaxReads(Math.max(1, Number(e.target.value) || 1))}
            />
          )}
        </label>

        <button
          type="button"
          className={styles.primary}
          disabled={!label.trim() || busy === "issue"}
          onClick={() => void issue()}
        >
          {busy === "issue" ? <Loader2 size={13} className={styles.spin} /> : <KeyRound size={13} />}{" "}
          Issue access token
        </button>
      </div>

      {/* ── Existing grants ──────────────────────────────────────────── */}
      {grants.length > 0 && (
        <ul className={styles.list}>
          {grants.map((g) => {
            const s = status(g);
            return (
              <li key={g.id} className={styles.grant}>
                <div className={styles.gMain}>
                  <div className={styles.gHead}>
                    <strong>{g.institutionLabel}</strong>
                    <span className={`${styles.status} ${s.cls}`}>{s.label}</span>
                    <span className={styles.purpose}>
                      {PURPOSES.find((p) => p.key === g.purpose)?.label ?? g.purpose}
                    </span>
                  </div>
                  <div className={styles.gMeta}>
                    <span className="tnum">{g.tokenPrefix}…</span>
                    <span>
                      <Clock size={11} /> expires {day(g.expiresAt)}
                    </span>
                    <span>
                      <Eye size={11} /> {g.accessCount}
                      {g.maxAccessCount != null ? ` / ${g.maxAccessCount}` : ""} read
                      {g.accessCount === 1 ? "" : "s"}
                      {g.lastAccessedAt && ` · last ${day(g.lastAccessedAt)}`}
                    </span>
                  </div>
                  {g.revokedAt && (
                    <p className={styles.revokeNote}>
                      Revoked {day(g.revokedAt)}
                      {g.revokeReason ? ` — ${g.revokeReason}` : ""}
                    </p>
                  )}
                  {!g.revokedAt && g.accessCount === 0 && (
                    <p className={styles.unread}>
                      Never redeemed. If the institution says they cannot access it, the token was
                      most likely never delivered — issue a new one rather than resending this,
                      which cannot be shown again.
                    </p>
                  )}
                </div>
                {!g.revokedAt && (
                  <button
                    type="button"
                    className={styles.revokeBtn}
                    disabled={busy === g.id}
                    onClick={() => void revoke(g.id, g.institutionLabel)}
                  >
                    <Ban size={13} /> Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {grants.length === 0 && (
        <p className={styles.empty}>
          No access has been granted for this claim. Nobody outside your company can fetch it.
        </p>
      )}
    </div>
  );
}
