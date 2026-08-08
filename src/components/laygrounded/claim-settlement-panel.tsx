"use client";

// Agreement and the settlement instruction it produces.
//
// This is the tail of a chain that previously had no UI at all: a claim could be
// agreed only by an API call, and the payload the agreement generated could be
// read only from the database. Both are money-moving artifacts, so both belong
// in front of the person responsible for them.
//
// Nothing here GENERATES a payload. Agreement emits `claim.settlement_ready` and
// the outbox consumer writes exactly one document per agreed calculation; a
// panel that generated on demand would mint a new one, with a new `issuedAt`,
// every time it was opened.

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Ban,
  Check,
  FileSignature,
  Handshake,
  Landmark,
  Link2,
  RefreshCw,
} from "lucide-react";
import { useCan } from "@/components/role-provider";
import styles from "./ClaimSettlementPanel.module.css";

interface Leg {
  currency: string;
  amount: number;
  direction: "collect" | "pay";
  debtor: { name: string; accountId?: string | null; bic?: string | null };
  creditor: { name: string; accountId?: string | null; bic?: string | null };
  components: string[];
}

interface Component {
  key: string;
  label: string;
  amount: number;
  currency: string;
  settles: boolean;
  exclusionReason: string | null;
}

interface SettlementView {
  settlementRef: string;
  digest: string;
  ready: boolean;
  blockers: string[];
  createdAt: string;
  memos: string[];
  legs: Leg[];
  components: Component[];
  missingForBank: string[];
  missingForChain: string[];
  hasEip712: boolean;
  hasIso20022: boolean;
}

interface State {
  engineVersion: 1 | 2;
  agreedAt: string | null;
  agreedCalculationId: string | null;
  eligibility: {
    eligible: boolean;
    failures: string[];
    criteria: Array<{ key: string; label: string; ok: boolean; detail?: string }>;
    amount: number | null;
    currency: string | null;
    direction: string | null;
  };
  settlement: SettlementView | null;
}

const money = (n: number, ccy: string) =>
  `${ccy} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ClaimSettlementPanel({
  claimId,
  onClaimChanged,
}: {
  claimId: string;
  onClaimChanged?: () => void;
}) {
  // Agreement fixes the figures and unblocks the payment instruction.
  const canAgree = useCan("claim.agree");
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [agreeing, setAgreeing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/claims/${claimId}/agree`).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setState(r);
      setError(null);
    } catch {
      setError("Could not load settlement state.");
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function agree() {
    if (
      !confirm(
        "Agreeing fixes these figures as final and generates a payment instruction. " +
          "The calculation is pinned at this moment — a later recompute will block settlement " +
          "rather than silently settling a different number. Continue?"
      )
    )
      return;
    setAgreeing(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/agree`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? json.error ?? "Could not agree this claim");
      await load();
      onClaimChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not agree this claim");
    } finally {
      setAgreeing(false);
    }
  }

  if (loading) return <p className={styles.loading}>Loading settlement state…</p>;
  if (!state) return <p className={styles.error}>{error ?? "Unavailable."}</p>;

  const { eligibility: el, settlement: s } = state;

  return (
    <div className={styles.wrap}>
      <div className={styles.headRow}>
        <h3 className={styles.title}>
          <Handshake size={15} /> Agreement &amp; settlement
        </h3>
        <span className={styles.engineChip} title="The laytime rule set that computed this claim.">
          engine v{state.engineVersion}
        </span>
      </div>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} /> {error}
        </p>
      )}

      {/* ── Agreement ─────────────────────────────────────────────────── */}
      {state.agreedAt ? (
        <p className={styles.agreed}>
          <Check size={14} /> Agreed {state.agreedAt.slice(0, 10)}
          {el.amount != null && el.currency && (
            <> · {money(el.amount, el.currency)} to {el.direction === "collect" ? "collect" : "pay"}</>
          )}
        </p>
      ) : (
        <>
          <p className={styles.intro}>
            Agreement is the moment the numbers stop being negotiable. It pins the calculation and
            generates the payment instruction, so it is gated on the same checks the clearinghouse
            uses rather than being a flag anyone can set.
          </p>
          <ul className={styles.criteria}>
            {el.criteria.map((c) => (
              <li key={c.key} className={c.ok ? styles.critOk : styles.critBad}>
                {c.ok ? <Check size={12} /> : <Ban size={12} />}
                <span>
                  {c.label}
                  {c.detail && <span className={styles.detail}> — {c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={styles.primary}
            disabled={!el.eligible || agreeing || !canAgree}
            onClick={() => void agree()}
            title={
              !canAgree
                ? "Agreeing a claim fixes its figures — it needs the Finance manager role."
                : el.eligible
                  ? undefined
                  : "Every criterion above must pass first."
            }
          >
            {agreeing ? "Agreeing…" : "Agree this claim"}
          </button>
          {/* Shown even when the criteria already pass: "you may not" and "not
              yet eligible" are different answers, and a single greyed button
              cannot say which one applies. */}
          {!canAgree && (
            <p className={styles.roleNote}>
              Agreeing fixes these figures and releases the payment instruction, so it needs the{" "}
              <strong>Finance manager</strong> role. Ask an admin on your{" "}
              <a href="/settings/team">team page</a>.
            </p>
          )}
        </>
      )}

      {/* ── The generated instruction ─────────────────────────────────── */}
      {state.agreedAt && !s && (
        <p className={styles.pending}>
          <RefreshCw size={13} /> Agreed. The payment instruction is generated by the settlement
          worker on its next sweep — reload shortly.
        </p>
      )}

      {s && (
        <div className={styles.payload}>
          <div className={styles.payloadHead}>
            <strong className="tnum">{s.settlementRef}</strong>
            <span className={s.ready ? styles.chipOk : styles.chipWarn}>
              {s.ready ? "ready" : "blocked"}
            </span>
            <span className={styles.rails}>
              {s.hasIso20022 && (
                <span className={styles.rail} title="ISO 20022 pacs.008 draft">
                  <Landmark size={12} /> bank
                </span>
              )}
              {s.hasEip712 && (
                <span className={styles.rail} title="EIP-712 typed data, ready for signature">
                  <Link2 size={12} /> chain
                </span>
              )}
            </span>
          </div>

          {s.legs.map((leg, i) => (
            <div key={i} className={styles.leg}>
              <div className={styles.legAmount}>
                {money(leg.amount, leg.currency)}
                <span className={styles.legDir}>{leg.direction}</span>
              </div>
              <div className={styles.legParties}>
                <span>
                  <em>from</em> {leg.debtor.name || "—"}{" "}
                  {leg.debtor.accountId ? (
                    <span className="tnum">{leg.debtor.accountId}</span>
                  ) : (
                    <span className={styles.missing}>no account</span>
                  )}
                </span>
                <span>
                  <em>to</em> {leg.creditor.name || "—"}{" "}
                  {leg.creditor.accountId ? (
                    <span className="tnum">{leg.creditor.accountId}</span>
                  ) : (
                    <span className={styles.missing}>no account</span>
                  )}
                </span>
              </div>
            </div>
          ))}

          {s.components.some((c) => !c.settles) && (
            <ul className={styles.excluded}>
              {s.components
                .filter((c) => !c.settles)
                .map((c) => (
                  <li key={c.key}>
                    <strong>{c.label}</strong> ({money(c.amount, c.currency)}) excluded —{" "}
                    {c.exclusionReason}
                  </li>
                ))}
            </ul>
          )}

          {s.blockers.length > 0 && (
            <ul className={styles.blockers}>
              {s.blockers.map((b) => (
                <li key={b}>
                  <AlertCircle size={12} /> {b}
                </li>
              ))}
            </ul>
          )}

          {(s.missingForBank.length > 0 || s.missingForChain.length > 0) && (
            <p className={styles.missingNote}>
              Missing{" "}
              {s.missingForBank.length > 0 && <>for the bank leg: {s.missingForBank.join(", ")}</>}
              {s.missingForBank.length > 0 && s.missingForChain.length > 0 && "; "}
              {s.missingForChain.length > 0 && <>for the chain leg: {s.missingForChain.join(", ")}</>}
              . Add these under <strong>Settings → Settlement &amp; Banking</strong>; they are
              reported rather than guessed.
            </p>
          )}

          {s.memos.map((m) => (
            <p key={m} className={styles.memo}>
              {m}
            </p>
          ))}

          <p className={styles.digest}>
            <FileSignature size={11} /> SHA-256 <span className="tnum">{s.digest.slice(0, 32)}…</span>
            <span className={styles.digestNote}>
              pins this document for audit. It is <strong>not</strong> the EIP-712 signing hash —
              the signer derives that.
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
