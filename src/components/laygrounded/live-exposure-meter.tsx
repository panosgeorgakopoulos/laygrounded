import Link from "next/link";
import { alertThresholds, type ExposureAlertLevel } from "@/lib/voyage/exposure";
import type { ClaimExposure } from "@/lib/voyage/exposure-server";
import styles from "./LiveExposureMeter.module.css";

function fmtMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtHours(h: number): string {
  return `${h.toLocaleString("en-US", { maximumFractionDigits: 1 })}h`;
}

/**
 * "in 14h" / "in 3d 2h". Deliberately relative: an absolute timestamp makes the
 * reader do the subtraction, and the whole point of this strip is that the
 * urgency should be legible without arithmetic.
 */
function untilLabel(fromIso: string, targetIso: string): string {
  const ms = new Date(targetIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const hours = ms / 3_600_000;
  if (hours < 24) return `in ${fmtHours(hours)}`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours - days * 24);
  return rem > 0 ? `in ${days}d ${rem}h` : `in ${days}d`;
}

const LEVEL_CLASS: Record<ExposureAlertLevel, string> = {
  on_demurrage: styles.onDemurrage,
  imminent: styles.imminent,
  approaching: styles.approaching,
  none: styles.calm,
};

function Row({ exposure }: { exposure: ClaimExposure }) {
  const { snapshot: s, alert } = exposure;
  const bands = alertThresholds(s.allowedHours);

  // The bar is capped at 100% width; the overflow is communicated by the
  // demurrage styling and the accrued figure rather than by a bar that runs off
  // the edge of its track.
  const fillPct = Math.min(100, s.percentConsumed);
  const onDemurrage = s.state === "demurrage_accruing";

  // Where the warning bands sit on this claim's own allowance, so the marks
  // line up with the point the alert actually fires.
  const approachingMark =
    s.allowedHours > 0 ? ((s.allowedHours - bands.approaching) / s.allowedHours) * 100 : 0;

  return (
    <li className={`${styles.row} ${LEVEL_CLASS[alert.level]}`}>
      <Link href={`/claims/${exposure.claimId}/workspace`} className={styles.rowLink}>
        <div className={styles.rowMain}>
          <div className={styles.rowHead}>
            <strong className={styles.vessel}>{exposure.vessel ?? "—"}</strong>
            {exposure.voyageRef && (
              <>
                <span className={styles.sep}>·</span>
                <span className="tnum">{exposure.voyageRef}</span>
              </>
            )}
            {exposure.port && (
              <>
                <span className={styles.sep}>·</span>
                <span>{exposure.port}</span>
              </>
            )}
          </div>

          <div className={styles.track} role="presentation">
            {approachingMark > 0 && approachingMark < 100 && (
              <span className={styles.mark} style={{ left: `${approachingMark}%` }} />
            )}
            <span className={styles.fill} style={{ width: `${fillPct}%` }} />
          </div>

          <p className={styles.meta}>
            <span className="tnum">{fmtHours(s.usedHours)}</span> of{" "}
            <span className="tnum">{fmtHours(s.allowedHours)}</span> used
            {!onDemurrage && s.laytimeExhaustedAt && (
              <>
                <span className={styles.sep}>·</span>
                laytime expires{" "}
                <strong>{untilLabel(s.asOf, s.laytimeExhaustedAt)}</strong>
              </>
            )}
            {onDemurrage && (
              <>
                <span className={styles.sep}>·</span>
                <span className="tnum">{fmtHours(s.onDemurrageHours)}</span> on demurrage
              </>
            )}
          </p>
        </div>

        <div className={styles.rowAmount}>
          {onDemurrage ? (
            <>
              <span className={`${styles.amount} tnum`}>
                {fmtMoney(s.accruedDemurrage, s.currency)}
              </span>
              <span className={styles.amountLabel}>accrued</span>
            </>
          ) : (
            <>
              <span className={`${styles.amount} tnum`}>{fmtHours(s.remainingHours)}</span>
              <span className={styles.amountLabel}>remaining</span>
            </>
          )}
        </div>
      </Link>
    </li>
  );
}

/**
 * Live demurrage meter for the console.
 *
 * Renders nothing when no voyage is live — an empty widget on an operational
 * surface is noise, and the console already tells the user when the book is
 * clear.
 */
export function LiveExposureMeter({ exposures }: { exposures: ClaimExposure[] }) {
  if (exposures.length === 0) return null;

  const onDemurrage = exposures.filter((e) => e.snapshot.state === "demurrage_accruing");
  const accrued = onDemurrage.reduce((sum, e) => sum + e.snapshot.accruedDemurrage, 0);
  // Mixed-currency books cannot be summed honestly; show the total only when
  // every accruing claim shares one currency, and say which it is.
  const currencies = new Set(onDemurrage.map((e) => e.snapshot.currency));
  const singleCurrency = currencies.size === 1 ? [...currencies][0] : null;

  return (
    <section className={styles.wrap} aria-label="Live demurrage meter">
      <header className={styles.head}>
        <h2 className={styles.title}>Live exposure</h2>
        <p className={styles.sub}>
          {exposures.length} voyage{exposures.length === 1 ? "" : "s"} in progress
          {onDemurrage.length > 0 && (
            <>
              {" · "}
              <strong className={styles.subAccrued}>
                {onDemurrage.length} on demurrage
                {singleCurrency && <> · {fmtMoney(accrued, singleCurrency)} accrued</>}
              </strong>
            </>
          )}
        </p>
      </header>
      <ol className={styles.list}>
        {exposures.map((e) => (
          <Row key={e.claimId} exposure={e} />
        ))}
      </ol>
      <p className={styles.footnote}>
        Computed from confirmed events through the same engine that prices the final claim.
        Figures move as events are confirmed.
      </p>
    </section>
  );
}
