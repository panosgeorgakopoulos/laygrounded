"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Link2, Unlink } from "lucide-react";
import type { VoyagePnlResult, PnlLine, LineKind } from "@/lib/pnl/voyage-pnl";
import styles from "./VoyagePnlSheet.module.css";

export interface LinkableClaim {
  id: string;
  vessel: string;
  voyageRef: string;
  port: string;
  demurrage: number | null;
  despatch: number | null;
  currency: string | null;
  hasCalculation: boolean;
}

type Status = "estimate" | "actual" | "closed";

const STATUSES: Array<{ value: Status; label: string; hint: string }> = [
  { value: "estimate", label: "Estimate", hint: "Pre-fixture — deciding whether to take the cargo" },
  { value: "actual", label: "Actual", hint: "Voyage performed; figures are real" },
  { value: "closed", label: "Closed", hint: "Accounts final" },
];

/** Section order on the sheet. Revenue first, then what comes off it. */
const SECTIONS: Array<{ kind: LineKind; title: string }> = [
  { kind: "revenue", title: "Revenue" },
  { kind: "deduction", title: "Deductions" },
  { kind: "expense", title: "Voyage expenses" },
  { kind: "transfer", title: "Settlements" },
];

function money(amount: number, currency: string, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = opts.sign && amount < 0 ? "−" : "";
  return `${sign}${currency} ${abs}`;
}

export function VoyagePnlSheet({
  pnlId,
  vessel,
  voyageRef,
  charterType,
  status: initialStatus,
  initialResult,
  initialClaimIds,
  linkableClaims,
}: {
  pnlId: string;
  vessel: string;
  voyageRef: string;
  charterType: string;
  status: string;
  initialResult: VoyagePnlResult;
  initialClaimIds: string[];
  linkableClaims: LinkableClaim[];
}) {
  const [result, setResult] = useState(initialResult);
  const [claimIds, setClaimIds] = useState<string[]>(initialClaimIds);
  const [status, setStatus] = useState<Status>(initialStatus as Status);
  /**
   * The last status the server confirmed — the point a failed write rolls back
   * to. Reverting to the `initialStatus` PROP instead would undo every earlier
   * successful change: move Estimate → Actual, then have an unrelated unlink
   * fail, and the chip would jump back to Estimate while the server still said
   * "actual". The sheet is money; the UI must never claim a state the server
   * does not hold, in either direction.
   */
  const [confirmedStatus, setConfirmedStatus] = useState<Status>(initialStatus as Status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>, optimistic?: () => void) {
    setBusy(true);
    setError(null);
    optimistic?.();
    try {
      const res = await fetch(`/api/voyage-pnl/${pnlId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Update failed");
      setResult(json.result);
      setClaimIds(json.claimIds);
      if (typeof body.status === "string") setConfirmedStatus(body.status as Status);
    } catch (e) {
      // A failed write must never leave a figure on screen that the server did
      // not agree to.
      setError(e instanceof Error ? e.message : "Update failed");
      setStatus(confirmedStatus);
    } finally {
      setBusy(false);
    }
  }

  const linked = linkableClaims.filter((c) => claimIds.includes(c.id));
  const unlinked = linkableClaims.filter((c) => !claimIds.includes(c.id));
  const ccy = result.currency;

  return (
    <div>
      <header className={styles.pageHead}>
        <Link href="/voyages" className={styles.back}>
          ← All voyages
        </Link>
        <h1 className={styles.pageTitle}>
          {vessel} <span className={styles.voyageRef}>{voyageRef}</span>
        </h1>
        <p className={styles.pageSub}>
          {charterType === "time" ? "Time charter" : "Voyage charter"}
        </p>
      </header>

      {/* Lifecycle */}
      <section className={styles.lifecycle} aria-label="Voyage lifecycle">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            disabled={busy}
            title={s.hint}
            aria-pressed={status === s.value}
            className={`${styles.stage} ${status === s.value ? styles.stageActive : ""}`}
            onClick={() => {
              if (s.value === status) return;
              patch({ status: s.value }, () => setStatus(s.value));
            }}
          >
            <span className={styles.stageLabel}>{s.label}</span>
            <span className={styles.stageHint}>{s.hint}</span>
          </button>
        ))}
      </section>

      {error && <p className={styles.error}>{error}</p>}

      {/* TCE — the number the market compares on */}
      <section className={styles.hero}>
        <div className={styles.heroMain}>
          <span className={styles.heroLabel}>Time charter equivalent</span>
          <span className={`${styles.heroValue} tnum`}>
            {result.tcePerDay === null ? "—" : money(result.tcePerDay, ccy)}
          </span>
          <span className={styles.heroUnit}>
            {result.tcePerDay === null
              ? "Needs voyage start and end dates"
              : `per day over ${result.voyageDays} days`}
          </span>
        </div>
        <div className={styles.heroNet}>
          <span className={styles.heroLabel}>Net result</span>
          <span
            className={`${styles.heroValue} tnum ${result.netResult < 0 ? styles.negative : ""}`}
          >
            {money(result.netResult, ccy, { sign: true })}
          </span>
        </div>
      </section>

      {/* Breakdown */}
      <section className={styles.totals} aria-label="Breakdown">
        <div className={styles.total}>
          <span className={styles.totalLabel}>Gross revenue</span>
          <span className={`${styles.totalValue} tnum`}>{money(result.grossRevenue, ccy)}</span>
        </div>
        <div className={styles.total}>
          <span className={styles.totalLabel}>Deductions</span>
          <span className={`${styles.totalValue} tnum ${styles.negative}`}>
            −{money(result.revenueDeductions, ccy)}
          </span>
        </div>
        <div className={styles.total}>
          <span className={styles.totalLabel}>Voyage expenses</span>
          <span className={`${styles.totalValue} tnum ${styles.negative}`}>
            −{money(result.voyageExpenses, ccy)}
          </span>
        </div>
        {result.transfers !== 0 && (
          <div className={styles.total}>
            <span className={styles.totalLabel}>
              Settlements
              <span className={styles.totalNote}>excluded from TCE</span>
            </span>
            <span className={`${styles.totalValue} tnum`}>
              {money(result.transfers, ccy, { sign: true })}
            </span>
          </div>
        )}
      </section>

      {result.warnings.length > 0 && (
        <section className={styles.warnings} aria-label="Warnings">
          <div className={styles.warningHead}>
            <AlertTriangle size={15} />
            <strong>This sheet is incomplete</strong>
          </div>
          <ul className={styles.warningList}>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Lines */}
      <section className={styles.lines} aria-label="P&L lines">
        {SECTIONS.map((section) => {
          const rows = result.lines.filter((l: PnlLine) => l.kind === section.kind);
          if (rows.length === 0) return null;
          return (
            <div key={section.kind} className={styles.lineGroup}>
              <h2 className={styles.lineGroupTitle}>{section.title}</h2>
              <ul className={styles.lineList}>
                {rows.map((l) => (
                  <li key={l.key} className={`${styles.line} ${l.excluded ? styles.lineExcluded : ""}`}>
                    <div className={styles.lineMain}>
                      <span className={styles.lineLabel}>{l.label}</span>
                      {l.source === "laytime_engine" && (
                        <span className={styles.engineTag}>from laytime engine</span>
                      )}
                      {l.note && <span className={styles.lineNote}>{l.note}</span>}
                      {l.excluded && (
                        <span className={styles.excludedNote}>
                          In {l.currency}, not {ccy} — excluded from all totals.
                        </span>
                      )}
                    </div>
                    <span
                      className={`${styles.lineAmount} tnum ${l.amount < 0 ? styles.negative : ""}`}
                    >
                      {money(l.amount, l.currency, { sign: true })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      {/* Port calls */}
      <section className={styles.claims} aria-label="Linked port calls">
        <h2 className={styles.claimsTitle}>Port calls on this voyage</h2>
        <p className={styles.claimsSub}>
          Each linked claim contributes its demurrage and despatch, straight from the
          laytime engine. Unlinking removes it from this sheet only — the claim and its
          calculation are untouched.
        </p>

        {linked.length === 0 ? (
          <p className={styles.claimsEmpty}>No port calls linked yet.</p>
        ) : (
          <ul className={styles.claimList}>
            {linked.map((c) => (
              <li key={c.id} className={styles.claimRow}>
                <div className={styles.claimMain}>
                  <strong>{c.vessel}</strong>
                  <span className={styles.sep}>·</span>
                  <span className="tnum">{c.voyageRef}</span>
                  <span className={styles.sep}>·</span>
                  <span>{c.port}</span>
                  {!c.hasCalculation && (
                    <span className={styles.noCalc}>no calculation yet</span>
                  )}
                </div>
                <div className={styles.claimActions}>
                  {c.hasCalculation && (
                    <span className={`${styles.claimFigure} tnum`}>
                      {c.demurrage ? money(c.demurrage, c.currency ?? ccy) : null}
                      {c.despatch ? `−${money(c.despatch, c.currency ?? ccy)}` : null}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    className={styles.unlinkBtn}
                    // Named, because a list of buttons all announcing "Unlink"
                    // tells a screen-reader user nothing about which call.
                    aria-label={`Unlink ${c.vessel} ${c.voyageRef} at ${c.port} from this voyage`}
                    onClick={() => patch({ removeClaimIds: [c.id] })}
                  >
                    <Unlink size={13} /> Unlink
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {unlinked.length > 0 && (
          <>
            <h3 className={styles.addTitle}>Add a port call</h3>
            <ul className={styles.claimList}>
              {unlinked.map((c) => (
                <li key={c.id} className={styles.claimRow}>
                  <div className={styles.claimMain}>
                    <strong>{c.vessel}</strong>
                    <span className={styles.sep}>·</span>
                    <span className="tnum">{c.voyageRef}</span>
                    <span className={styles.sep}>·</span>
                    <span>{c.port}</span>
                    {!c.hasCalculation && (
                      <span className={styles.noCalc}>no calculation yet</span>
                    )}
                  </div>
                  <div className={styles.claimActions}>
                    {c.hasCalculation && (
                      <span className={`${styles.claimFigure} tnum`}>
                        {c.demurrage ? money(c.demurrage, c.currency ?? ccy) : null}
                        {c.despatch ? `−${money(c.despatch, c.currency ?? ccy)}` : null}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      className={styles.linkBtn}
                      aria-label={`Link ${c.vessel} ${c.voyageRef} at ${c.port} to this voyage`}
                      onClick={() => patch({ addClaimIds: [c.id] })}
                    >
                      <Link2 size={13} /> Link
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
